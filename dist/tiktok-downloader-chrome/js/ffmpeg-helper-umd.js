(function (t, d) {
  typeof exports == "object" && typeof module < "u"
    ? (module.exports = d())
    : typeof define == "function" && define.amd
    ? define(d)
    : ((t = typeof globalThis < "u" ? globalThis : t || self),
      (t.FFmpegHelper = d()));
})(this, function () {
  "use strict";
  const t = [];
  for (let e = 0; e < 256; ++e) t.push((e + 256).toString(16).slice(1));
  function d(e, n = 0) {
    return (
      t[e[n + 0]] +
      t[e[n + 1]] +
      t[e[n + 2]] +
      t[e[n + 3]] +
      "-" +
      t[e[n + 4]] +
      t[e[n + 5]] +
      "-" +
      t[e[n + 6]] +
      t[e[n + 7]] +
      "-" +
      t[e[n + 8]] +
      t[e[n + 9]] +
      "-" +
      t[e[n + 10]] +
      t[e[n + 11]] +
      t[e[n + 12]] +
      t[e[n + 13]] +
      t[e[n + 14]] +
      t[e[n + 15]]
    ).toLowerCase();
  }
  let p;
  const m = new Uint8Array(16);
  function h() {
    if (!p) {
      if (typeof crypto > "u" || !crypto.getRandomValues)
        throw new Error(
          "crypto.getRandomValues() not supported. See https://github.com/uuidjs/uuid#getrandomvalues-not-supported"
        );
      p = crypto.getRandomValues.bind(crypto);
    }
    return p(m);
  }
  const u = {
    randomUUID:
      typeof crypto < "u" &&
      crypto.randomUUID &&
      crypto.randomUUID.bind(crypto),
  };
  function g(e, n, s) {
    if (u.randomUUID && !e) return u.randomUUID();
    e = e || {};
    const o = e.random ?? e.rng?.() ?? h();
    if (o.length < 16) throw new Error("Random bytes length must be >= 16");
    return (o[6] = (o[6] & 15) | 64), (o[8] = (o[8] & 63) | 128), d(o);
  }
  function a(e, n) {
    return typeof n == "object" && n !== null && "type" in n && n.type === e;
  }
  class y {
    iframeUrl;
    iframe = null;
    connectionId = g();
    initialized = !1;
    Ready;
    onComplete;
    onError;
    onProgress;
    onLog;
    constructor(n, s = "error") {
      let o;
      (this.Ready = new Promise((l) => {
        o = l;
      })),
        window.addEventListener("message", (l) => {
          const i = l.data;
          if (
            !(
              typeof i.source > "u" ||
              i.source !== "__FfmpegHelper_iframe__" ||
              i.connectionId !== this.connectionId
            )
          )
            if (a("ready", i)) {
              if (!i.data.status)
                throw new Error("FFmpeg helper failed to initialize.");
              o();
            } else
              a("log", i)
                ? this.onLog?.(i.data.type, i.data.message)
                : a("progress", i)
                ? this.onProgress?.(i.data.progress)
                : a("error", i)
                ? (this.onError?.(new Error(i.data.message)), this.cleanup())
                : a("complete", i) &&
                  (this.onComplete?.(i.data), this.cleanup());
        }),
        (this.iframeUrl = n);
      const r = document.createElement("iframe");
      (r.style.width = "0 !important"),
        (r.style.height = "0 !important"),
        (r.style.position = "absolute !important"),
        (r.style.border = "none !important"),
        (r.style.visibility = "hidden !important"),
        (r.style.display = "none !important"),
        (r.src = this.iframeUrl),
        document.body.appendChild(r),
        (r.onload = () =>
          this.postMessage("load", {
            connectionId: this.connectionId,
            logLevel: s,
          })),
        (r.onerror = () => {
          throw new Error("Failed to load the FFmpeg helper iframe.");
        }),
        (this.iframe = r);
    }
    cleanup() {
      this.iframe?.remove(), (this.iframe = null);
    }
    postMessage(n, s, o = []) {
      this.iframe?.contentWindow?.postMessage(
        {
          source: "__FfmpegHelper_parent__",
          type: n,
          connectionId: this.connectionId,
          data: s,
        },
        this.iframeUrl,
        o
      );
    }
    async run(n, s, o, r, l) {
      return new Promise((i, c) => {
        if (this.initialized) {
          c(
            new Error("Ffmpeg is already initialized and cannot be used again.")
          );
          return;
        }
        (this.initialized = !0),
          (this.onComplete = i),
          (this.onError = c),
          (this.onProgress = r),
          (this.onLog = l),
          this.postMessage(n, s, o);
      });
    }
  }
  return y;
});
