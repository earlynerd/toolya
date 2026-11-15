//! Native USB transport for DUML (DJI Goggles 3). Pure Rust via nusb.
//!
//! Uses `toolya_core::enable_plan()` — same plan the Web client executes over
//! WebUSB. The transport differs (nusb vs WebUSB), the protocol is shared.

use std::future::Future;

use toolya_core::{DumlPort, EnablePlan};

pub const VID: u16 = 0x2CA3;
pub const PID: u16 = 0x0020;

/// A DUML data pipe: an interface number plus its OUT/IN bulk endpoints.
struct Pipe {
    iface_num: u8,
    ep_out: u8,
    ep_in: u8, // IN address already OR'd with 0x80
}

pub struct Goggles {
    dev: nusb::Device,
    serial: Option<String>,
    pipes: Vec<Pipe>,
    adb_mode: bool,
}

impl Goggles {
    /// Find and open the goggles in DUML (pre-adb) mode, resolving the candidate
    /// DUML pipes. The right pipe is picked later by handshake (`run_enable`).
    pub fn open(ports: &[DumlPort]) -> Result<Self, String> {
        let di = nusb::list_devices()
            .map_err(|e| format!("list usb: {e}"))?
            .find(|d| d.vendor_id() == VID && d.product_id() == PID)
            .ok_or_else(|| format!(
                "goggles not found (VID {VID:#06x} PID {PID:#06x}) — plugged in, in DUML mode?"
            ))?;
        let serial = di.serial_number().map(|s| s.to_string());
        let dev = di.open().map_err(|e| format!("open device: {e}"))?;
        // No macOS driver matches the DUML device, so it can sit unconfigured —
        // then writes go nowhere and reads stay silent. WebUSB selects config 1;
        // mirror that before claiming (harmless if it is already active).
        if dev.active_configuration().map(|c| c.configuration_value()).unwrap_or(0) != 1 {
            let _ = dev.set_configuration(1);
        }

        // 8-interface DUML mode: the data pipe is a specific interface, and which
        // one carries DUML differs across firmware builds. Resolve each plan port
        // to the interface that actually exposes its endpoints (like a known-good
        // probe), and keep all candidates — the handshake decides which is live.
        let debug = std::env::var("TOOLYA_USB_DEBUG").is_ok();
        let mut pipes: Vec<Pipe> = Vec::new();
        let mut adb_mode = false;
        if let Ok(cfg) = dev.active_configuration() {
            // ADB already enabled: the device exposes the Android ADB interface
            // (vendor-specific class 0xff / subclass 0x42 / protocol 0x01). DUML
            // mode has only CDC interfaces, so this cleanly tells the modes apart.
            for g in cfg.interfaces() {
                for alt in g.alt_settings() {
                    if alt.class() == 0xff && alt.subclass() == 0x42 && alt.protocol() == 0x01 {
                        adb_mode = true;
                    }
                }
            }
            if debug {
                eprintln!("[usb] config {}", cfg.configuration_value());
                for g in cfg.interfaces() {
                    for alt in g.alt_settings() {
                        let eps: Vec<String> = alt.endpoints().map(|e| format!("{:#04x}", e.address())).collect();
                        eprintln!("[usb] iface {} class={:#04x}/{:#04x}/{:#04x} eps=[{}]",
                            alt.interface_number(), alt.class(), alt.subclass(), alt.protocol(), eps.join(","));
                    }
                }
            }
            for p in ports {
                let want_out = p.ep_out;
                let want_in = p.ep_in | 0x80;
                let mut iface_num = None;
                'scan: for g in cfg.interfaces() {
                    for alt in g.alt_settings() {
                        let mut out = false;
                        let mut inp = false;
                        for e in alt.endpoints() {
                            if e.address() == want_out { out = true; }
                            if e.address() == want_in { inp = true; }
                        }
                        if out && inp {
                            iface_num = Some(alt.interface_number());
                            break 'scan;
                        }
                    }
                }
                let iface_num = iface_num.unwrap_or(p.iface);
                if !pipes.iter().any(|q| q.iface_num == iface_num) {
                    pipes.push(Pipe { iface_num, ep_out: want_out, ep_in: want_in });
                }
            }
        }
        // Fallback when the config could not be read: trust the plan's nominals.
        if pipes.is_empty() {
            for p in ports {
                pipes.push(Pipe { iface_num: p.iface, ep_out: p.ep_out, ep_in: p.ep_in | 0x80 });
            }
        }
        Ok(Self { dev, serial, pipes, adb_mode })
    }

    pub fn serial(&self) -> Option<&str> {
        self.serial.as_deref()
    }

    /// True when the goggles already expose the Android ADB interface — ADB is
    /// enabled, so the caller should connect instead of running the enable plan.
    pub fn adb_mode(&self) -> bool {
        self.adb_mode
    }

    /// Execute the adb-enable plan. Tries each candidate pipe: the one whose
    /// handshake returns `</dji>` is the live DUML interface, and the cmd_id scan
    /// runs on it. If none answers, every pipe still gets a blind scan.
    pub fn run_enable(&self, plan: &EnablePlan, log: impl Fn(&str)) -> Result<(), String> {
        // Pass 1: find the pipe that answers the handshake.
        for pipe in &self.pipes {
            let iface = match self.dev.claim_interface(pipe.iface_num) {
                Ok(i) => i,
                Err(_) => continue,
            };
            drain(&iface, pipe.ep_in);
            if handshake(&iface, pipe, plan) {
                log(&format!("handshake ok (iface {})", pipe.iface_num));
                return scan(&iface, pipe, plan, &log);
            }
            log(&format!("iface {}: no </dji>", pipe.iface_num));
        }
        // Pass 2: no handshake anywhere — try enabling blind on each pipe.
        for pipe in &self.pipes {
            let iface = match self.dev.claim_interface(pipe.iface_num) {
                Ok(i) => i,
                Err(_) => continue,
            };
            drain(&iface, pipe.ep_in);
            if let Ok(()) = scan(&iface, pipe, plan, &log) {
                return Ok(());
            }
        }
        Err("no </dji> on any DUML interface and no cmd_id triggered a disconnect — goggles not answering DUML".into())
    }
}

