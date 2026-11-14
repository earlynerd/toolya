// Anonymous, aggregate-only telemetry: did enable/connect succeed, on which OS +
// browser, and where it broke. No device IDs, serials, IP, or personal data — just
// coarse counters so we can see where rooting fails. Honors Do-Not-Track, and never
// blocks or throws into the root flow.

const DNT =
  typeof navigator !== "undefined" &&
  (navigator.doNotTrack === "1" ||
    (navigator as unknown as { doNotTrack?: string }).doNotTrack === "yes");

// A random per-browser id (not derived from the device — never the serial), so the
// funnel can be counted by unique browsers. Persists in localStorage; falls back to a
// per-load random id in private mode. Only ever sent when telemetry is on (not under DNT).
const CID = (() => {
  const rnd = () => {
    try {
      return crypto.randomUUID();
    } catch {
      return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    }
  };
  try {
    let id = localStorage.getItem("toolya.cid");
    if (!id) {
      id = rnd();
      localStorage.setItem("toolya.cid", id);
    }
    return id;
  } catch {
    return rnd();
  }
})();

function platform(): { os: string; browser: string } {
  const ua = navigator.userAgent;
  let os = "other";
  if (/Windows/i.test(ua)) os = "win";
  else if (/Android/i.test(ua)) os = "android";
  else if (/Mac OS X|Macintosh/i.test(ua)) os = "mac";
  else if (/Linux|X11/i.test(ua)) os = "linux";

  let browser = "other";
  if (/Edg\//i.test(ua)) browser = "edge";
  else if (/OPR\/|Opera/i.test(ua)) browser = "opera";
  else if (/Chrome\//i.test(ua)) browser = "chrome";
  else if (/Firefox\//i.test(ua)) browser = "firefox";
  else if (/Safari\//i.test(ua)) browser = "safari";
  return { os, browser };
}

const T0 = performance.now();

const REF = (() => {
  try {
    // Prefer an explicit ?ref= / ?utm_source= (e.g. ChatGPT appends
    // utm_source=chatgpt.com and strips the referrer). Fall back to the
    // referrer hostname for sources that send one (Perplexity, Google, …).
    const q = new URLSearchParams(location.search);
    const explicit = q.get("ref") || q.get("utm_source");
    if (explicit) return explicit.slice(0, 60);
    const r = document.referrer;
    return r ? new URL(r).hostname : "";
  } catch { return ""; }
})();

export function getSupportId(): string {
  return CID.slice(0, 8);
}

function send(payload: Record<string, unknown>): void {
  const body = JSON.stringify(payload);
  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon("/api/stat", new Blob([body], { type: "application/json" }));
    } else {
      void fetch("/api/stat", {
        method: "POST",
        body,
        keepalive: true,
        headers: { "content-type": "application/json" },
      });
    }
  } catch { /* telemetry must never break the tool */ }
}

function alreadySent(key: string): boolean {
  try { return localStorage.getItem(`toolya.sent.${key}`) === "1"; } catch { return false; }
}
function markSent(key: string): void {
  try { localStorage.setItem(`toolya.sent.${key}`, "1"); } catch { /* ok */ }
}

export function stat(ev: string, extra: { stage?: string; reason?: string; deviceId?: string } = {}): void {
  if (DNT) return;
  if ((window as unknown as { __TOOLYA_DRY_RUN__?: unknown }).__TOOLYA_DRY_RUN__) return;
  if (ev === "connect_ok") {
    const dedupKey = extra.deviceId ? `connect_ok.${extra.deviceId}` : "connect_ok";
    if (alreadySent(dedupKey)) return;
    try {
      const { os, browser } = platform();
      const t = Math.round((performance.now() - T0) / 1000);
      send({ ev, os, browser, stage: extra.stage ?? "", reason: extra.reason ?? "", cid: CID, ref: REF, t });
      markSent(dedupKey);
    } catch { /* telemetry must never break the tool */ }
    return;
  }
  try {
    const { os, browser } = platform();
    const t = Math.round((performance.now() - T0) / 1000);
    send({ ev, os, browser, stage: extra.stage ?? "", reason: extra.reason ?? "", cid: CID, ref: REF, t });
  } catch { /* telemetry must never break the tool */ }
}

// For DNT users: after successful root, ask once if they want to share a bare +1.
// No cid, nid, country, ref — just the event name so the rooted counter stays accurate.
export function askDntRoot(): void {
  if (!DNT) return;
  send({ ev: "connect_ok", os: "", browser: "", stage: "", reason: "", cid: "dnt-anon-00" });
}
