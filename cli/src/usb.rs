//! Native USB transport for DUML (DJI Goggles 3). Pure Rust via nusb.
//!
//! Uses `toolya_core::enable_plan()` — same plan the Web client executes over
//! WebUSB. The transport differs (nusb vs WebUSB), the protocol is shared.

use toolya_core::{DumlPort, EnablePlan};

pub const VID: u16 = 0x2CA3;
pub const PID: u16 = 0x0020;

pub struct Goggles {
    iface: nusb::Interface,
    serial: Option<String>,
    ep_out: u8,
    ep_in: u8,
}

impl Goggles {
    /// Find and open the goggles in DUML (pre-adb) mode.
    /// Tries each port from the plan until one succeeds.
    pub fn open(ports: &[DumlPort]) -> Result<Self, String> {
        let di = nusb::list_devices()
            .map_err(|e| format!("list usb: {e}"))?
            .find(|d| d.vendor_id() == VID && d.product_id() == PID)
            .ok_or_else(|| format!(
                "goggles not found (VID {VID:#06x} PID {PID:#06x}) — plugged in, in DUML mode?"
            ))?;
        let serial = di.serial_number().map(|s| s.to_string());
        let dev = di.open().map_err(|e| format!("open device: {e}"))?;
        for p in ports {
            if let Ok(iface) = dev.claim_interface(p.iface) {
                return Ok(Self { iface, serial, ep_out: p.ep_out, ep_in: p.ep_in });
            }
        }
        let tried: Vec<String> = ports.iter().map(|p| p.iface.to_string()).collect();
        Err(format!("no DUML interface found (tried: {})", tried.join(", ")))
    }

    pub fn serial(&self) -> Option<&str> {
        self.serial.as_deref()
    }

    fn bulk_out(&self, ep: u8, data: &[u8]) -> Result<(), String> {
        pollster::block_on(async {
            self.iface
                .bulk_out(ep, data.to_vec())
                .await
                .into_result()
                .map(|_| ())
                .map_err(|e| format!("bulk out: {e}"))
        })
    }

    fn bulk_in(&self, ep: u8, max: usize) -> Result<Vec<u8>, String> {
        pollster::block_on(async {
            self.iface
                .bulk_in(ep, nusb::transfer::RequestBuffer::new(max))
                .await
                .into_result()
                .map_err(|e| format!("bulk in: {e}"))
        })
    }

    /// Execute the full adb-enable plan: handshake → cmd_id scan.
    /// Returns Ok on USB disconnect (= ADB enabling) or Err on failure.
    pub fn run_enable(&self, plan: &EnablePlan, log: impl Fn(&str)) -> Result<(), String> {
        let ep_in = self.ep_in | 0x80;
        let ep_out = self.ep_out;

        // Drain stale data
        for _ in 0..15 {
            if self.bulk_in(ep_in, 65536).is_err() { break; }
        }

        log("handshake…");
        let mut blob = Vec::new();
        let mut got_expect = false;
        for (i, pkt) in plan.handshake.iter().enumerate() {
            if got_expect { break; }
            if self.bulk_out(ep_out, pkt).is_err() { break; }
            let delay = if i < plan.init_count { 50 } else { 60 };
            std::thread::sleep(std::time::Duration::from_millis(delay));
            if let Ok(data) = self.bulk_in(ep_in, 65536) {
                blob.extend_from_slice(&data);
                if contains_subslice(&blob, &plan.expect) {
                    got_expect = true;
                }
            }
        }
        for _ in 0..20 {
            if got_expect { break; }
            std::thread::sleep(std::time::Duration::from_millis(50));
            if let Ok(data) = self.bulk_in(ep_in, 65536) {
                blob.extend_from_slice(&data);
                if contains_subslice(&blob, &plan.expect) {
                    got_expect = true;
                }
            }
        }
        if !got_expect {
            log("handshake: no </dji> (goggles may be asleep) — trying enable anyway…");
        } else {
            log("handshake ok");
        }

        std::thread::sleep(std::time::Duration::from_millis(200));
        for _ in 0..15 {
            if self.bulk_in(ep_in, 65536).is_err() { break; }
        }

        log("enabling adb (scanning cmd_id)…");
        for pkt in &plan.candidates {
            match self.bulk_out(ep_out, pkt) {
                Err(_) => {
                    log("adb enabling — goggles re-enumerate in ~5s. Then `adb devices`.");
                    return Ok(());
                }
                Ok(()) => {}
            }
            for _ in 0..8 {
                match self.bulk_in(ep_in, 1024) {
                    Ok(r) if r.len() >= 11 && r[8] == 0xC0 && r[10] == pkt[10] => {
                        let ret = if r.len() > 11 { r[11] } else { 0 };
                        if ret == 0xE0 { break; }
                        break;
                    }
                    Ok(_) => continue,
                    Err(_) => {
                        log("adb enabling — goggles re-enumerate in ~5s. Then `adb devices`.");
                        return Ok(());
                    }
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        Err("no cmd_id triggered USB disconnect — keep the goggles awake and try again".into())
    }
}

fn contains_subslice(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}
