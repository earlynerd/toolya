// No-root viewer.
//
// DJI Goggles 3 do NOT expose a UVC webcam over USB, so a browser can't grab
// their feed directly. What a browser CAN do is
// show any video input the OS already exposes as a camera — including a virtual
// camera (OBS Virtual Camera / a bridge app) fed by the goggles' USB-network
// stream. This module is that last-mile viewer: pick a camera, play it, go
// fullscreen. No ADB, no WebUSB, no root.

const sel = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

const deviceSel = sel<HTMLSelectElement>("device");
const video = sel<HTMLVideoElement>("preview");
const startBtn = sel<HTMLButtonElement>("start");
const fsBtn = sel<HTMLButtonElement>("fullscreen");
const statusEl = sel<HTMLParagraphElement>("status");

let stream: MediaStream | null = null;

function setStatus(msg: string, kind: "" | "ok" | "err" = "") {
  statusEl.textContent = msg;
  statusEl.dataset.kind = kind;
}

function stopStream() {
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
}

// Labels are empty until the first getUserMedia grant, so refresh the list
// after we have permission.
async function listDevices(selectId?: string) {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter((d) => d.kind === "videoinput");
  deviceSel.innerHTML = "";
  if (!cams.length) {
    const opt = new Option("no camera found", "");
    deviceSel.add(opt);
    deviceSel.disabled = true;
    return;
  }
  deviceSel.disabled = false;
  cams.forEach((d, i) => {
    deviceSel.add(new Option(d.label || `camera ${i + 1}`, d.deviceId));
  });
  if (selectId) deviceSel.value = selectId;
}

async function start() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("this browser has no camera API (getUserMedia)", "err");
    return;
  }
  stopStream();
  setStatus("requesting camera…");
  const id = deviceSel.value;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: id
        ? { deviceId: { exact: id }, width: { ideal: 1920 }, height: { ideal: 1080 } }
        : { width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
  } catch (e) {
    setStatus("camera denied or unavailable: " + (e as Error).message, "err");
    return;
  }
  video.srcObject = stream;
  await video.play().catch(() => { /* autoplay guard; user can click */ });
  fsBtn.disabled = false;
  const track = stream.getVideoTracks()[0];
  const s = track.getSettings();
  setStatus(`playing: ${track.label || "camera"} ${s.width ?? "?"}×${s.height ?? "?"}`, "ok");
  // Now that we have a grant, labels are populated — refresh and keep selection.
  await listDevices(track.getSettings().deviceId);
}

function fullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void video.requestFullscreen().catch(() => setStatus("fullscreen blocked", "err"));
}

export function initUnrooted() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    setStatus("this browser can't list cameras (needs HTTPS + MediaDevices)", "err");
    startBtn.disabled = true;
    return;
  }
  startBtn.addEventListener("click", () => void start());
  fsBtn.addEventListener("click", fullscreen);
  navigator.mediaDevices.addEventListener("devicechange", () => void listDevices(deviceSel.value));
  void listDevices();
  setStatus("pick a camera and press Start. A virtual camera (OBS / bridge app) appears here too.");
}

initUnrooted();
