// WebUSB install of the natartos mod framework — mirrors the CLI (toolya natartos
// install). Manifest-driven (docs/natartos-manifest.md), sha256-verified before any
// device write. Release assets are fetched through the same-origin Worker proxy
// (/api/dl) because GitHub asset downloads don't send CORS headers.
//
// Gated: there are no natartos releases yet, so fetchLatestRelease() returns null and
// the Install button stays inert until a release with the anti-brick loader exists.

import type { Adb } from "@yume-chan/adb";
import { run, pushFile, getSelinux, setSelinux } from "./adb";
import { getContract } from "./wasm";

interface Artifact {
  file: string;
  device_path: string;
  mode?: string;
  sha256: string;
}
// a selectable mod: an artifact plus UI/selection metadata
export interface Mod extends Artifact {
  id: string;
  name?: string;
  description?: string;
  provides?: string;
  default?: boolean;
}
export interface Manifest {
  schema: number;
  natartos_version?: string;
  device?: string;
  init_rc?: { device_path: string; content: string };
  loader: Artifact;
  files?: Artifact[];
  mods?: Mod[];
  backup?: string[];
  remove?: string[];
}
export interface Release {
  tag_name: string;
  prerelease: boolean;
  assets: { name: string; browser_download_url: string }[];
}
// a user-supplied mod (not from a signed release → never telemetried)
export interface CustomMod {
  name: string;
  bytes: Uint8Array;
}

