use sha2::{Digest, Sha256};
use std::io::{self, Write};
use std::path::PathBuf;

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct State {
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    devices: Vec<String>,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn config_dir() -> Option<PathBuf> {
    std::env::var("XDG_CONFIG_HOME")
        .ok()
        .map(PathBuf::from)
        .or_else(|| {
            #[cfg(unix)]
            { std::env::var("HOME").ok().map(|h| PathBuf::from(h).join(".config")) }
            #[cfg(windows)]
            { std::env::var("APPDATA").ok().map(PathBuf::from) }
        })
        .map(|d| d.join("toolya"))
}

fn state_path() -> Option<PathBuf> {
    config_dir().map(|d| d.join("telemetry.json"))
}

fn load() -> State {
    state_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save(st: &State) {
    if let Some(p) = state_path() {
        let _ = std::fs::create_dir_all(p.parent().unwrap());
        let _ = std::fs::write(p, serde_json::to_string_pretty(st).unwrap_or_default());
    }
}

fn device_hash(serial: &str) -> String {
    let h = Sha256::digest(serial.as_bytes());
    hex(&h[..4])
}

fn machine_cid() -> String {
    let mut h = Sha256::new();
    h.update(std::env::var("USER").unwrap_or_default().as_bytes());
    h.update(std::env::consts::OS.as_bytes());
    h.update(std::env::consts::ARCH.as_bytes());
    let id = hex(&h.finalize()[..16]);
    format!("cli-{}", &id[..8])
}

fn ask_consent() -> bool {
    eprint!("\nShare an anonymous +1 to the rooted counter at toolya.dev?\nNo personal data — just the event. (y/N) ");
    let _ = io::stderr().flush();
    let mut line = String::new();
    if io::stdin().read_line(&mut line).is_err() {
        return false;
    }
    matches!(line.trim(), "y" | "Y" | "yes" | "Yes")
}

fn send_beacon() {
    let payload = serde_json::json!({
        "ev": "connect_ok",
        "os": std::env::consts::OS,
        "browser": "cli",
        "stage": "",
        "reason": "",
        "cid": machine_cid(),
        "ref": "",
        "t": 0,
    });
    let _ = ureq::post("https://toolya.dev/api/stat")
        .header("content-type", "application/json")
        .send(payload.to_string().as_bytes());
}

/// Call after a successful adb enable. `serial` is the raw device serial.
/// Pass `disabled = true` (--no-telemetry) to skip entirely.
pub fn after_root(serial: &str, disabled: bool) {
    if disabled {
        return;
    }
    let mut st = load();
    if st.enabled == Some(false) {
        return;
    }
    let dh = device_hash(serial);
    if st.devices.contains(&dh) {
        return;
    }
    if st.enabled.is_none() {
        let yes = ask_consent();
        st.enabled = Some(yes);
        save(&st);
        if !yes {
            return;
        }
    }
    send_beacon();
    st.devices.push(dh);
    save(&st);
    eprintln!("  +1 sent. Disable: toolya adb --no-telemetry or delete ~/.config/toolya/telemetry.json");
}