fn bulk_out(iface: &nusb::Interface, ep: u8, data: &[u8]) -> Result<(), String> {
    pollster::block_on(async {
        iface
            .bulk_out(ep, data.to_vec())
            .await
            .into_result()
            .map(|_| ())
            .map_err(|e| format!("bulk out: {e}"))
    })
}

/// Bulk IN with a deadline. A quiet endpoint never completes the transfer, so
/// without a timeout the whole enable hangs (the drain read, with no preceding
/// write, is the first to block). On timeout the transfer future is dropped —
/// nusb cancels it, so nothing leaks onto the endpoint.
fn bulk_in(iface: &nusb::Interface, ep: u8, max: usize, timeout_ms: u64) -> In {
    let fut = async {
        iface
            .bulk_in(ep, nusb::transfer::RequestBuffer::new(max))
            .await
            .into_result()
            .map_err(|e| format!("bulk in: {e}"))
    };
    match block_on_timeout(fut, timeout_ms) {
        Some(Ok(data)) => In::Data(data),
        Some(Err(e)) => In::Closed(e),
        None => In::Timeout,
    }
}

fn drain(iface: &nusb::Interface, ep_in: u8) {
    for _ in 0..15 {
        if !matches!(bulk_in(iface, ep_in, 65536, DRAIN_MS), In::Data(_)) { break; }
    }
}

