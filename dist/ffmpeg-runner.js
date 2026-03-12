/**
 * TikTok Downloader – extension-page FFmpeg runner.
 * Uses external helper iframe (loads in extension origin, not on TikTok page).
 */
(function () {
  "use strict";

  chrome.runtime.sendMessage({ type: "runnerReady" }, function () {
    if (chrome.runtime.lastError) {
      // ignore (e.g. no listener yet)
    }
  });

  chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
    if (request.action !== "runFFmpeg") return;

    const operationId = request.operationId;
    const targetTabId = request.targetTabId;
    const data = request.data || {};
    var format = data.format || "mp3";
    var filename = data.filename;

    chrome.runtime.sendMessage(
      { action: "getFFmpegVideoData", operationId, format, filename },
      function (res) {
        var err = chrome.runtime.lastError;
        if (err) {
          sendResponse({ success: false, error: err.message || "Failed to get video data" });
          return;
        }
        var raw = res && res.videoData;
        if (!raw) {
          sendResponse({ success: false, error: "No video data from background" });
          return;
        }
        var arrayBuffer = null;
        if (raw instanceof ArrayBuffer && raw.byteLength > 0) {
          arrayBuffer = raw.slice(0);
        } else if (raw && typeof raw.byteLength === "number" && raw.buffer instanceof ArrayBuffer) {
          arrayBuffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
        } else if (Array.isArray(raw) && raw.length > 0) {
          arrayBuffer = new ArrayBuffer(raw.length);
          new Uint8Array(arrayBuffer).set(raw);
        } else if (raw && typeof raw.length === "number" && raw.length > 0) {
          arrayBuffer = new ArrayBuffer(raw.length);
          var v = new Uint8Array(arrayBuffer);
          for (var k = 0; k < raw.length; k++) v[k] = raw[k];
        }
        if (!arrayBuffer || arrayBuffer.byteLength === 0) {
          sendResponse({ success: false, error: "Invalid or empty video data" });
          return;
        }
        runConversion(operationId, targetTabId, { videoData: arrayBuffer, format, filename }, sendResponse);
      },
    );
    return true;
  });

  function runConversion(operationId, targetTabId, payload, sendResponse) {

    const OPERATION_TIMEOUT_MS = 90000;
    let timeoutId = setTimeout(function () {
      timeoutId = null;
      cleanup();
      reportDone({ success: false, error: "Conversion timed out (FFmpeg may not have loaded)" });
    }, OPERATION_TIMEOUT_MS);

    function cleanup() {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      window.removeEventListener("message", listener);
      window.removeEventListener("message", errorListener);
    }

    function reportDone(result) {
      var payload = { success: result.success, error: result.error, filename: result.filename, mimeType: result.mimeType };
      if (result.processedData && result.processedData instanceof ArrayBuffer && result.processedData.byteLength > 0) {
        payload.processedData = Array.from(new Uint8Array(result.processedData));
      } else if (result.processedData) {
        payload.processedData = result.processedData;
      }
      try {
        sendResponse(payload);
      } catch (_) {}
      if (targetTabId) {
        chrome.runtime.sendMessage({
          type: "ffmpegConversionDone",
          operationId,
          targetTabId,
          success: payload.success,
          processedData: payload.processedData,
          filename: payload.filename,
          mimeType: payload.mimeType,
          error: payload.error,
        }, function () { if (chrome.runtime.lastError) {} });
      }
    }

    const listener = function (ev) {
      if (ev.source !== window || ev.data?.type !== "TIKTOK_FFMPEG_RESULT") return;
      if (ev.data.operationId !== operationId) return;
      cleanup();
      reportDone({
        success: true,
        processedData: ev.data.processedData,
        filename: ev.data.filename,
        mimeType: ev.data.mimeType,
      });
    };

    const errorListener = function (ev) {
      if (ev.source !== window || ev.data?.type !== "TIKTOK_FFMPEG_ERROR") return;
      if (ev.data.operationId !== operationId) return;
      cleanup();
      reportDone({ success: false, error: ev.data.error || "Conversion failed" });
    };

    window.addEventListener("message", listener);
    window.addEventListener("message", errorListener);

    if (typeof window.TikTokFFmpeg === "undefined" || typeof window.TikTokFFmpeg.handleOperation !== "function") {
      cleanup();
      reportDone({ success: false, error: "FFmpeg not loaded" });
      return;
    }

    window.TikTokFFmpeg.handleOperation(operationId, payload).catch(function (err) {
      cleanup();
      reportDone({ success: false, error: (err && err.message) || String(err) });
    });
  }
})();