export async function fetchLatestRelease(): Promise<Release | null> {
  try {
    const { natartos: nc } = await getContract();
    const r = await fetch(`https://api.github.com/repos/${nc.repo}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!r.ok) return null;
    return (await r.json()) as Release;
  } catch {
    return null;
  }
}

// download a release asset via the Worker proxy (GitHub asset CORS)
async function dl(assetUrl: string): Promise<Uint8Array> {
  const r = await fetch(`/api/dl?u=${encodeURIComponent(assetUrl)}`);
  if (!r.ok) throw new Error(`download failed (${r.status})`);
  return new Uint8Array(await r.arrayBuffer());
}

async function sha256hex(bytes: Uint8Array): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const parentDir = (p: string) => p.replace(/\/[^/]+$/, "") || "/";
const te = (s: string) => new TextEncoder().encode(s);
// single-quote a value for safe interpolation into a root shell command
const shq = (s: string) => `'${String(s).replace(/'/g, "'\\''")}'`;
// install only ever writes under /vendor; reject anything else (manifest is untrusted
// until releases are signed — see SECURITY.md).
function vendorPath(p: unknown): string {
  if (typeof p !== "string" || !p.startsWith("/vendor/") || p.includes("..") || /[\n\r\0]/.test(p))
    throw new Error(`refusing unsafe device path in manifest: ${String(p)}`);
  return p;
}
function safeMode(m?: string): string {
  const v = m ?? "0644";
  if (!/^[0-7]{3,4}$/.test(v)) throw new Error(`refusing unsafe mode in manifest: ${v}`);
  return v;
}
function customModPath(name: string): string {
  const base = name.split(/[/\\]/).pop() || "";
  if (!/^[A-Za-z0-9._-]+\.so$/.test(base)) throw new Error(`invalid custom mod name: ${name}`);
  return vendorPath(`/vendor/natartos/mods/${base}`);
}

/** Download + parse a release's manifest.json (so the UI can list selectable mods). */
export async function loadManifest(rel: Release): Promise<Manifest> {
  const a = rel.assets.find((x) => x.name === "manifest.json");
  if (!a) throw new Error("release is missing manifest.json");
  const m = JSON.parse(new TextDecoder().decode(await dl(a.browser_download_url))) as Manifest;
  if (m.schema !== 1) throw new Error(`manifest schema ${m.schema} unsupported — update toolya`);
  return m;
}

/** Install the loader + the selected release mods (by id) + any custom .so, over adb.
 *  Everything is sha256-verified (release mods) and path-validated before any write.
 *  Returns the installed **release** mod ids (for anonymous per-mod telemetry). */
export async function installFromRelease(
  adb: Adb,
  rel: Release,
  manifest: Manifest,
  opts: { modIds: string[]; custom?: CustomMod[] },
  log: (s: string) => void,
): Promise<string[]> {
  const { natartos: nc } = await getContract();
  const asset = (name: string) => rel.assets.find((a) => a.name === name);
  const chosen = (manifest.mods ?? []).filter((m) => opts.modIds.includes(m.id));

  // 1. download + sha256-verify the loader + chosen release mods before touching the device
  const dlVerify = async (art: Artifact): Promise<Uint8Array> => {
    const a = asset(art.file);
    if (!a) throw new Error(`release is missing ${art.file}`);
    log(`downloading ${art.file}…`);
    const bytes = await dl(a.browser_download_url);
    const got = await sha256hex(bytes);
    if (!art.sha256 || got.toLowerCase() !== art.sha256.toLowerCase())
      throw new Error(`sha256 mismatch for ${art.file} — refusing to install`);
    return bytes;
  };
  const loaderBytes = await dlVerify(manifest.loader);
  const fileEntries: { art: Artifact; bytes: Uint8Array }[] = [];
  for (const f of manifest.files ?? []) fileEntries.push({ art: f, bytes: await dlVerify(f) });
  const modFiles: { art: Mod; bytes: Uint8Array }[] = [];
  for (const m of chosen) modFiles.push({ art: m, bytes: await dlVerify(m) });

  // 2. device check
  if (manifest.device) {
    const model = (await run(adb, "getprop ro.product.device; getprop ro.product.model")).toLowerCase();
    const hit = manifest.device.toLowerCase().split(/\s+/).some((t) => model.includes(t));
    if (!hit) throw new Error(`device mismatch: this release targets ${manifest.device}`);
  }

  // 3. validate every path/mode (manifest + custom are untrusted; writes stay under /vendor)
  const rcPath = manifest.init_rc ? vendorPath(manifest.init_rc.device_path) : null;
  const loaderPlan = {
    file: manifest.loader.file,
    path: vendorPath(manifest.loader.device_path),
    mode: safeMode(manifest.loader.mode),
    bytes: loaderBytes,
  };
  const filesPlan = fileEntries.map(({ art, bytes }) => ({
    file: art.file,
    path: vendorPath(art.device_path),
    mode: safeMode(art.mode),
    bytes,
  }));
  const modPlan = modFiles.map(({ art, bytes }) => ({
    file: art.file,
    path: vendorPath(art.device_path),
    mode: safeMode(art.mode),
    bytes,
  }));
  const customPlan = (opts.custom ?? []).map((c) => ({
    file: c.name,
    path: customModPath(c.name), // sanitized → /vendor/natartos/mods/<name>.so
    mode: "0644",
    bytes: c.bytes,
  }));
  const backups = (manifest.backup ?? []).map(vendorPath);
  const removes = (manifest.remove ?? []).map(vendorPath);

  // 4. apply (all interpolated values validated + single-quoted)
  log("remounting /vendor rw…");
  await run(adb, "mount -o remount,rw /vendor");
  await run(adb, `mkdir -p ${shq(nc.stock_dir)}`);
  for (const p of backups) {
    const base = p.split("/").pop();
    const orig = `${nc.stock_dir}/${base}.orig`;
    await run(adb, `[ -f ${shq(orig)} ] || cp ${shq(p)} ${shq(orig)}`);
  }
  for (const { file, path, mode, bytes } of [loaderPlan, ...filesPlan, ...modPlan, ...customPlan]) {
    log(`pushing ${file}…`);
    await run(adb, `mkdir -p ${shq(parentDir(path))}`);
    await pushFile(adb, path, bytes);
    await run(adb, `chmod ${mode} ${shq(path)}`);
  }
  for (const p of removes) await run(adb, `rm -f ${shq(p)}`);

  if (manifest.init_rc && rcPath) {
    log("writing vendor init…");
    await pushFile(adb, rcPath, te(manifest.init_rc.content));
    await run(adb, `chmod 644 ${shq(rcPath)}`);
  }
  // record installed state (version + chosen mod ids + custom names) for status/uninstall
  const installed = {
    natartos_version: manifest.natartos_version,
    mods: chosen.map((m) => m.id),
    custom: customPlan.map((c) => c.path.split("/").pop()),
  };
  await pushFile(adb, nc.manifest_device, te(JSON.stringify(manifest)));
  await pushFile(adb, "/vendor/natartos/installed.json", te(JSON.stringify(installed)));

  // auto-enable default mods (opt-in flags for inject.sh)
  await run(adb, "mkdir -p /vendor/natartos/enabled");
  for (const m of chosen) {
    if (m.default) {
      await run(adb, `touch ${shq(`/vendor/natartos/enabled/${m.file}`)}`);
      log(`  enabled (default): ${m.file}`);
    }
  }
  for (const c of customPlan) {
    const base = c.path.split("/").pop()!;
    await run(adb, `touch ${shq(`/vendor/natartos/enabled/${base}`)}`);
    log(`  enabled (custom): ${base}`);
  }

  await run(adb, `rm -f ${nc.bootcount} ${nc.status} ${nc.disabled}`);
  await run(adb, "sync");

  log(`natartos ${manifest.natartos_version ?? ""} installed (${chosen.length + customPlan.length} mod(s)) — activating…`);
  return chosen.map((m) => m.id);
}

/** Start mods on the device — runs inject.sh without reinstalling. */
export async function startMods(
  adb: Adb,
  log: (s: string) => void,
): Promise<void> {
  const { natartos: nc } = await getContract();
  const injectPath = "/vendor/natartos/inject.sh";
  const exists = (await run(adb, `[ -f ${shq(injectPath)} ] && echo y || echo n`)).trim();
  if (exists !== "y") throw new Error("natartos is not installed (no inject.sh on device)");

  const sel = await getSelinux(adb);
  if (!sel.toLowerCase().startsWith("perm")) {
    log("SELinux is enforcing — switching to permissive…");
    await setSelinux(adb, "permissive");
  }

  log("starting mods…");
  // Clear the loader log and any stale overlay flags / supervisor pid left by a
  // previous session — a leftover fb_stop sends the overlay into a
  // cleanup→restart loop, so dji_glasses never settles with the mods up.
  await run(adb, `rm -f ${nc.log}`);
  await run(
    adb,
    "rm -f /data/local/tmp/fb_stop /data/local/tmp/fb_override /data/local/tmp/natartos_restart /data/local/tmp/natartos_inject.pid",
  );
  await run(adb, "sync && echo 3 > /proc/sys/vm/drop_caches");

  // inject.sh stops dji_glasses, which re-enumerates USB and kills this ADB
  // shell. nohup is not enough — the child stays in the shell's process group
  // and dies with it, leaving init to respawn a STOCK dji_glasses (no mods).
  // setsid detaches it into its own session so it survives the drop (parity
  // with the CLI `cmd_start`).
  await run(adb, `setsid sh ${shq(injectPath)} </dev/null >/dev/null 2>&1 &`);

  log("waiting for startup (USB may reconnect)…");
  await new Promise((r) => setTimeout(r, 12000));

  const logText = (await run(adb, `cat ${nc.log} 2>/dev/null`)).trim();
  if (logText) log(logText);

  // Verify dji_glasses actually re-spawned under the loader. Stopping it
  // re-enumerates USB, so the read may fail on a dropped handle — only a clear
  // "0 mapped" is treated as failure; an unreadable handle asks for a reconnect.
  let loaded = "";
  try {
    loaded = (
      await run(adb, `cat /proc/$(pidof dji_glasses)/maps 2>/dev/null | grep -c natartos_loader`)
    ).trim();
  } catch {
    /* USB likely re-enumerated — can't confirm from here */
  }
  if (loaded === "0") {
    throw new Error("inject.sh ran but no mods are loaded — check status / log");
  }
  log(loaded && loaded !== "0" ? "mods started — loader mapped" : "mods started — reconnect and Refresh to confirm");
}

const FREEDOOM_ZIP = "https://github.com/freedoom/freedoom/releases/download/v0.13.0/freedoom-0.13.0.zip";
const DOOM_WAD_PATH = "/vendor/natartos/apps/doom/freedoom1.wad";

/** Download Freedoom Phase 1 WAD from GitHub, extract, push to device. */
export async function downloadDoomWad(
  adb: Adb,
  log: (s: string) => void,
): Promise<void> {
  log("downloading Freedoom (~24 MB zip)…");
  const zip = await dl(FREEDOOM_ZIP);
  log("extracting freedoom1.wad…");
  const wad = await extractFromZip(zip, /freedoom1\.wad$/i);
  if (!wad) throw new Error("freedoom1.wad not found in archive");
  log(`pushing freedoom1.wad (${(wad.byteLength / 1048576).toFixed(1)} MB)…`);
  await run(adb, "mount -o remount,rw /vendor");
  await run(adb, `mkdir -p ${shq(parentDir(DOOM_WAD_PATH))}`);
  await pushFile(adb, DOOM_WAD_PATH, wad);
  log("Doom WAD installed");
}

/** Push a user-supplied WAD file to the device. */
export async function pushDoomWad(
  adb: Adb,
  bytes: Uint8Array,
  log: (s: string) => void,
): Promise<void> {
  log(`pushing WAD (${(bytes.byteLength / 1048576).toFixed(1)} MB)…`);
  await run(adb, "mount -o remount,rw /vendor");
  await run(adb, `mkdir -p ${shq(parentDir(DOOM_WAD_PATH))}`);
  await pushFile(adb, DOOM_WAD_PATH, bytes);
  log("WAD installed");
}

async function extractFromZip(data: Uint8Array, nameRe: RegExp): Promise<Uint8Array | null> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65558); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a valid zip");
  const cdOff = view.getUint32(eocd + 16, true);
  const cdCount = view.getUint16(eocd + 10, true);
  let off = cdOff;
  for (let i = 0; i < cdCount; i++) {
    if (view.getUint32(off, true) !== 0x02014b50) break;
    const method = view.getUint16(off + 10, true);
    const compSize = view.getUint32(off + 20, true);
    const nameLen = view.getUint16(off + 28, true);
    const extraLen = view.getUint16(off + 30, true);
    const commentLen = view.getUint16(off + 32, true);
    const localOff = view.getUint32(off + 42, true);
    const name = new TextDecoder().decode(data.subarray(off + 46, off + 46 + nameLen));
    if (nameRe.test(name)) {
      const lNameLen = view.getUint16(localOff + 26, true);
      const lExtraLen = view.getUint16(localOff + 28, true);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = data.subarray(dataStart, dataStart + compSize);
      if (method === 0) return new Uint8Array(raw);
      if (method === 8) {
        const ds = new DecompressionStream("deflate-raw");
        const w = ds.writable.getWriter();
        void w.write(raw).then(() => w.close());
        const r = ds.readable.getReader();
        const chunks: Uint8Array[] = [];
        for (;;) { const { done, value } = await r.read(); if (done) break; chunks.push(value); }
        const total = chunks.reduce((s, c) => s + c.byteLength, 0);
        const out = new Uint8Array(total);
        let p = 0;
        for (const c of chunks) { out.set(c, p); p += c.byteLength; }
        return out;
      }
      throw new Error(`unsupported zip method ${method}`);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/** Push + run dm_noverity on the device — disables dm-verity for this session. */
export async function noverity(
  adb: Adb,
  binary: Uint8Array,
  log: (s: string) => void,
): Promise<boolean> {
  const dest = "/data/local/tmp/dm_noverity";

  log("pushing dm_noverity…");
  await pushFile(adb, dest, binary);
  await run(adb, `chmod 755 ${dest}`);

  log("running dm_noverity…");
  const output = await run(adb, dest);
  for (const line of output.split("\n")) if (line.trim()) log(`  ${line}`);

  const ok = output.includes("type='linear'");
  if (ok) {
    log("dm-verity disabled for this session");
  } else {
    log("dm_noverity may have failed — check output above");
  }
  return ok;
}