/// Send the handshake packets on this pipe and return whether `</dji>` came back.
fn handshake(iface: &nusb::Interface, pipe: &Pipe, plan: &EnablePlan) -> bool {
    let mut blob = Vec::new();
    for (i, pkt) in plan.handshake.iter().enumerate() {
        if bulk_out(iface, pipe.ep_out, pkt).is_err() { break; }
        let delay = if i < plan.init_count { 50 } else { 60 };
        std::thread::sleep(std::time::Duration::from_millis(delay));
        if let In::Data(data) = bulk_in(iface, pipe.ep_in, 65536, HS_MS) {
            blob.extend_from_slice(&data);
            if contains_subslice(&blob, &plan.expect) { return true; }
        }
    }
    for _ in 0..20 {
        if let In::Data(data) = bulk_in(iface, pipe.ep_in, 65536, HS_MS) {
            blob.extend_from_slice(&data);
            if contains_subslice(&blob, &plan.expect) { return true; }
        }
    }
    false
}

/// Scan cmd_id candidates on this pipe. Ok when the device re-enumerates
/// (USB disconnect = ADB enabling); Err when the range is exhausted.
fn scan(iface: &nusb::Interface, pipe: &Pipe, plan: &EnablePlan, log: &impl Fn(&str)) -> Result<(), String> {
    std::thread::sleep(std::time::Duration::from_millis(200));
    drain(iface, pipe.ep_in);
    log(&format!("enabling adb (scanning cmd_id on iface {})…", pipe.iface_num));
    for pkt in &plan.candidates {
        if bulk_out(iface, pipe.ep_out, pkt).is_err() {
            log("adb enabling — goggles re-enumerate in ~5s. Then `adb devices`.");
            return Ok(());
        }
        for _ in 0..8 {
            match bulk_in(iface, pipe.ep_in, 1024, SCAN_MS) {
                In::Data(r) if r.len() >= 11 && r[8] == 0xC0 && r[10] == pkt[10] => break,
                In::Data(_) => continue,
                In::Timeout => break,
                In::Closed(_) => {
                    log("adb enabling — goggles re-enumerate in ~5s. Then `adb devices`.");
                    return Ok(());
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    Err("no cmd_id triggered USB disconnect".into())
}

/// Outcome of a bulk IN: data, a deadline with nothing received, or a real USB
/// error (the device dropped off the bus — during enable that means success).
enum In {
    Data(Vec<u8>),
    Timeout,
    Closed(String),
}

/// Drive `fut` to completion, or return `None` if `ms` elapses first. The loser
/// is dropped when this returns, which cancels a still-pending nusb transfer.
fn block_on_timeout<T>(fut: impl std::future::Future<Output = T>, ms: u64) -> Option<T> {
    pollster::block_on(async {
        let mut fut = std::pin::pin!(fut);
        let mut delay = std::pin::pin!(Delay::new(std::time::Duration::from_millis(ms)));
        std::future::poll_fn(|cx| {
            if let std::task::Poll::Ready(v) = fut.as_mut().poll(cx) {
                return std::task::Poll::Ready(Some(v));
            }
            match delay.as_mut().poll(cx) {
                std::task::Poll::Ready(()) => std::task::Poll::Ready(None),
                std::task::Poll::Pending => std::task::Poll::Pending,
            }
        })
        .await
    })
}

/// Minimal timer future: on first poll it arms a thread that sleeps, then flips
/// the flag and wakes the task. Avoids pulling in an async-timer dependency.
struct Delay {
    fired: std::sync::Arc<std::sync::atomic::AtomicBool>,
    armed: bool,
    dur: std::time::Duration,
}

impl Delay {
    fn new(dur: std::time::Duration) -> Self {
        Self {
            fired: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            armed: false,
            dur,
        }
    }
}

impl std::future::Future for Delay {
    type Output = ();
    fn poll(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<()> {
        use std::sync::atomic::Ordering;
        if self.fired.load(Ordering::Acquire) {
            return std::task::Poll::Ready(());
        }
        if !self.armed {
            self.armed = true;
            let fired = self.fired.clone();
            let waker = cx.waker().clone();
            let dur = self.dur;
            std::thread::spawn(move || {
                std::thread::sleep(dur);
                fired.store(true, Ordering::Release);
                waker.wake();
            });
        }
        std::task::Poll::Pending
    }
}

const DRAIN_MS: u64 = 200;
const HS_MS: u64 = 300;
const SCAN_MS: u64 = 150;

fn contains_subslice(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}
