// Raw-WebUSB adb-enable for DJI Goggles 3. This is NOT a single packet: the
// device needs a handshake (confirm it's awake, read until `</dji>`), then a
// cmd_id scan — the enable cmd_id shifts between boots, so we send candidates
// until the device disconnects (= USB reconfiguring to ADB).
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

// Known DJI Goggles 3 (E3T zv902) USB product IDs in DUML mode.
// If the device's PID isn't in this set, it's untested.
const KNOWN_G3_PIDS = new Set([0x001e]);
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
    candidates: string[];
    expect: string;
    ports: { iface: number; ep_out: number; ep_in: number }[];
  };
  return {
    handshake: p.handshake.map(hexToBytes),
    init_count: p.init_count,
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
  // interface that actually exposes its endpoints, keep all candidates, and let
  // the handshake pick the live one — claiming the wrong interface (writes land
  // nowhere, reads stay silent) is how enable breaks on a native client.
  const pipes = resolvePipes(device, plan.ports);
  if (!pipes.length) throw new Error("no DUML interface found — firmware USB layout unknown");

  // Pass 1: the pipe whose handshake returns </dji> is the live DUML interface.
  let live: Pipe | undefined;
  for (const pipe of pipes) {
    try {
      await device.claimInterface(pipe.iface);
    } catch {
      continue;
    }
    log("handshake…");
    if (await probeHandshake(device, pipe, plan)) {
      log(`handshake ok (iface ${pipe.iface})`);
      live = pipe;
      break;
    }
    log(`iface ${pipe.iface}: no </dji>`);
    try { await device.releaseInterface(pipe.iface); } catch { /* ignore */ }
  }

  let disconnected = false;
  if (live) {
    log("enabling adb (scanning)…");
    disconnected = await probeScan(device, live, plan);
  } else {
    // Pass 2: no handshake anywhere — try enabling blind on each pipe.
    for (const pipe of pipes) {
      try {
        await device.claimInterface(pipe.iface);
      } catch {
        continue;
      }
      log(`enabling adb (scanning iface ${pipe.iface})…`);
      if (await probeScan(device, pipe, plan)) {
        disconnected = true;
        break;
      }
      try { await device.releaseInterface(pipe.iface); } catch { /* ignore */ }
    }
  }

  try {
    await device.close();
  } catch {
    /* device re-enumerates after enable; close may throw — ignore */
  }

  if (disconnected) {
    log("adb enabling — goggles re-enumerate in ~5s. Then click Connect.");
  } else {
    throw new Error("no </dji> on any DUML interface — goggles not answering DUML");
  }
  return info;
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

// Send the handshake on this pipe; resolve true if </dji> comes back.
async function probeHandshake(device: USBDevice, pipe: Pipe, plan: EnablePlan): Promise<boolean> {
  const dec = new TextDecoder();
  let blob = "";
  let got = false;
  let reading = true;
  const reader = (async () => {
    while (reading) {
      try {
        const r = await device.transferIn(pipe.ep_in, 1024);
        if (r.data && r.data.byteLength) {
          blob += dec.decode(new Uint8Array(r.data.buffer), { stream: true });
          if (blob.includes(plan.expect)) {
            got = true;
            reading = false;
          }
        }
      } catch {
        break;
      }
    }
  })();
  for (let i = 0; i < plan.handshake.length && !got; i++) {
    try {
      await device.transferOut(pipe.ep_out, plan.handshake[i]);
    } catch {
      break;
    }
    await sleep(i < plan.init_count ? 50 : 60);
  }
  for (let i = 0; i < 20 && !got; i++) await sleep(50);
  reading = false;
  void reader;
  return got;
}

// Scan cmd_id candidates on this pipe; resolve true when the device re-enumerates.
async function probeScan(device: USBDevice, pipe: Pipe, plan: EnablePlan): Promise<boolean> {
  await sleep(200);
  let disconnected = false;
  const onDisc = (e: USBConnectionEvent) => {
    if (e.device === device) disconnected = true;
  };
  navigator.usb.addEventListener("disconnect", onDisc);
  try {
    for (const cand of plan.candidates) {
      if (disconnected) break;
      try {
        await device.transferOut(pipe.ep_out, cand);
      } catch {
        disconnected = true; // write failed = device gone = success
        break;
      }
      await sleep(200);
    }
  } finally {
    navigator.usb.removeEventListener("disconnect", onDisc);
  }
  return disconnected;
}
