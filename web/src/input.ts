// evdev input injection over adb-root — manual UI control and scripted UI autotests.
//
// This is the kernel evdev layer: `sendevent /dev/input/<dev> <type> <code> <value>`,
// the same path the physical buttons use. It is NOT the EW framework layer — EW
// injection (natartos mod_input) is a separate, unsafe path and is not used here.
//
// The key map comes from the core contract (wasm), so it is never duplicated here.
import type { Adb } from "@yume-chan/adb";
import { run } from "./adb";
import { getContract } from "./wasm";

export type KeyName = "BACK" | "OK" | "UP" | "DOWN" | "LEFT" | "RIGHT";

interface KeyDef { dev: string; type: number; code: number; confirmed: boolean }

async function keyDef(name: string): Promise<KeyDef> {
  const map = (await getContract()).input;
  // ENTER is an alias for OK (matches the CLI).
  const key = name.trim().toUpperCase();
  const def = map[key === "ENTER" ? "OK" : key];
  if (!def) throw new Error(`unknown key "${name}" (known: ${Object.keys(map).join(", ")})`);
  return def;
}

function sendevent(dev: string, type: number, code: number, value: number): string {
  return `sendevent /dev/input/${dev} ${type} ${code} ${value}`;
}

/** EV_KEY press (value 1) + SYN_REPORT. */
function downCmds(k: KeyDef): string[] {
  return [sendevent(k.dev, k.type, k.code, 1), sendevent(k.dev, 0, 0, 0)];
}
/** EV_KEY release (value 0) + SYN_REPORT. */
function upCmds(k: KeyDef): string[] {
  return [sendevent(k.dev, k.type, k.code, 0), sendevent(k.dev, 0, 0, 0)];
}

/** Press and release a named key (down, SYN, up, SYN) in one shell call. */
export async function sendKey(adb: Adb, name: string): Promise<void> {
  const k = await keyDef(name);
  await run(adb, [...downCmds(k), ...upCmds(k)].join("; "));
}

/** Hold a key down for `ms` milliseconds, then release (e.g. long BACK ≥1500ms). */
export async function holdKey(adb: Adb, name: string, ms: number): Promise<void> {
  const k = await keyDef(name);
  await run(adb, downCmds(k).join("; "));
  await new Promise((r) => setTimeout(r, ms));
  await run(adb, upCmds(k).join("; "));
}

/** Press a key down without releasing (pair with keyUp). */
export async function keyDown(adb: Adb, name: string): Promise<void> {
  const k = await keyDef(name);
  await run(adb, downCmds(k).join("; "));
}

/** Release a previously held key. */
export async function keyUp(adb: Adb, name: string): Promise<void> {
  const k = await keyDef(name);
  await run(adb, upCmds(k).join("; "));
}

/** One raw sendevent (no SYN added) — escape hatch for codes not in the map. */
export async function raw(adb: Adb, dev: string, type: number, code: number, value: number): Promise<void> {
  const node = dev.replace(/^\/dev\/input\//, "");
  await run(adb, sendevent(node, type, code, value));
}
