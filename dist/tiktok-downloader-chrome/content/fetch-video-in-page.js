/**
 * Runs in the page (main world) to fetch TikTok CDN URLs with page cookies/Referer.
 * Reports progress via postMessage when Content-Length is available.
 */
(function () {
  window.addEventListener("TIKTOK_DOWNLOADER_FETCH", function (e) {
    var detail = e && e.detail;
    if (!detail || !detail.url || detail.downloadId === undefined) return;
    var url = detail.url;
    var downloadId = detail.downloadId;

    function fail(err) {
      window.postMessage(
        {
          type: "TIKTOK_VIDEO_FETCH_RESULT",
          downloadId: downloadId,
          error: (err && err.message) || String(err),
        },
        "*",
      );
    }

    fetch(url, { credentials: "include", mode: "cors" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        var total = 0;
        var cl = r.headers.get("Content-Length");
        if (cl) total = parseInt(cl, 10) || 0;
        var body = r.body;
        if (!body || typeof body.getReader !== "function") {
          return r.arrayBuffer().then(function (ab) {
            if (total) {
              window.postMessage(
                {
                  type: "TIKTOK_VIDEO_FETCH_PROGRESS",
                  downloadId: downloadId,
                  loaded: ab.byteLength,
                  total: total,
                },
                "*",
              );
            }
            window.postMessage(
              {
                type: "TIKTOK_VIDEO_FETCH_RESULT",
                downloadId: downloadId,
                arrayBuffer: ab,
              },
              "*",
              [ab],
            );
          });
        }
        var reader = body.getReader();
        var chunks = [];
        var loaded = 0;
        function reportProgress() {
          if (total > 0) {
            window.postMessage(
              {
                type: "TIKTOK_VIDEO_FETCH_PROGRESS",
                downloadId: downloadId,
                loaded: loaded,
                total: total,
              },
              "*",
            );
          }
        }
        function read() {
          return reader.read().then(function (result) {
            if (result.done) {
              var len = chunks.reduce(function (s, c) { return s + c.length; }, 0);
              var ab = new ArrayBuffer(len);
              var view = new Uint8Array(ab);
              var off = 0;
              for (var i = 0; i < chunks.length; i++) {
                view.set(chunks[i], off);
                off += chunks[i].length;
              }
              reportProgress();
              window.postMessage(
                {
                  type: "TIKTOK_VIDEO_FETCH_RESULT",
                  downloadId: downloadId,
                  arrayBuffer: ab,
                },
                "*",
                [ab],
              );
              return;
            }
            chunks.push(result.value);
            loaded += result.value.length;
            reportProgress();
            return read();
          });
        }
        return read();
      })
      .catch(fail);
  });
})();
