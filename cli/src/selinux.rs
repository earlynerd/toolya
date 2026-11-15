//! toolya selinux — session SELinux permissive toggle.
//!
//! `setenforce 0` is neverallow-blocked on the G3 (only the kernel domain may call
//! it), so toolya pokes the `selinux_state` enforce byte via `busybox devmem`. This
//! is session-only: it resets to Enforcing on reboot. For a permissive state that
//! survives reboot, use natartos (its sepolicy typepermissive patch on /vendor).
//!
//! Addresses are kernel-build-specific and come from the contract
//! (`toolya_core::contract::selinux`), not hardcoded here.

use std::process::exit;
use toolya_core::contract::selinux::{ENFORCE_OFFSET, STATE_ADDRS};

use crate::natartos::AdbConn;

fn connect() -> AdbConn {
    match crate::natartos::adb_device() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("{e}");
            exit(1);
        }
    }
}

fn shell(dev: &mut AdbConn, cmd: &str) -> Result<String, String> {
    let mut out = Vec::new();
    let none: Option<&mut dyn std::io::Write> = None;
    dev.shell_command(&cmd, Some(&mut out as &mut dyn std::io::Write), none)
        .map_err(|e| format!("shell: {e}"))?;
    Ok(String::from_utf8_lossy(&out).into_owned())
}

/// Shell command to scan known selinux_state addresses and set the enforce byte.
/// `byte` is "0x00" (permissive) or "0x01" (enforcing).
pub fn set_shell(byte: &str) -> String {
    let addrs = STATE_ADDRS.join(" ");
    format!(
        "for A in {addrs}; do V=$(busybox devmem $A 32 2>/dev/null) || continue; \
case \"$V\" in 0x01000100|0x01000000) busybox devmem $(printf 0x%X $((A+{ENFORCE_OFFSET}))) 8 {byte}; break;; esac; done; getenforce"
    )
}

fn read_enforce(dev: &mut AdbConn) -> Result<bool, String> {
    // `getenforce` on the G3 intermittently answers "Couldn't get enforcing
    // status: Permission denied", so retry and fall back to sysfs / prop reads.
    let mut last = String::new();
    for _ in 0..4 {
        let status = shell(dev, "getenforce 2>/dev/null || cat /sys/fs/selinux/enforce 2>/dev/null || getprop ro.boot.selinux 2>/dev/null")?;
        let t = status.trim();
        if t.eq_ignore_ascii_case("Permissive") || t == "0" {
            return Ok(true);
        }
        if t.eq_ignore_ascii_case("Enforcing") || t == "1" {
            return Ok(false);
        }
        last = t.to_string();
    }
    Err(format!("cannot read SELinux state (got: {last})"))
}

/// Ensure SELinux is Permissive on the device. Returns Ok(true) if it was already
/// permissive, Ok(false) if we had to toggle it. Err on failure.
pub fn ensure_permissive(dev: &mut AdbConn) -> Result<bool, String> {
    if read_enforce(dev)? {
        return Ok(true);
    }
    let _ = shell(dev, &set_shell("0x00"))?;
    if read_enforce(dev)? {
        Ok(false)
    } else {
        Err("failed to set SELinux permissive via devmem".into())
    }
}

pub fn run(args: &[String]) {
    let sub = args.first().map(String::as_str).unwrap_or("status");
    let confirmed = args.iter().any(|a| a == "--yes");

    match sub {
        "status" => {
            let mut dev = connect();
            match read_enforce(&mut dev) {
                Ok(true) => println!("SELinux: Permissive"),
                Ok(false) => println!("SELinux: Enforcing"),
                Err(e) => {
                    eprintln!("{e}");
                    exit(1);
                }
            }
        }
        "permissive" | "enforcing" => {
            let byte = if sub == "permissive" { "0x00" } else { "0x01" };
            if !confirmed {
                eprintln!("⚠ toolya selinux {sub} writes kernel memory (devmem) on your goggles.");
                eprintln!("  Session-only — SELinux returns to Enforcing on reboot.");
                eprintln!("  Re-run with --yes:  toolya selinux {sub} --yes");
                exit(1);
            }
            let mut dev = connect();
            if let Err(e) = shell(&mut dev, &set_shell(byte)) {
                eprintln!("{e}");
                exit(1);
            }
            // Confirm via the robust reader — NOT set_shell's trailing getenforce,
            // which flaps on the G3 and would falsely report failure.
            let want_permissive = sub == "permissive";
            match read_enforce(&mut dev) {
                Ok(p) => {
                    println!("SELinux: {}", if p { "Permissive" } else { "Enforcing" });
                    if p != want_permissive {
                        eprintln!("(devmem poke did not take — no known selinux_state address matched this kernel build)");
                        exit(1);
                    }
                }
                Err(_) => {
                    // Poke ran but the state couldn't be read back (getenforce denied,
                    // sysfs unreadable). Best-effort: report what we asked for.
                    println!("SELinux: {} (unconfirmed)", if want_permissive { "Permissive" } else { "Enforcing" });
                }
            }
        }
        _ => {
            eprintln!("usage: toolya selinux <status|permissive|enforcing> [--yes]");
            exit(1);
        }
    }
}
