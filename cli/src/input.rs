//! `toolya input` — send evdev input events to the goggles over adb-root, for
//! manual UI control and for UI autotests. This is the kernel evdev layer
//! (`sendevent /dev/input/...`), the same path the physical buttons use. It is
//! NOT the EW framework layer: EW injection (natartos mod_input) is a separate,
//! unsafe path and is not used here.
//!
//! Subcommands:
//!   key <NAME>            press + release (down, SYN, up, SYN)
//!   down <NAME>           press and hold (for long-press, e.g. BACK ≥1.5s)
//!   up <NAME>             release a held key
//!   raw <dev> <t> <c> <v> one raw sendevent (no SYN added)
//!
//! Key map lives in core (toolya_core::input) — single source of truth with web.

use std::process::exit;

use toolya_core::input;

use crate::natartos::{adb_device, AdbConn};

/// Run a shell command on the goggles, returning stdout (same path as natartos).
fn shell(dev: &mut AdbConn, cmd: &str) -> Result<String, String> {
    let mut stdout = Vec::new();
    let none: Option<&mut dyn std::io::Write> = None;
    dev.shell_command(&cmd, Some(&mut stdout as &mut dyn std::io::Write), none)
        .map_err(|e| format!("shell: {e}"))?;
    Ok(String::from_utf8_lossy(&stdout).into_owned())
}

/// Send a batch of sendevent commands as one shell line (atomic enough for taps).
fn send(dev: &mut AdbConn, cmds: &[String]) {
    let line = cmds.join("; ");
    if let Err(e) = shell(dev, &line) {
        eprintln!("input: {e}");
        exit(1);
    }
}

fn key_by_name(name: &str) -> &'static input::Key {
    match input::lookup(name) {
        Some(k) => k,
        None => {
            eprintln!("unknown key `{name}`. Known: {}", input::names());
            exit(1);
        }
    }
}

fn warn_unconfirmed(key: &input::Key) {
    if !key.confirmed {
        eprintln!(
            "⚠ {} ({} code {}) is unconfirmed — joystick codes need getevent on hardware.",
            key.name, key.dev, key.code
        );
    }
}

pub fn run(args: &[String]) {
    let sub = args.first().map(String::as_str).unwrap_or("");
    match sub {
        "key" | "down" | "up" => {
            let name = match args.get(1) {
                Some(n) => n.as_str(),
                None => { eprintln!("usage: toolya input {sub} <NAME>  ({})", input::names()); exit(1); }
            };
            let key = key_by_name(name);
            warn_unconfirmed(key);
            let cmds = match sub {
                "key" => input::tap(key),
                "down" => input::down(key),
                _ => input::up(key),
            };
            let mut dev = connect();
            send(&mut dev, &cmds);
            println!("{} {}", sub, key.name);
        }
        "raw" => {
            // raw <dev> <type> <code> <value>
            if args.len() < 5 {
                eprintln!("usage: toolya input raw <event0|event3|...> <type> <code> <value>");
                exit(1);
            }
            let dev_node = args[1].trim_start_matches("/dev/input/");
            let parse = |s: &str, what: &str| -> i64 {
                s.parse().unwrap_or_else(|_| { eprintln!("input raw: bad {what} `{s}`"); exit(1); })
            };
            let type_ = parse(&args[2], "type") as u16;
            let code = parse(&args[3], "code") as u16;
            let value = parse(&args[4], "value") as i32;
            let cmd = input::sendevent(dev_node, type_, code, value);
            let mut dev = connect();
            send(&mut dev, std::slice::from_ref(&cmd));
            println!("{cmd}");
        }
        "map" | "keys" => {
            // offline: list the key map (no device needed)
            for k in input::KEYS {
                let mark = if k.confirmed { "" } else { "  (unconfirmed)" };
                println!("  {:<6} {} type {} code {}{}", k.name, k.dev, k.type_, k.code, mark);
            }
        }
        _ => {
            eprintln!("toolya input — send evdev events to the goggles (adb-root)\n");
            eprintln!("  key <NAME>             press + release (down, SYN, up, SYN)");
            eprintln!("  down <NAME>            press and hold (long-press: down, wait, up)");
            eprintln!("  up <NAME>              release a held key");
            eprintln!("  raw <dev> <t> <c> <v>  one raw sendevent (no SYN)");
            eprintln!("  map                    list the key map (offline)");
            eprintln!("\nKeys: {}", input::names());
            eprintln!("event0=gpio_keys (BACK/OK, confirmed) · event3=omc_keys joystick (unconfirmed)");
            eprintln!("\nThis is the evdev layer. EW injection (natartos mod_input) is separate and unsafe.");
            exit(1);
        }
    }
}

fn connect() -> AdbConn {
    match adb_device() {
        Ok(d) => d,
        Err(e) => { eprintln!("{e}"); exit(1); }
    }
}
