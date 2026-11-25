# Persistent boot features (experimental)

Status: **experimental, not bench-qualified.** Design + code shipped on this
fork branch (`persist-boot`); the boot path has not been run on hardware from
this implementation. Treat `toolya persist install` as a research operation
with the same rules as the rest of the README.

## What it gives you

After one install over ADB, every cold boot — with no host, no Toolya, no
re-plug — ends up with:

- **ADB (and therefore root) already on**: the boot hook sets
  `sys.usb.config acm,adb` (the same switch the stock engpc factory path uses),
  so the goggles enumerate an ADB interface without the DUML enable dance.
- **SELinux Permissive**: the hook devmem-pokes the `selinux_state` enforce
  byte early in boot (the same poke `toolya selinux permissive` does in
  session), so permissive survives the reboot instead of resetting.

Both are flag-gated and **revert = delete flag + reboot** (or pull the flag
file from any root session). No flash-chain contact: every write is a file on
`/vendor` (remounted rw, like natartos) or `/data`.

## Mechanism

Research established (goggles3 repo, `review/sepolicy_kexec_2026-11-25.md`)
that the only persistent, policy-clean root anchor on the retail unit is the
`dji_domain` family: `dji_services` runs uid 0, belongs to `dji_domain`
(full capability set incl. `sys_rawio`), and its startup is bench-proven to
run every boot under enforcing. The GPS HAL is loaded inside `dji_services`
at boot (marker-probe bench, grom-labs/natartos `docs/BOOT_MARKER_PROBE.md`).

```
boot → init → dji_services (root, dji_domain)
     → dlopen /vendor/lib64/gps.default.so        ← our proxy (stock moved to gps.default.stock.so)
     → constructor: forward-first, then gates:
         euid==0 · enabled flag exact-match · no disabled flag · files root-owned, no group/world write
     → raw-fork ×2 → execve /vendor/lib64/toolya_persist/poke (static, minimal env)
         1. settle delay (stock boot first)
         2. devmem-poke selinux_state enforce byte → 0   (addresses from config file, from core contract)
         3. __system_property_set("sys.usb.config", "acm,adb")
         4. append one witness line to boot.log (capped 128 KiB)
```

Forward-first: the constructor resolves and validates the stock getter
*before* any gate logic. A proxy that can't forward the original
`gps_get_hardware_interface` refuses to do anything beyond forwarding —
breaking `dji_services` is the failure mode to avoid; worst case is a
degraded subsystem until reboot, never the flash chain.

## Safety model

- Writes: `/vendor` files (proxy, stock backup, helper dir) + `/data/toolya-persist/`
  (flags, config, log). Never `/system`, never `brload`/`fastboot`/factory
  scripts, never `dji_upgrade`, `/tmp/encrypt/`, or `cali_sdr`.
- Kill switch: `/data/toolya-persist/disabled` (also `toolya persist off` and
  the web toggle) — the proxy re-checks flags at every boot; a session where
  you just want stock behavior reboots stock by removing the enabled flag.
- Recovery: `toolya persist uninstall` restores `/vendor/lib64/gps.default.so`
  from the on-device `.stock.so` copy; or physically restore the file from any
  root session. Reboot is always a valid recovery (no fuse-class writes).
- Mutual exclusion: install **refuses** if the natartos boot-activation
  anchors exist (`/vendor/lib64/natartos_boot/`, `/data/dji/natartos-boot/`) —
  one owner for `gps.default.so` at a time.
- The helper only ever sets enforce → 0 and restores nothing at boot; going
  back to enforcing is a reboot (or `toolya selinux enforcing --yes`).

## Alternatives considered

- **A service in `/vendor/etc/init/*.rc`** (init starts it at boot, `user root`):
  simpler trigger, but the service runs in its own vendor SELinux domain, not
  `dji_domain` — no grant story for `/dev/mem` or the `sys.usb.config` write
  under enforcing. natartos 0.1.0 shipped an unfinished `adb_persist` stub of
  exactly this shape (its script never landed; uninstall still cleans
  `/vendor/etc/init/persist_adb.rc`). Kept as a Plan B only for permissive-boot
  units.
- **kexec payload route** (goggles3 unlock plan): full custom OS, heavier,
  bench-approved separately. This feature deliberately stays *inside* stock
  boot.

## Open bench questions (first run must confirm all)

1. `/dev/mem` mmap from `dji_services` under enforcing (dji_domain has
   `sys_rawio`; the DAC+LSM device-file check is unmeasured — natartos'
   activation profile gates the same "one RAM word" class of write).
2. `sys.usb.config` property write allowed to `dji_domain` at boot (the
   stock engpc path does this from the vendor side — strong precedent,
   not this exact context).
3. exec of a `vendor_file`-labeled helper from `dji_services` (needs
   `execute_no_trans`; if denied, fall back to doing the poke in a proxy
   constructor thread — gate on the bench avc log).
4. SELinux file context of pushed files (`vendor_file`) vs. the stock
   `gps.default.so` label — compare `ls -Z` before replacing.
5. Kernel-build coverage: `selinux_state` addresses come from the core
   contract (currently two builds). Unknown build ⇒ config write refused at
   install (`toolya info` reports the build).

## Layout (on-device)

| Path | What |
|---|---|
| `/vendor/lib64/gps.default.so` | proxy (replaces stock; forwards to `.stock.so`) |
| `/vendor/lib64/gps.default.stock.so` | the original library (on-device backup) |
| `/vendor/lib64/toolya_persist/poke` | static helper |
| `/vendor/lib64/toolya_persist/config` | `key=value` gates: selinux addrs/offset, usb string, delay |
| `/data/toolya-persist/enabled` | arm flag, exactly `toolya-persist-v1\n`, root 0600 |
| `/data/toolya-persist/disabled` | kill switch (presence = skip) |
| `/data/toolya-persist/boot.log` | witness lines, capped 128 KiB |

## Host side

- `core::contract::persist` — single source of truth for all paths, the arm
  token, and the config grammar (mirrored by the WASM web client).
- `cli/src/persist.rs` — `toolya persist install|status|on|off|log|uninstall`.
- `web` — status card + kill-switch toggle on a rooted page.
- `ondevice/persist/` — the two C pieces; build with the aarch64 Makefile
  (cross toolchain or container); `toolya persist install` pushes the built
  binaries from `ondevice/persist/build/`.
