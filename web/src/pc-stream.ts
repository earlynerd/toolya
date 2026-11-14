// PC screen streaming to DJI Goggles 3 over USB/ADB.
//
// Browser captures screen (getDisplayMedia), encodes JPEG frames,
// sends over ADB subprocess stdin to fb_receiver on the goggles.
// fb_receiver decodes JPEG → BGRA → fb_shared → hook_overlay.so → DMA-buf → display.
//
// Protocol: [u32le jpeg_size][jpeg_bytes] per frame — same as fb_stream output.

import type { Adb } from "@yume-chan/adb";
import { run } from "./adb";

const FB_RECEIVER_VENDOR = "/vendor/natartos/apps/stream/fb_receiver";
const FB_RECEIVER_TMP = "/data/local/tmp/fb_receiver";
const FB_PIPE_PATH = "/data/local/tmp/fb_pipe";

export interface PcStreamHandle {
  stop(): void;
  readonly active: boolean;
  readonly fps: number;
}

export interface PcStreamOpts {
  adb: Adb;
  quality: number;    // 0.1–0.95
  fpsCap: number;     // 5–60
  preview: HTMLCanvasElement;
  onStatus?: (info: { fps: number; frames: number; kbps: number; encMs: number; avgKb: number; dropped: number }) => void;
  onError?: (err: string) => void;
  onStop?: (reason: string) => void;
}

async function findReceiver(adb: Adb): Promise<string> {
  // prefer the natartos-installed binary (no push needed)
  try {
    const out = await run(adb, `[ -x ${FB_RECEIVER_VENDOR} ] && echo OK || echo MISSING`);
    if (out.includes("OK")) return FB_RECEIVER_VENDOR;
  } catch { /* not present */ }
  // fallback: /data/local/tmp (push from bundled or error)
  try {
    const out = await run(adb, `[ -x ${FB_RECEIVER_TMP} ] && echo OK || echo MISSING`);
    if (out.includes("OK")) return FB_RECEIVER_TMP;
  } catch { /* not present */ }
  throw new Error("fb_receiver not found — install natartos first (toolya natartos install)");
}

export async function startPcStream(opts: PcStreamOpts): Promise<PcStreamHandle> {
  const { adb } = opts;
  let running = true;
  let fps = 0;

  // Stats
  let frames = 0, sentBytes = 0, dropped = 0;
  let lastT = performance.now(), lastF = 0, lastB = 0;
  let encMs = 0, avgSize = 0;

  function tick() {
    const now = performance.now();
    const dt = (now - lastT) / 1000;
    if (dt >= 1) {
      fps = (frames - lastF) / dt;
      opts.onStatus?.({
        fps: Math.round(fps),
        frames,
        kbps: Math.round((sentBytes - lastB) / dt / 1024),
        encMs: +encMs.toFixed(1),
        avgKb: +(avgSize / 1024).toFixed(1),
        dropped,
      });
      lastT = now;
      lastF = frames;
      lastB = sentBytes;
    }
  }

  const receiverPath = await findReceiver(adb);

  // Capture screen
  let mediaStream: MediaStream;
  try {
    mediaStream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } },
      audio: false,
    });
  } catch (e) {
    throw new Error("Screen capture denied: " + (e as Error).message);
  }

  // If menu already launched fb_receiver (FIFO exists), connect via pipe;
  // otherwise spawn fb_receiver directly reading from stdin.
  let pipeMode = false;
  try {
    const chk = await run(adb, `[ -p ${FB_PIPE_PATH} ] && echo PIPE || echo NONE`);
    pipeMode = chk.includes("PIPE");
  } catch { /* direct mode */ }

  const proc = pipeMode
    ? await adb.subprocess.noneProtocol.spawn(`cat > ${FB_PIPE_PATH}`)
    : await adb.subprocess.noneProtocol.spawn(receiverPath);
  const writer = proc.stdin.getWriter();

  const video = document.createElement("video");
  video.srcObject = mediaStream;
  video.muted = true;
  video.play();

  mediaStream.getVideoTracks()[0].addEventListener("ended", () => stop("share stopped"));

  const offscreen = document.createElement("canvas");
  let sending = false;
  let lastFrame = 0;
  let animFrame = 0;

  function loop() {
    if (!running) return;
    animFrame = requestAnimationFrame(loop);

    const now = performance.now();
    if (now - lastFrame < 1000 / opts.fpsCap) return;
    if (sending) { dropped++; return; }
    if (!video.videoWidth) return;

    offscreen.width = video.videoWidth;
    offscreen.height = video.videoHeight;
    const octx = offscreen.getContext("2d")!;
    octx.drawImage(video, 0, 0);

    // Preview
    const pctx = opts.preview.getContext("2d")!;
    pctx.drawImage(video, 0, 0, opts.preview.width, opts.preview.height);

    sending = true;
    const t0 = performance.now();

    offscreen.toBlob(async (blob) => {
      encMs = performance.now() - t0;
      if (!blob || !running) { sending = false; return; }
      avgSize = avgSize > 0 ? avgSize * 0.9 + blob.size * 0.1 : blob.size;

      try {
        const jpegBuf = new Uint8Array(await blob.arrayBuffer());
        // Frame header: u32le jpeg size
        const header = new Uint8Array(4);
        const dv = new DataView(header.buffer);
        dv.setUint32(0, jpegBuf.length, true);

        await writer.write(header);
        await writer.write(jpegBuf);

        frames++;
        sentBytes += 4 + jpegBuf.length;
        lastFrame = performance.now();
        tick();
      } catch (e) {
        if (running) {
          opts.onError?.("write failed: " + (e as Error).message);
          stop("write error");
        }
      }
      sending = false;
    }, "image/jpeg", opts.quality);
  }

  animFrame = requestAnimationFrame(loop);

  function stop(reason = "stopped") {
    if (!running) return;
    running = false;
    if (animFrame) cancelAnimationFrame(animFrame);
    mediaStream.getTracks().forEach(t => t.stop());
    try { writer.close(); } catch { /* ignore */ }
    try { proc.kill(); } catch { /* ignore */ }
    opts.onStop?.(reason);
  }

  // Monitor fb_receiver exit
  (async () => {
    try {
      const reader = proc.output.getReader();
      while (running) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch { /* ignore */ }
    if (running) stop("receiver exited");
  })();

  return {
    stop: () => stop(),
    get active() { return running; },
    get fps() { return fps; },
  };
}
