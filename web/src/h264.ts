// Hardware-accelerated H.264 encoder (WebCodecs) for the goggles' HW video decoder.
//
// Turns a captured MediaStream into an H.264 Annex-B elementary stream — inter-frame
// compression, so a mostly-static screen costs a few KB/frame instead of a full
// JPEG (MJPEG path). Feeds the native decode→display pipeline on the goggles.
//
// Chrome/Edge only (needs VideoEncoder + MediaStreamTrackProcessor); the app
// already targets those for WebUSB.

// MediaStreamTrackProcessor isn't in the standard TS DOM lib yet — declare the
// bit we use (Chrome/Edge implement it).
declare global {
  class MediaStreamTrackProcessor {
    constructor(init: { track: MediaStreamTrack });
    readonly readable: ReadableStream<VideoFrame>;
  }
}

export interface H264EncoderOpts {
  width: number;
  height: number;
  fps: number;
  bitrate: number; // bits/sec
  keyIntSec?: number; // force an IDR every N seconds so the decoder can start
  // mid-stream (default 1 = 1 IDR/sec @30fps). In annexb mode each IDR carries
  // SPS/PPS inband, so a late joiner resyncs without out-of-band config.
  // Codec string. Default H.264 Baseline 4.0 (no B-frames = low latency, widest
  // HW-decoder support; covers 1080p30). An "hev1."/"hvc1." codec switches to
  // H.265 (check h265ConfigSupported first — browser support is spotty).
  codec?: string;
  onChunk: (data: Uint8Array, keyFrame: boolean) => void;
  onStats?: (s: { fps: number; kbps: number; queue: number }) => void;
  onError?: (e: Error) => void;
}

export interface H264EncoderHandle {
  stop(): void;
  readonly active: boolean;
}

/** WebCodecs H.264 encode is available (Chrome/Edge). */
export function h264Supported(): boolean {
  return (
    typeof VideoEncoder !== "undefined" &&
    typeof MediaStreamTrackProcessor !== "undefined"
  );
}

/** Probe whether the browser can actually configure this codec (default H.264). */
export async function h264ConfigSupported(width: number, height: number, codec = "avc1.42E028"): Promise<boolean> {
  if (!h264Supported()) return false;
  try {
    const { supported } = await VideoEncoder.isConfigSupported({ codec, width, height });
    return !!supported;
  } catch {
    return false;
  }
}

/** Probe H.265/HEVC encode support (spotty across browsers — check before using). */
export async function h265ConfigSupported(width: number, height: number, codec = "hev1.1.6.L120.90"): Promise<boolean> {
  return h264ConfigSupported(width, height, codec);
}

export async function startH264Encoder(
  stream: MediaStream,
  opts: H264EncoderOpts,
): Promise<H264EncoderHandle> {
  if (!h264Supported()) throw new Error("WebCodecs H.264 not supported in this browser (use Chrome/Edge)");
  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error("no video track in the stream");

  let running = true;
  let lastKey = 0;
  const keyIntMs = (opts.keyIntSec ?? 1) * 1000;

  // Stats
  let frames = 0;
  let bytes = 0;
  let t0 = performance.now();

  const encoder = new VideoEncoder({
    output: (chunk) => {
      const buf = new Uint8Array(chunk.byteLength);
      chunk.copyTo(buf);
      bytes += buf.length;
      frames++;
      opts.onChunk(buf, chunk.type === "key");
      const now = performance.now();
      const dt = now - t0;
      if (dt >= 1000) {
        opts.onStats?.({
          fps: Math.round((frames * 1000) / dt),
          kbps: Math.round(bytes / dt), // bytes/ms = KB/s
          queue: encoder.encodeQueueSize,
        });
        frames = 0;
        bytes = 0;
        t0 = now;
      }
    },
    error: (e) => {
      if (running) {
        running = false;
        opts.onError?.(e as unknown as Error);
      }
    },
  });

  const codec = opts.codec ?? "avc1.42E028"; // H.264 Baseline 4.0
  const isHevc = /^(hev1|hvc1)\./.test(codec);
  // `hevc` isn't in the TS DOM lib's VideoEncoderConfig yet (avc is).
  const config: VideoEncoderConfig & { hevc?: { format: "annexb" } } = {
    codec,
    width: opts.width,
    height: opts.height,
    bitrate: opts.bitrate,
    framerate: opts.fps,
    latencyMode: "realtime",
  };
  // Annex-B start codes with inband SPS/PPS (per IDR) — a raw elementary stream
  // the hardware decoder / file source ingests directly, no out-of-band config.
  if (isHevc) config.hevc = { format: "annexb" };
  else config.avc = { format: "annexb" };
  encoder.configure(config);

  const processor = new MediaStreamTrackProcessor({ track });
  const reader = processor.readable.getReader();

  (async () => {
    try {
      while (running) {
        const { done, value: frame } = await reader.read();
        if (done || !frame) break;
        // Drop frames if the encoder is backed up — keep latency low.
        if (encoder.encodeQueueSize < 4) {
          const now = performance.now();
          const keyFrame = now - lastKey >= keyIntMs;
          if (keyFrame) lastKey = now;
          encoder.encode(frame, { keyFrame });
        }
        frame.close();
      }
    } catch (e) {
      if (running) {
        running = false;
        opts.onError?.(e as Error);
      }
    }
  })();

  return {
    stop() {
      running = false;
      try { reader.cancel(); } catch { /* ignore */ }
      try { if (encoder.state !== "closed") encoder.close(); } catch { /* ignore */ }
    },
    get active() {
      return running;
    },
  };
}
