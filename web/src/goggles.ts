// Raw-WebUSB adb-enable for DJI Goggles 3. The device first needs a handshake
// (confirm it's awake, read until `</dji>`), then a cmd_id scan (WMS cmd_set
// 0x07, cmd_id 0x60–0x6F) on the confirmed pipe until it disconnects (= USB
// reconfiguring to ADB). The scan is load-bearing: the exact enable cmd_id is
// not statically isolable and varies across firmware (0x64 on fw 01.00.1600,
// where 0x65 does nothing), so we send the candidates and log the winner.
//
// getEnablePlan() computes the packet plan in the browser via the Rust core
// (WASM) — no server, no key. The client only sends/reads/detects.

export const DUML_VID = 0x2ca3;

export interface DeviceInfo {
  vendorId: number;
  productId: number;
  productName: string;
  // true when ADB was already enabled (no enable sent) — the caller can connect
  // straight away instead of asking the user to click Connect.
  alreadyEnabled?: boolean;
}

// DJI Goggles 3 (E3T zv902) USB product ID. The gadget keeps the same PID in
// both DUML and ADB modes (0x0020) — the modes differ by interface class, not
// PID — so a lone PID check can't tell them apart, only identify the model.
const KNOWN_G3_PIDS = new Set([0x0020]);
const G3_NAME_PATTERN = /goggles\s*3|zv902|e3t/i;

export function isKnownDevice(d: DeviceInfo): boolean {
  return KNOWN_G3_PIDS.has(d.productId) || G3_NAME_PATTERN.test(d.productName);
}

interface DumlPort {
  iface: number;
  ep_out: number;
  ep_in: number;
}

