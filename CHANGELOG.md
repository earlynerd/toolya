# Changelog

## [Unreleased]

### Added
- **CLI + Web (experimental):** `persist` — persistent ADB+root and SELinux permissive
  across reboots via a `/vendor` boot anchor (GPS HAL forward-first proxy + raw-syscall
  boot helper), arm/kill flags, boot witness log, and a web kill switch. Not
  bench-qualified; design and open questions in `docs/PERSIST.md`
- **CLI + Web:** `input` — evdev key injection (BACK/OK/joystick) for manual control and UI autotests; key map in core, shared via the wasm contract
- **Web:** 60 fps MJPEG live screen streaming (requires natartos display hook)
- **Web:** natartos mod framework installer with version management and rollback
- **Web:** shared Rust/WASM core — device contract, enable plan, constants from one source
- **CLI:** `info` command with getprop parser, usage counters, serial masking
- **CLI:** `natartos` subcommand (versions/install/uninstall/status/safe)
- **CLI:** `selinux`, `usb`, `reboot` scaffolds
- Device-side `fb_stream` JPEG encoder (aarch64, libjpeg-turbo NEON)

### Security
- All serials masked before display; no PII stored or transmitted
- Anonymous telemetry only (no device serial, no IP stored)
- CSP headers on all served pages
