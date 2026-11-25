//! toolya persist — EXPERIMENTAL persistent boot features (docs/PERSIST.md).
//!
//! Installs a boot anchor (GPS HAL proxy on /vendor) that, every boot, turns
//! ADB on (setprop sys.usb.config) and pokes SELinux permissive (devmem),
//! gated on arm/kill flags under /data. Revert is flag+reboot; uninstall
//! restores the stock library. No flash-chain contact anywhere.
//!
//! Subcommands:
//!   install [--yes] [--build <dir>]   push anchor + helper (needs built ondevice/persist)
//!   status                            what's installed, armed, and last boot's witness
//!   on | off                          arm flag / kill switch (off = disabled flag)
//!   log                               tail the boot witness log
//!   uninstall [--yes]                 restore stock gps.default.so, remove files

use std::fs;
use std::io::Cursor;
use std::path::PathBuf;
use std::process::exit;

use toolya_core::contract::persist as P;
use toolya_core::contract::selinux as SEL;
use toolya_core::contract::usb as USB;

use crate::natartos::AdbConn;

fn connect() -> AdbConn {
    match crate::natartos::adb_device() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("{e}");
            eprintln!("(enable ADB first: toolya adb --yes)");
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

fn push_bytes(dev: &mut AdbConn, data: &[u8], remote: &str) -> Result<(), String> {
    let mut cursor = Cursor::new(data);
    dev.push(&mut cursor, &remote)
        .map_err(|e| format!("push → {remote}: {e}"))
}

fn require_yes(sub: &str) {
    eprintln!("⚠ toolya persist {sub} writes to /vendor on your goggles (persistent across reboots).");
    eprintln!("  Files only — no flash chain — and uninstall restores the stock library.");
    eprintln!("  EXPERIMENTAL: this boot path is not yet bench-qualified on this implementation.");
    eprintln!("  Re-run with --yes:  toolya persist {sub} --yes");
    exit(1);
}

fn built_dir(args: &[String]) -> PathBuf {
    if let Some(i) = args.iter().position(|a| a == "--build") {
        if let Some(p) = args.get(i + 1) {
            return PathBuf::from(p);
        }
    }
    if let Ok(p) = std::env::var("TOOLYA_PERSIST_BUILD") {
        return PathBuf::from(p);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../ondevice/persist/build")
}

fn natartos_boot_conflict(dev: &mut AdbConn) -> bool {
    let out = shell(
        dev,
        &format!(
            "[ -e {} ] || [ -e {} ] && echo CONFLICT || echo ok",
            P::NATARTOS_BOOT_DIR,
            P::NATARTOS_BOOT_STATE
        ),
    )
    .unwrap_or_default();
    out.contains("CONFLICT")
}

fn cmd_install(args: &[String]) {
    let dir = built_dir(args);
    let proxy = dir.join("gps.default.so");
    let helper = dir.join("poke");
    for f in [&proxy, &helper] {
        if !f.exists() {
            eprintln!("missing built artifact: {}", f.display());
            eprintln!("build it first:  cd ondevice/persist && make   (aarch64 toolchain or container)");
            exit(1);
        }
    }

    let mut dev = connect();

    print!("Checking for natartos boot-activation conflict... ");
    if natartos_boot_conflict(&mut dev) {
        eprintln!("\nFATAL: natartos boot-activation is installed on this unit.");
        eprintln!("Only one owner for /vendor/lib64/gps.default.so at a time. Uninstall it first.");
        exit(1);
    }
    println!("ok");

    // A stock backup on-device means the anchor slot is already ours: update mode.
    let update = shell(&mut dev, &format!("[ -f {} ] && echo Y || echo N", P::GPS_STOCK))
        .unwrap_or_default()
        .contains('Y');

    print!("SELinux... ");
    match crate::selinux::ensure_permissive(&mut dev) {
        Ok(true) => println!("Permissive (ok)"),
        Ok(false) => println!("toggled to Permissive (session)"),
        Err(e) => {
            eprintln!("\nFATAL: {e}");
            eprintln!("Cannot write /vendor without permissive; on an unknown kernel the poke is unsafe to install.");
            exit(1);
        }
    }

    println!("Remounting /vendor rw...");
    let _ = shell(&mut dev, "mount -o remount,rw /vendor");

    if !update {
        println!("Backing up stock GPS HAL...");
        let ok = shell(
            &mut dev,
            &format!("[ -f {} ] || cp {} {}", P::GPS_STOCK, P::GPS_PROXY, P::GPS_STOCK),
        )
        .unwrap_or_default();
        let _ = ok;
        let have = shell(&mut dev, &format!("[ -f {} ] && echo Y || echo N", P::GPS_STOCK))
            .unwrap_or_default();
        if !have.contains('Y') {
            eprintln!("FATAL: could not back up stock gps.default.so — refusing to replace it.");
            exit(1);
        }
    } else {
        println!("Anchor already present — updating helper/config in place.");
    }

    println!("Pushing boot anchor...");
    let _ = shell(&mut dev, &format!("mkdir -p {}", P::DIR));
    let proxy_bytes = fs::read(&proxy).unwrap();
    let helper_bytes = fs::read(&helper).unwrap();

    // Push to temp names, verify, then move — never leave the vendor slot half-written.
    push_verified(&mut dev, &proxy_bytes, P::GPS_PROXY);
    let _ = shell(&mut dev, &format!("chmod 644 {}", P::GPS_PROXY));
    let _ = shell(&mut dev, &format!("chown 0:0 {}", P::GPS_PROXY));

    push_verified(&mut dev, &helper_bytes, P::HELPER);
    let _ = shell(&mut dev, &format!("chmod 755 {}", P::HELPER));
    let _ = shell(&mut dev, &format!("chown 0:0 {}", P::HELPER));

    // Config: this kernel's selinux_state candidates come from the contract;
    // the helper pattern-probes before writing, so unknown builds can't be poked.
    let cfg = P::config(SEL::STATE_ADDRS, SEL::ENFORCE_OFFSET, USB::ADB, 10);
    push_verified(&mut dev, cfg.as_bytes(), P::CONFIG);
    let _ = shell(&mut dev, &format!("chmod 600 {}", P::CONFIG));
    let _ = shell(&mut dev, &format!("chown 0:0 {}", P::CONFIG));

    println!("Arming (flag on /data)...");
    let _ = shell(&mut dev, &format!("mkdir -p {}", P::STATE_DIR));
    let _ = shell(&mut dev, &format!("chmod 700 {}", P::STATE_DIR));
    let _ = shell(
        &mut dev,
        &format!("printf '{}\\n' > {}", P::TOKEN, P::ENABLED),
    );
    let _ = shell(&mut dev, &format!("chmod 600 {}", P::ENABLED));
    let _ = shell(&mut dev, &format!("chown 0:0 {}", P::ENABLED));
    let _ = shell(&mut dev, &format!("touch {} 2>/dev/null; chmod 600 {} 2>/dev/null", P::LOG, P::LOG));
    let _ = shell(&mut dev, &format!("rm -f {}", P::DISABLED));

    println!();
    println!("Installed + armed. Reboot to arm the boot path (or `toolya persist off` first to hold).");
    println!("After reboot, `toolya persist status` shows the boot witness line.");
}

/// push to `<path>.new`, verify byte count, then move into place.
fn push_verified(dev: &mut AdbConn, data: &[u8], path: &str) {
    let tmp = format!("{path}.new");
    if let Err(e) = push_bytes(dev, data, &tmp) {
        eprintln!("{e}");
        exit(1);
    }
    let out = shell(dev, &format!("wc -c < {tmp} 2>/dev/null")).unwrap_or_default();
    let n: u64 = match out.trim().parse() {
        Ok(n) if n == data.len() as u64 => n,
        _ => {
            eprintln!("push truncated: {tmp} (device: {:?}, want {})", out.trim(), data.len());
            let _ = shell(dev, &format!("rm -f {tmp}"));
            exit(1);
        }
    };
    let _ = n;
    if let Err(e) = shell(dev, &format!("mv {tmp} {path}")) {
        eprintln!("{e}");
        exit(1);
    }
}

fn cmd_status() {
    let mut dev = connect();
    let mut f = |p: &str| {
        shell(&mut dev, &format!("[ -f {p} ] && echo Y || echo N")).unwrap_or_default()
    };
    let proxy = f(P::GPS_PROXY);
    let stock = f(P::GPS_STOCK);
    let helper = f(P::HELPER);
    let config = f(P::CONFIG);
    let enabled = f(P::ENABLED);
    let disabled = f(P::DISABLED);
    let installed = stock.contains('Y');

    println!("toolya persist status");
    println!(
        "  anchor: {}",
        if installed {
            if proxy.contains('Y') { "installed" } else { "BROKEN (proxy missing, stock backup present)" }
        } else {
            "not installed"
        }
    );
    println!("  helper: {}   config: {}", yn(&helper), yn(&config));
    println!(
        "  armed:  {}   kill-switch: {}",
        yn(&enabled),
        if disabled.contains('Y') { "ON (persist disabled)" } else { "off" }
    );
    println!("  enforce now: {}", shell(&mut dev, "getenforce 2>/dev/null || echo ?").unwrap_or_default().trim());
    println!("  sys.usb.config now: {}", shell(&mut dev, "getprop sys.usb.config").unwrap_or_default().trim());
    if installed {
        let same = shell(
            &mut dev,
            &format!(
                "[ \"$(sha256sum {} | cut -d' ' -f1)\" = \"$(sha256sum {} | cut -d' ' -f1)\" ] && echo SAME || echo DIFF",
                P::GPS_PROXY, P::GPS_STOCK
            ),
        )
        .unwrap_or_default();
        println!("  proxy vs stock: {}", if same.contains("SAME") { "identical (never activated?)" } else { "different (proxy active)" });
        let log = shell(&mut dev, &format!("tail -3 {} 2>/dev/null", P::LOG)).unwrap_or_default();
        let log = log.trim();
        println!("  last boot witness:");
        if log.is_empty() {
            println!("    (no boot has run the anchor yet)");
        } else {
            for l in log.lines() { println!("    {l}"); }
        }
    }
}

fn yn(s: &str) -> &'static str {
    if s.contains('Y') { "yes" } else { "no" }
}

fn cmd_on() {
    let mut dev = connect();
    let _ = shell(&mut dev, &format!("mkdir -p {} && chmod 700 {}", P::STATE_DIR, P::STATE_DIR));
    let _ = shell(&mut dev, &format!("printf '{}\\n' > {}", P::TOKEN, P::ENABLED));
    let _ = shell(&mut dev, &format!("chmod 600 {} && chown 0:0 {}", P::ENABLED, P::ENABLED));
    let _ = shell(&mut dev, &format!("rm -f {}", P::DISABLED));
    println!("armed: boot persistence enabled (takes effect from the next boot)");
}

fn cmd_off() {
    let mut dev = connect();
    let _ = shell(&mut dev, &format!("touch {}", P::DISABLED));
    println!("kill switch set: next boot is pure stock (files remain installed; `toolya persist on` clears it)");
}

fn cmd_log() {
    let mut dev = connect();
    let log = shell(&mut dev, &format!("tail -30 {} 2>/dev/null", P::LOG)).unwrap_or_default();
    print!("{log}");
    if log.trim().is_empty() {
        println!("(no witness lines yet — the anchor has not run a boot)");
    }
}

fn cmd_uninstall(args: &[String]) {
    if !args.iter().any(|a| a == "--yes") {
        require_yes("uninstall");
    }
    let mut dev = connect();
    print!("SELinux... ");
    let _ = crate::selinux::ensure_permissive(&mut dev);
    println!("ok");
    let _ = shell(&mut dev, "mount -o remount,rw /vendor");

    // Remove flags first: the anchor must never re-arm during the teardown.
    let _ = shell(&mut dev, &format!("rm -f {} {}", P::ENABLED, P::DISABLED));

    let have = shell(&mut dev, &format!("[ -f {} ] && echo Y || echo N", P::GPS_STOCK)).unwrap_or_default();
    if !have.contains('Y') {
        eprintln!("No stock backup at {} — refusing to guess. Restore manually.", P::GPS_STOCK);
        exit(1);
    }
    println!("Restoring stock gps.default.so...");
    let _ = shell(&mut dev, &format!("cp {} {}", P::GPS_STOCK, P::GPS_PROXY));
    let same = shell(
        &mut dev,
        &format!("cmp -s {} {} && echo SAME || echo DIFF", P::GPS_PROXY, P::GPS_STOCK),
    )
    .unwrap_or_default();
    if !same.contains("SAME") {
        eprintln!("FATAL: restore verification failed — stock backup still at {}", P::GPS_STOCK);
        exit(1);
    }
    let _ = shell(&mut dev, &format!("rm -f {}", P::GPS_STOCK));
    let _ = shell(&mut dev, &format!("rm -rf {}", P::DIR));
    let _ = shell(&mut dev, &format!("rm -rf {}", P::STATE_DIR));
    println!("Uninstalled. This session stays permissive; reboot returns to stock-enforcing.");
}

pub fn run(args: &[String]) {
    let sub = args.first().map(String::as_str).unwrap_or("status");
    match sub {
        "install" => {
            if !args.iter().any(|a| a == "--yes") {
                require_yes("install");
            }
            cmd_install(args);
        }
        "status" => cmd_status(),
        "on" => cmd_on(),
        "off" => cmd_off(),
        "log" => cmd_log(),
        "uninstall" => cmd_uninstall(args),
        _ => {
            eprintln!("usage: toolya persist <install|status|on|off|log|uninstall> [--yes]");
            exit(1);
        }
    }
}