interface EnablePlan {
  handshake: Uint8Array<ArrayBuffer>[];
  init_count: number;
  // Primary adb-enable packet: cmd_id 0x64, empirically confirmed on fw
  // 01.00.1600. Sent first (one packet, long wait); the scan is the fallback.
  enable: Uint8Array<ArrayBuffer>;
  // WMS adb-enable candidates (cmd_set 0x07, cmd_id 0x60–0x6F). Fallback scan for
  // firmwares where the enable cmd_id differs; the cmd_id is not statically
  // isolable, so the winner is logged at runtime.
  candidates: Uint8Array<ArrayBuffer>[];
  expect: string;
  ports: DumlPort[];
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const buf = new ArrayBuffer(hex.length / 2);
  const out = new Uint8Array(buf);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

async function getEnablePlan(): Promise<EnablePlan> {
  // The plan is computed locally in the browser via the Rust core (WASM).
  // Dynamic import keeps WASM lazy (loaded on first enable).
  const { enablePlan } = await import("./wasm");
  const json = await enablePlan();
  const p = JSON.parse(json) as {
    handshake: string[];
    init_count: number;
    enable: string;
    candidates: string[];
    expect: string;
    ports: { iface: number; ep_out: number; ep_in: number }[];
  };
  return {
    handshake: p.handshake.map(hexToBytes),
    init_count: p.init_count,
    enable: hexToBytes(p.enable),
    candidates: p.candidates.map(hexToBytes),
    expect: p.expect,
    ports: p.ports,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Prompt for the goggles (DUML mode) and run the full enable sequence.
// Returns info about the USB device so the caller can check if it's a known model.
export async function enableAdb(log: (s: string) => void): Promise<DeviceInfo> {
  if (!navigator.usb) throw new Error("WebUSB not available in this browser");
  const plan = await getEnablePlan();

  const device = await navigator.usb.requestDevice({ filters: [{ vendorId: DUML_VID }] });
  const info: DeviceInfo = {
    vendorId: device.vendorId,
    productId: device.productId,
    productName: device.productName ?? "",
  };
  log(`opening ${device.productName ?? "goggles"}…`);
  await device.open();
  if (device.configuration === null) await device.selectConfiguration(1);

  // Already rooted: the device exposes the Android ADB interface. Skip enable —
  // the user just needs to Connect.
  if (adbAlreadyEnabled(device)) {
    log("ADB is already enabled — connecting…");
    try { await device.close(); } catch { /* ignore */ }
    return { ...info, alreadyEnabled: true };
  }

  // 8-interface DUML mode: the data pipe is a specific interface, and which one
  // carries DUML differs across firmware builds. Resolve each plan port to the
  // interface that actually exposes its endpoints, keep all candidate pipes, and
  // let the handshake pick the live one — claiming the wrong interface (writes
  // land nowhere, reads stay silent) is how enable breaks on a native client.
  const pipes = resolvePipes(device, plan.ports);
  if (!pipes.length) throw new Error("no DUML interface found — firmware USB layout unknown");

  // The pipe whose handshake returns </dji> is the live DUML interface. Collect
  // diagnostics along the way so a failure can say *why*, not just "no </dji>".
  let live: Pipe | undefined;
  let anyData = false;
  let version: string | undefined;
  for (const pipe of pipes) {
    try {
      await device.claimInterface(pipe.iface);
    } catch {
      continue;
    }
    log("handshake…");
    const blob = await probeHandshake(device, pipe, plan);
    if (blob.length) anyData = true;
    debugDumpBlob(pipe.iface, blob);
    if (!version) version = parseDjiVersion(blob);
    if (blob.includes(plan.expect)) {
      log(`handshake ok (iface ${pipe.iface})`);
      if (version) log(`device: ${version}`);
      live = pipe;
      break;
    }
    log(`iface ${pipe.iface}: no </dji>`);
    try { await device.releaseInterface(pipe.iface); } catch { /* ignore */ }
  }

  // No blind pass: only the live DUML pipe gets the scan. A device that never
  // answered DUML gets a precise diagnosis, not unknown commands fired at it.
  let disconnected = false;
  if (live) {
    // Primary: one packet (cmd_id 0x64), long wait for re-enumeration.
    const cid = "0x" + plan.enable[10].toString(16).padStart(2, "0");
    log(`enabling adb (cmd_id ${cid})…`);
    disconnected = await probeSingle(device, live, plan.enable, 5000, log);
    if (!disconnected) {
      log(`cmd_id ${cid} did not switch — scanning 0x60–0x6F…`);
      disconnected = await probeScan(device, live, plan, log);
    }
  }

  try {
    await device.close();
  } catch {
    /* device re-enumerates after enable; close may throw — ignore */
  }

  if (disconnected) {
    log("adb enabling — goggles re-enumerate in ~5s. Then click Connect.");
  } else if (live) {
    throw new Error("scan exhausted on the DUML interface — no cmd_id triggered a disconnect");
  } else {
    throw new Error(diagnose(device, plan, anyData, version));
  }
  return info;
}

// Turn a failed handshake into a precise message: separate "wrong/old device"
// from "wrong pipe" from "silent", using the descriptors and the bytes seen.
function diagnose(device: USBDevice, plan: EnablePlan, anyData: boolean, version?: string): string {
  if (adbAlreadyEnabled(device)) return "ADB already enabled — just connect";
  if (!dumlEpsFound(device, plan.ports)) {
    return `no DUML data interface (expected the plan's bulk endpoints): [${interfaceSummary(device)}]. ` +
      `Not a Goggles 3 in DUML mode — older goggles (G2/ZV900) or a non-DUML USB mode ` +
      `do not expose the adb-enable handler.`;
  }
  if (version) {
    return `DUML interface answered (device: ${version}) but never returned </dji> — ` +
      `adb-enable (WMS cmd_set 0x07) may be unsupported on this firmware. [${interfaceSummary(device)}]`;
  }
  if (anyData) {
    return `DUML interface returned data but no </dji> — wrong pipe or timing. [${interfaceSummary(device)}]`;
  }
  return `goggles silent on every DUML pipe. Check the cable and that the goggles are in ` +
    `DUML (pre-ADB) mode. [${interfaceSummary(device)}]`;
}

// Human-readable interface/endpoint layout, for diagnostics.
function interfaceSummary(device: USBDevice): string {
  const cfg = device.configuration;
  if (!cfg) return "no configuration";
  const hx = (n: number) => "0x" + n.toString(16).padStart(2, "0");
  const parts: string[] = [];
  for (const intf of cfg.interfaces) {
    for (const alt of intf.alternates) {
      const eps = alt.endpoints.map((e) => `${e.direction}${e.endpointNumber}`).join(",");
      parts.push(
        `iface ${intf.interfaceNumber} ${hx(alt.interfaceClass)}/${hx(alt.interfaceSubclass)}/${hx(alt.interfaceProtocol)} eps=[${eps}]`,
      );
    }
  }
  return parts.join("; ");
}

// True when the device actually exposes a plan DUML data interface (matching
// bulk endpoints) — a Goggles 3 in DUML mode does; other devices do not.
function dumlEpsFound(device: USBDevice, ports: DumlPort[]): boolean {
  const cfg = device.configuration;
  if (!cfg) return false;
  for (const p of ports) {
    for (const intf of cfg.interfaces) {
      for (const alt of intf.alternates) {
        const outs = new Set(alt.endpoints.filter((e) => e.direction === "out").map((e) => e.endpointNumber));
        const ins = new Set(alt.endpoints.filter((e) => e.direction === "in").map((e) => e.endpointNumber));
        if (outs.has(p.ep_out) && ins.has(p.ep_in)) return true;
      }
    }
  }
  return false;
}

// Concatenate the DUML frame payloads in `blob` (a latin1 string, 1 char/byte),
// dropping each frame's 0x55 header + CRC16, so the framing bytes that splice
// into a fragmented </dji> XML response are removed. Non-printable → space.
function reassembleDuml(blob: string): string {
  let out = "";
  let i = 0;
  while (i + 4 <= blob.length) {
    if (blob.charCodeAt(i) !== 0x55) { i++; continue; }
    const len = blob.charCodeAt(i + 1) | ((blob.charCodeAt(i + 2) & 0x03) << 8);
    if (len < 6 || i + len > blob.length) { i++; continue; }
    for (let j = i + 4; j < i + len - 2; j++) {
      const c = blob.charCodeAt(j);
      out += c >= 0x20 && c < 0x7f ? blob[j] : " ";
    }
    i += len;
  }
  return out;
}

// Extract an XML attribute value: text after `key` (e.g. `id="`) up to the next
// quote. Returns undefined if absent or empty.
function attr(s: string, key: string): string | undefined {
  const i = s.indexOf(key);
  if (i < 0) return undefined;
  const rest = s.slice(i + key.length);
  const end = rest.indexOf('"');
  if (end < 0) return undefined;
  const v = rest.slice(0, end).trim();
  return v || undefined;
}

// Dump the raw handshake blob (hex) + reassembled text to the console when
// `localStorage.toolya_usb_debug` is set. Mirrors the CLI's TOOLYA_USB_DEBUG.
function debugDumpBlob(iface: number, blob: string): void {
  if (!blob.length) return;
  let on = false;
  try { on = !!localStorage.getItem("toolya_usb_debug"); } catch { /* ignore */ }
  if (!on) return;
  const n = Math.min(blob.length, 512);
  let hex = "";
  for (let i = 0; i < n; i++) hex += blob.charCodeAt(i).toString(16).padStart(2, "0");
  console.debug(`[usb] iface ${iface} blob (${blob.length} B, first ${n}): ${hex}`);
  console.debug(`[usb] iface ${iface} reassembled: ${reassembleDuml(blob).trim()}`);
}

// Clean device/version string from a DUML </dji> response, for diagnostics. The
// XML is fragmented across DUML frames, so reassemble first, then pull the id +
// firmware attributes. `blob` is a latin1 string (see probeHandshake).
function parseDjiVersion(blob: string): string | undefined {
  for (const src of [reassembleDuml(blob), blob]) {
    const dev = attr(src, 'id="');
    const fw = attr(src, 'formal="') ?? attr(src, 'version="');
    if (dev || fw) return dev && fw ? `${dev} fw ${fw}` : dev ?? `fw ${fw}`;
  }
  return undefined;
}

type Pipe = { iface: number; ep_out: number; ep_in: number };

// ADB enabled = the Android ADB interface is present (vendor-specific class
// 0xff / subclass 0x42 / protocol 0x01). DUML mode has only CDC interfaces.
function adbAlreadyEnabled(device: USBDevice): boolean {
  const cfg = device.configuration;
  if (!cfg) return false;
  for (const intf of cfg.interfaces) {
    for (const alt of intf.alternates) {
      if (alt.interfaceClass === 0xff && alt.interfaceSubclass === 0x42 && alt.interfaceProtocol === 0x01) {
        return true;
      }
    }
  }
  return false;
}

// Map each plan port to the interface that actually exposes its endpoints,
// deduped by interface. Falls back to the port's nominal interface number.
function resolvePipes(device: USBDevice, ports: DumlPort[]): Pipe[] {
  const pipes: Pipe[] = [];
  const cfg = device.configuration;
  for (const p of ports) {
    let iface: number | undefined;
    if (cfg) {
      outer: for (const intf of cfg.interfaces) {
        for (const alt of intf.alternates) {
          const outs = new Set(alt.endpoints.filter((e) => e.direction === "out").map((e) => e.endpointNumber));
          const ins = new Set(alt.endpoints.filter((e) => e.direction === "in").map((e) => e.endpointNumber));
          if (outs.has(p.ep_out) && ins.has(p.ep_in)) {
            iface = intf.interfaceNumber;
            break outer;
          }
        }
      }
    }
    const resolved = iface ?? p.iface;
    if (!pipes.some((q) => q.iface === resolved)) {
      pipes.push({ iface: resolved, ep_out: p.ep_out, ep_in: p.ep_in });
    }
  }
  return pipes;
}

// Send the handshake on this pipe; resolve with every byte read back as a latin1
// string (1 char per byte, so charCodeAt recovers the raw bytes for DUML frame
// reassembly). Stops early once </dji> appears.
async function probeHandshake(device: USBDevice, pipe: Pipe, plan: EnablePlan): Promise<string> {
  const dec = new TextDecoder("latin1");
  let blob = "";
  let done = false;
  let reading = true;
  const reader = (async () => {
    while (reading) {
      try {
        const r = await device.transferIn(pipe.ep_in, 1024);
        if (r.data && r.data.byteLength) {
          blob += dec.decode(new Uint8Array(r.data.buffer), { stream: true });
          if (blob.includes(plan.expect)) {
            done = true;
            reading = false;
          }
        }
      } catch {
        break;
      }
    }
  })();
  for (let i = 0; i < plan.handshake.length && !done; i++) {
    try {
      await device.transferOut(pipe.ep_out, plan.handshake[i]);
    } catch {
      break;
    }
    await sleep(i < plan.init_count ? 50 : 60);
  }
  for (let i = 0; i < 20 && !done; i++) await sleep(50);
  reading = false;
  void reader;
  return blob;
}

// Send one enable packet and wait up to waitMs for the device to re-enumerate.
// Resolve true on disconnect (enable took), logging the cmd_id. An ACK/silence
// just means "still here" — keep waiting until the deadline.
async function probeSingle(
  device: USBDevice,
  pipe: Pipe,
  pkt: Uint8Array<ArrayBuffer>,
  waitMs: number,
  log: (s: string) => void,
): Promise<boolean> {
  await sleep(200);
  let disconnected = false;
  const onDisc = (e: USBConnectionEvent) => {
    if (e.device === device) disconnected = true;
  };
  navigator.usb.addEventListener("disconnect", onDisc);
  const cid = pkt[10];
  try {
    try {
      await device.transferOut(pipe.ep_out, pkt);
    } catch {
      disconnected = true; // write failed = device gone = success
    }
    const deadline = Date.now() + waitMs;
    while (!disconnected && Date.now() < deadline) await sleep(100);
  } finally {
    navigator.usb.removeEventListener("disconnect", onDisc);
  }
  if (disconnected) log(`adb enabled by cmd_id 0x${cid.toString(16).padStart(2, "0")}`);
  return disconnected;
}

// Fallback cmd_id scan (0x60–0x6F) for firmwares where the primary differs;
// resolve true when the device re-enumerates, logging which candidate did it.
async function probeScan(device: USBDevice, pipe: Pipe, plan: EnablePlan, log: (s: string) => void): Promise<boolean> {
  await sleep(200);
  let disconnected = false;
  const onDisc = (e: USBConnectionEvent) => {
    if (e.device === device) disconnected = true;
  };
  navigator.usb.addEventListener("disconnect", onDisc);
  try {
    for (const cand of plan.candidates) {
      // cmd_id is byte 10 of the framed packet. Attribute the disconnect to the
      // candidate that caused it, so the real enable trigger is logged.
      const cid = cand[10];
      try {
        await device.transferOut(pipe.ep_out, cand);
      } catch {
        disconnected = true; // write failed = device gone = success
        log(`adb enabled by cmd_id 0x${cid.toString(16).padStart(2, "0")}`);
        break;
      }
      await sleep(200);
      if (disconnected) {
        log(`adb enabled by cmd_id 0x${cid.toString(16).padStart(2, "0")}`);
        break;
      }
    }
  } finally {
    navigator.usb.removeEventListener("disconnect", onDisc);
  }
  return disconnected;
}
