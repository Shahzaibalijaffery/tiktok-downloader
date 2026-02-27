/**
 * Runs in the page (main world) to fetch TikTok CDN URLs with page cookies/Referer.
 * Loaded via script.src to avoid CSP "inline script" block. Receives url + downloadId via custom event.
 */
(function () {
  window.addEventListener("TIKTOK_DOWNLOADER_FETCH", function (e) {
    var detail = e && e.detail;
    if (!detail || !detail.url || detail.downloadId === undefined) return;
    var url = detail.url;
    var downloadId = detail.downloadId;
    fetch(url, { credentials: "include", mode: "cors" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.arrayBuffer();
      })
      .then(function (ab) {
        window.postMessage(
          { type: "TIKTOK_VIDEO_FETCH_RESULT", downloadId: downloadId, arrayBuffer: ab },
          "*",
          [ab]
        );
      })
      .catch(function (err) {
        window.postMessage(
          {
            type: "TIKTOK_VIDEO_FETCH_RESULT",
            downloadId: downloadId,
            error: (err && err.message) || String(err),
          },
          "*"
        );
      });
  });
})();
