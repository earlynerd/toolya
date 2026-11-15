//! evdev input map for the Goggles 3 — the single source of truth for named keys,
//! shared by CLI (native) and Web (via the wasm contract). Pure, no I/O.
//!
//! This is the kernel evdev layer: events are injected with
//! `sendevent /dev/input/<dev> <type> <code> <value>` on an adb-root shell, i.e.
//! the same path the kernel uses for the physical buttons. It is NOT the EW
//! framework layer — EW injection (natartos mod_input) is a separate, unsafe path
//! (a cross-thread call into the single-threaded EW hangs the whole UI).
//!
//! Devices (confirmed by `getevent -lp` on the goggles):
//!   event0 = gpio_keys          — the hardware buttons (BACK, OK)
//!   event3 = omc_keys (uinput)  — the 5-way joystick, fed by dji_glasses
//!
//! Every key press is an EV_KEY event followed by an EV_SYN report:
//!   sendevent <dev> 1 <code> 1   # down   (EV_KEY, value 1)
//!   sendevent <dev> 0 0 0        # SYN_REPORT
//!   sendevent <dev> 1 <code> 0   # up     (EV_KEY, value 0)
//!   sendevent <dev> 0 0 0        # SYN_REPORT

/// Linux input event types (`<linux/input-event-codes.h>`).
pub const EV_SYN: u16 = 0;
pub const EV_KEY: u16 = 1;

/// A named key: which input node, which event type, which code.
pub struct Key {
    pub name: &'static str,
    /// evdev node under /dev/input, e.g. "event0".
    pub dev: &'static str,
    pub type_: u16,
    pub code: u16,
    /// Whether the (dev, code) pair is verified on hardware (getevent). All
    /// current keys are confirmed on the G3.
    pub confirmed: bool,
}

/// The key map. All codes confirmed on hardware via `getevent`:
/// gpio_keys (event0) buttons and omc_keys (event3) joystick.
pub const KEYS: &[Key] = &[
    // event0 — gpio_keys
    Key { name: "BACK",  dev: "event0", type_: EV_KEY, code: 158, confirmed: true },
    Key { name: "OK",    dev: "event0", type_: EV_KEY, code: 28,  confirmed: true },
    // event3 — omc_keys joystick
    Key { name: "UP",    dev: "event3", type_: EV_KEY, code: 103, confirmed: true },
    Key { name: "DOWN",  dev: "event3", type_: EV_KEY, code: 108, confirmed: true },
    Key { name: "LEFT",  dev: "event3", type_: EV_KEY, code: 105, confirmed: true },
    Key { name: "RIGHT", dev: "event3", type_: EV_KEY, code: 106, confirmed: true },
];

/// Look up a key by name (case-insensitive). ENTER is an alias for OK.
pub fn lookup(name: &str) -> Option<&'static Key> {
    let n = name.trim().to_ascii_uppercase();
    let n = if n == "ENTER" { "OK".to_string() } else { n };
    KEYS.iter().find(|k| k.name == n)
}

/// Comma-separated list of known key names (for usage/errors).
pub fn names() -> String {
    KEYS.iter().map(|k| k.name).collect::<Vec<_>>().join(", ")
}

/// One `sendevent` shell command for a raw event (no SYN).
pub fn sendevent(dev: &str, type_: u16, code: u16, value: i32) -> String {
    format!("sendevent /dev/input/{dev} {type_} {code} {value}")
}

/// The SYN_REPORT command for a device.
fn syn(dev: &str) -> String {
    sendevent(dev, EV_SYN, 0, 0)
}

/// Commands to press a key down (EV_KEY value 1 + SYN). For holds.
pub fn down(key: &Key) -> Vec<String> {
    vec![sendevent(key.dev, key.type_, key.code, 1), syn(key.dev)]
}

/// Commands to release a key (EV_KEY value 0 + SYN). For holds.
pub fn up(key: &Key) -> Vec<String> {
    vec![sendevent(key.dev, key.type_, key.code, 0), syn(key.dev)]
}

/// Commands for a full key tap: down + up, each with its SYN.
pub fn tap(key: &Key) -> Vec<String> {
    let mut v = down(key);
    v.extend(up(key));
    v
}

/// The key map as JSON, for the web contract (single source of truth).
/// `{ "<NAME>": {"dev":"event0","type":1,"code":158,"confirmed":true}, ... }`
pub fn map_json() -> String {
    let entries: Vec<String> = KEYS
        .iter()
        .map(|k| {
            format!(
                "\"{}\":{{\"dev\":\"{}\",\"type\":{},\"code\":{},\"confirmed\":{}}}",
                k.name, k.dev, k.type_, k.code, k.confirmed
            )
        })
        .collect();
    format!("{{{}}}", entries.join(","))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn back_and_ok_confirmed() {
        let back = lookup("back").unwrap();
        assert_eq!((back.dev, back.code, back.confirmed), ("event0", 158, true));
        let ok = lookup("OK").unwrap();
        assert_eq!(ok.code, 28);
        // ENTER aliases OK
        assert_eq!(lookup("enter").unwrap().code, 28);
    }

    #[test]
    fn tap_has_down_up_with_syn() {
        let back = lookup("BACK").unwrap();
        assert_eq!(
            tap(back),
            vec![
                "sendevent /dev/input/event0 1 158 1",
                "sendevent /dev/input/event0 0 0 0",
                "sendevent /dev/input/event0 1 158 0",
                "sendevent /dev/input/event0 0 0 0",
            ]
        );
    }

    #[test]
    fn map_json_round_trips() {
        let j = map_json();
        assert!(j.starts_with('{') && j.ends_with('}'));
        assert!(j.contains("\"BACK\":{\"dev\":\"event0\",\"type\":1,\"code\":158,\"confirmed\":true}"));
        assert!(j.contains("\"UP\":{\"dev\":\"event3\",\"type\":1,\"code\":103,\"confirmed\":true}"));
    }
}
