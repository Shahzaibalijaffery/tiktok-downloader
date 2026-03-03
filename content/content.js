// Content script orchestrator for TikTok pages
// Modules are loaded via manifest.json before this script
// This file coordinates initialization and message routing

const DEBUG = false; // Enable for debugging notifications
const pendingFfmpegDone = {}; // operationId -> { done } for ffmpegResult delivery (survives service worker restart)
const originalConsoleLog = console.log;
// Always log restore-related messages for debugging
const originalConsoleError = console.error;
// Global debug state (inspect via window.__dmDownloaderDebug)
const __dmDebugState = {
  loadedAt: Date.now(),
  lastRestore: null,
  lastRestoreError: null,
  lastStorageSnapshot: null,
  lastShowNotification: null,
  lastShowNotificationError: null,
};

console.log = (...args) => {
  // Always log restore and download notification messages
  const message = args[0]?.toString() || "";
  if (
    message.includes("restore") ||
    message.includes("Restoring") ||
    message.includes("download notification") ||
    message.includes("DM Download Button") ||
    message.includes("✅") ||
    message.includes("❌") ||
    message.includes("⚠️")
  ) {
    originalConsoleLog(...args);
  } else if (DEBUG) {
    originalConsoleLog(...args);
  }
};
console.error = (...args) => {
  originalConsoleError(...args);
};

// Get video URL from item (same structure as item_list API: video.PlayAddrStruct.UrlList)
function getVideoUrlFromItem(item) {
  const playAddr = item && item.video && item.video.PlayAddrStruct;
  if (!playAddr || !Array.isArray(playAddr.UrlList) || playAddr.UrlList.length === 0)
    return null;
  const list = playAddr.UrlList;
  for (let i = 0; i < list.length; i++) {
    const u = list[i];
    if (typeof u !== "string") continue;
    if (
      u.includes("webapp-prime.tiktok.com") &&
      u.includes("/video/") &&
      (u.includes("mime_type=video_mp4") || u.includes("video_mp4"))
    )
      return u;
  }
  return list[0];
}

// Append first videos from document (webapp.updated-items in __UNIVERSAL_DATA_FOR_REHYDRATION__).
// item_list API then adds more as the user scrolls.
function appendFirstVideosFromDocument() {
  const scriptEl = document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__");
  if (!scriptEl || !scriptEl.textContent) return;
  try {
    const data = JSON.parse(scriptEl.textContent);
    const updatedItems = data?.__DEFAULT_SCOPE__?.["webapp.updated-items"];
    if (!Array.isArray(updatedItems) || updatedItems.length === 0) return;
    const itemsToAppend = [];
    for (let i = 0; i < updatedItems.length; i++) {
      const item = updatedItems[i];
      if (!item?.video) continue;
      const url = getVideoUrlFromItem(item);
      if (!url) continue;
      itemsToAppend.push({
        url,
        title: typeof item.desc === "string" ? item.desc.trim() : "",
        id: item.id || null,
      });
    }
    if (itemsToAppend.length > 0 && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ action: "itemListAppend", items: itemsToAppend }, function () {
        if (chrome.runtime.lastError) {
          // ignore
        }
      });
    }
  } catch (_) {
    // ignore parse errors
  }
}

// Always log content script load (top frame only)
try {
  if (window.self === window.top) {
    originalConsoleLog("[DM Downloader] content script loaded", {
      href: window.location.href,
      readyState: document.readyState,
      ts: new Date().toISOString(),
    });
  }
} catch (e) {
  // ignore
}

// Catch unexpected errors (top frame only)
try {
  if (window.self === window.top) {
    window.addEventListener("error", (ev) => {
      __dmDebugState.lastRestoreError =
        __dmDebugState.lastRestoreError ||
        ev?.error?.message ||
        ev?.message ||
        "unknown error";
      originalConsoleError(
        "[DM Downloader] window.error",
        ev?.message || ev,
        ev?.error,
      );
    });
    window.addEventListener("unhandledrejection", (ev) => {
      __dmDebugState.lastRestoreError =
        __dmDebugState.lastRestoreError ||
        ev?.reason?.message ||
        String(ev?.reason) ||
        "unhandled rejection";
      originalConsoleError("[DM Downloader] unhandledrejection", ev?.reason);
    });
  }
} catch (e) {
  // ignore
}

// Expose debug helpers for you to run in DevTools console
try {
  if (window.self === window.top) {
    window.__dmDownloaderDebug = {
      state: __dmDebugState,
      forceRestore: () => {
        originalConsoleLog(
          "[DM Downloader] Restore disabled (downloads run in main world; no restore on refresh).",
        );
      },
      dumpStorageKeys: () =>
        new Promise((resolve) => {
          safeStorageGet(null, (items) => {
            const keys = Object.keys(items || {}).filter((k) =>
              k.startsWith("download"),
            );
            const summary = keys
              .sort()
              .map((k) => ({ key: k, value: items[k] }));
            __dmDebugState.lastStorageSnapshot = summary;
            originalConsoleLog(
              "[DM Downloader] storage snapshot (download* keys):",
              summary,
            );
            resolve(summary);
          });
        }),
      testNotification: () => {
        originalConsoleLog("[DM Downloader] testNotification()");
        try {
          if (typeof showDownloadNotification === "function") {
            showDownloadNotification(
              "TEST_" + Date.now(),
              "test.mp4",
              "Test notification",
              42,
              "",
              __dmDebugState,
            );
          }
        } catch (e) {
          __dmDebugState.lastShowNotificationError = e?.message || String(e);
          originalConsoleError("[DM Downloader] testNotification error", e);
        }
      },
      pingBackground: () =>
        new Promise((resolve) => {
          try {
            chrome.runtime.sendMessage({ action: "ping" }, (resp) => {
              const err = chrome.runtime.lastError?.message;
              originalConsoleLog("[DM Downloader] pingBackground result:", {
                resp,
                err,
              });
              resolve({ resp, err });
            });
          } catch (e) {
            originalConsoleError("[DM Downloader] pingBackground exception", e);
            resolve({ resp: null, err: e?.message || String(e) });
          }
        }),
    };
    originalConsoleLog(
      "[DM Downloader] Debug helpers ready: window.__dmDownloaderDebug",
    );
  }
} catch (e) {
  // ignore
}

let lastUrl = location.href;

function runYourScriptAgain() {
  console.log("[DM Downloader] runScriptAgain: running script again");
  if (window.self !== window.top) return;
  if (!isVideoPage()) return;
  document
    .querySelectorAll(
      ".dm-page-download-wrapper, #vimeo-downloader-page-button-wrapper",
    )
    .forEach((w) => w.remove());
  setTimeout(() => {
    if (!isVideoPage() || !isExtensionContextValid()) return;
    if (typeof injectDownloadButton === "function") {
      window.__dmInjectSource = "runScriptAgain";
      injectDownloadButton();
    }
  }, 2500);
}

// Inject item_list API interceptor into main world (top frame only) so we capture feed items and append URLs
(function injectItemListInterceptor() {
  if (window.self !== window.top) return;
  const src = chrome.runtime.getURL("content/item-list-intercept.js");
  if (document.querySelector('script[src="' + src + '"]')) return;
  const script = document.createElement("script");
  script.src = src;
  (document.documentElement || document.body).appendChild(script);
})();

// Run once
runYourScriptAgain();

// Detect URL changes
new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    console.log("URL changed:", lastUrl);
    runYourScriptAgain();
  }
}).observe(document, { childList: true, subtree: true });

// Listen for messages from background script to handle blob downloads and download notifications
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log("Content script received message:", request.action, request);

  // So background can detect that content script is loaded (e.g. before injecting into tab)
  if (request.action === "ping") {
    sendResponse({ pong: true });
    return false;
  }

  // FFmpeg result delivered via tab message (when runner sends ffmpegConversionDone – more reliable than sendResponse)
  if (request.action === "ffmpegResult") {
    const pending = pendingFfmpegDone[request.operationId];
    delete pendingFfmpegDone[request.operationId];
    if (pending && typeof pending.clearTimeout === "function") pending.clearTimeout();
    if (!pending || typeof pending.done !== "function") return false;
    try {
      if (request.success && request.processedData) {
        const name = request.filename || "audio.mp3";
        const type = request.mimeType || "audio/mpeg";
        var mp3Data = request.processedData;
        if (Array.isArray(mp3Data)) {
          var ab = new ArrayBuffer(mp3Data.length);
          new Uint8Array(ab).set(mp3Data);
          mp3Data = ab;
        }
        const blob = new Blob([mp3Data], { type });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        chrome.storage.local.set({
          [`downloadProgress_${request.operationId}`]: 100,
          [`downloadStatus_${request.operationId}`]: "Complete",
        });
        pending.done({ success: true });
      } else {
        chrome.storage.local.set({
          [`downloadProgress_${request.operationId}`]: 0,
          [`downloadStatus_${request.operationId}`]: request.error || "Conversion failed",
        });
        pending.done({ success: false, error: request.error || "Conversion failed" });
      }
    } catch (e) {
      pending.done({ success: false, error: (e && e.message) || String(e) });
    }
    return false;
  }

  // FFmpeg for MP3 runs in extension runner page (external helper). Always available for TikTok.
  if (request.action === "getFFmpegStatus") {
    sendResponse({
      available: true,
      message: "MP3 conversion uses extension FFmpeg helper",
    });
    return false;
  }

  // Background asks to try injecting the download button again (e.g. after 6s/12s when page was slow)
  if (request.action === "requestInjectButton") {
    if (
      window.self === window.top &&
      isVideoPage() &&
      typeof injectDownloadButton === "function"
    ) {
      injectDownloadButton();
    }
    sendResponse({ ok: true });
    return true;
  }

  // Feed: background can send feedVideoFromApi with videoId to inject button (legacy; TikTok uses direct video URL detection)
  if (request.action === "feedVideoFromApi" && request.videoId) {
    try {
      if (typeof injectFeedButtonForVideoId === "function") {
        injectFeedButtonForVideoId(request.videoId);
      }
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
    return true;
  }

  // Handle download start notification
  if (request.action === "downloadStarted") {
    console.log(
      "Download started notification received:",
      request.downloadId,
      request.filename,
      "isExisting:",
      request.isExisting,
    );
    const downloadId =
      request.downloadId ||
      `download_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const filename = request.filename || "video.mp4";
    const qualityLabel = request.qualityLabel || "";

    try {
      console.log(
        "Attempting to show notification for:",
        downloadId,
        filename,
        "quality:",
        qualityLabel,
      );
      console.log("Document body exists:", !!document.body);
      console.log("Document ready state:", document.readyState);

      // If this is an existing download, check current status first
      if (request.isExisting) {
        safeStorageGet(
          [`downloadProgress_${downloadId}`, `downloadStatus_${downloadId}`],
          (result) => {
            const progress = result[`downloadProgress_${downloadId}`];
            const status =
              result[`downloadStatus_${downloadId}`] || "Downloading...";

            if (progress !== undefined) {
              if (typeof showDownloadNotification === "function") {
                showDownloadNotification(
                  downloadId,
                  filename,
                  status,
                  progress,
                  qualityLabel,
                  __dmDebugState,
                );
              }
              if (typeof startDownloadProgressPolling === "function") {
                startDownloadProgressPolling(downloadId, filename);
              }
            } else {
              // No progress data yet, show initial notification
              if (typeof showDownloadNotification === "function") {
                showDownloadNotification(
                  downloadId,
                  filename,
                  "Preparing download...",
                  0,
                  qualityLabel,
                  __dmDebugState,
                );
              }
              if (typeof startDownloadProgressPolling === "function") {
                startDownloadProgressPolling(downloadId, filename);
              }
            }
          },
        );
      } else {
        // New download
        // Ensure body is ready
        if (!document.body) {
          console.log("Waiting for document.body...");
          setTimeout(() => {
            console.log("Retrying notification after body ready");
            if (typeof showDownloadNotification === "function") {
              showDownloadNotification(
                downloadId,
                filename,
                "Preparing download...",
                0,
                qualityLabel,
                __dmDebugState,
              );
            }
            if (typeof startDownloadProgressPolling === "function") {
              startDownloadProgressPolling(downloadId, filename);
            }
          }, 100);
        } else {
          console.log("Body ready, showing notification immediately");
          if (typeof showDownloadNotification === "function") {
            showDownloadNotification(
              downloadId,
              filename,
              "Preparing download...",
              0,
              qualityLabel,
              __dmDebugState,
            );
          }
          if (typeof startDownloadProgressPolling === "function") {
            startDownloadProgressPolling(downloadId, filename);
          }
        }
      }

      sendResponse({ success: true });
    } catch (error) {
      console.error("Error showing download notification:", error);
      console.error("Error stack:", error.stack);
      sendResponse({ success: false, error: error.message });
    }
    return true; // Keep channel open for async response
  }

  // Handle download completion notification
  if (request.action === "downloadCompleted") {
    console.log(
      "Download completed notification received:",
      request.downloadId,
      request.filename,
    );
    const downloadId = request.downloadId;
    const filename = request.filename || "video.mp4";

    // Stop polling for this download
    if (typeof stopDownloadProgressPolling === "function") {
      stopDownloadProgressPolling(downloadId);
    }

    // Update notification to show completion
    if (typeof updateDownloadNotification === "function") {
      updateDownloadNotification(
        downloadId,
        filename,
        "Download complete!",
        100,
      );
    }

    // Hide after delay
    setTimeout(() => {
      if (typeof hideDownloadNotification === "function") {
        hideDownloadNotification(downloadId);
      }
    }, 3000);

    sendResponse({ success: true });
    return true;
  }

  // Handle download blocked notification (max 2 downloads or large file >500 segments)
  if (request.action === "showDownloadBlockedNotification") {
    const message =
      request.message || "Please wait for the current download(s) to complete.";
    const reason = request.reason || "maxConcurrent";
    if (typeof showDownloadBlockedToast === "function") {
      showDownloadBlockedToast(message, reason);
    }
    sendResponse({ success: true });
    return true;
  }

  // Handle download cancellation notification
  if (request.action === "downloadCancelled") {
    console.log(
      "Download cancelled notification received:",
      request.downloadId,
    );
    const downloadId = request.downloadId;

    // Stop polling immediately
    if (typeof stopDownloadProgressPolling === "function") {
      stopDownloadProgressPolling(downloadId);
    }

    // Hide notification immediately
    if (typeof hideDownloadNotification === "function") {
      hideDownloadNotification(downloadId);
    }

    sendResponse({ success: true });
    return true;
  }

  // TikTok CDN: fetch video in main world (page context) so request has page cookies/Referer, then download via background.
  // Use script.src (not inline) to avoid CSP "script-src" blocking inline execution on TikTok.
  if (request.action === "fetchVideoInPageContext") {
    if (window.self !== window.top) {
      sendResponse({ success: false, error: "Run on main frame" });
      return true;
    }
    const { url, filename, downloadId, convertToMp3 } = request;
    if (!url || !filename) {
      sendResponse({ success: false, error: "Missing url or filename" });
      return true;
    }

    let responded = false;
    const done = (result) => {
      if (responded) return;
      responded = true;
      window.removeEventListener("message", onMessage);
      sendResponse(result);
    };
    const onMessage = (event) => {
      if (
        event.source !== window ||
        event.data?.type !== "TIKTOK_VIDEO_FETCH_RESULT" ||
        event.data?.downloadId !== downloadId
      )
        return;
      if (event.data.error) {
        done({ success: false, error: event.data.error });
        return;
      }
      const arrayBuffer = event.data.arrayBuffer;
      if (!arrayBuffer || !(arrayBuffer instanceof ArrayBuffer)) {
        done({ success: false, error: "No video data" });
        return;
      }
      if (arrayBuffer.byteLength === 0) {
        done({ success: false, error: "Video data is empty" });
        return;
      }
      try {
        if (convertToMp3) {
          // Run FFmpeg in extension page (not TikTok page – TikTok CSP blocks helper iframe)
          const mp3Filename = /\.mp3$/i.test(filename)
            ? filename
            : (filename.replace(/\.[^.]+$/, "") || "audio") + ".mp3";
          var videoDataToSend = arrayBuffer.slice(0);
          var totalLen = videoDataToSend.byteLength;
          if (totalLen !== arrayBuffer.byteLength) {
            done({ success: false, error: "Failed to copy video data" });
            return;
          }
          pendingFfmpegDone[downloadId] = { done };
          chrome.storage.local.set({
            [`downloadStatus_${downloadId}`]: "Converting to MP3...",
          });
          const mp3Timeout = setTimeout(function () {
            if (!pendingFfmpegDone[downloadId]) return;
            delete pendingFfmpegDone[downloadId];
            chrome.storage.local.set({
              [`downloadProgress_${downloadId}`]: 0,
              [`downloadStatus_${downloadId}`]: "Conversion timed out",
            });
            done({ success: false, error: "Conversion timed out" });
          }, 120000);
          pendingFfmpegDone[downloadId].clearTimeout = function () {
            clearTimeout(mp3Timeout);
          };
          function onRunResponse(response) {
            const p = pendingFfmpegDone[downloadId];
            if (chrome.runtime.lastError) {
              delete pendingFfmpegDone[downloadId];
              if (p && p.clearTimeout) p.clearTimeout();
              done({ success: false, error: chrome.runtime.lastError.message });
              return;
            }
            if (response && response.success && response.processedData) {
              delete pendingFfmpegDone[downloadId];
              if (p && p.clearTimeout) p.clearTimeout();
              try {
                const name = response.filename || "audio.mp3";
                const type = response.mimeType || "audio/mpeg";
                var mp3Data = response.processedData;
                if (Array.isArray(mp3Data)) {
                  var ab = new ArrayBuffer(mp3Data.length);
                  new Uint8Array(ab).set(mp3Data);
                  mp3Data = ab;
                }
                const blob = new Blob([mp3Data], { type });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = name;
                a.style.display = "none";
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                chrome.storage.local.set({
                  [`downloadProgress_${downloadId}`]: 100,
                  [`downloadStatus_${downloadId}`]: "Complete",
                });
                done({ success: true });
              } catch (e) {
                done({ success: false, error: (e && e.message) || String(e) });
              }
            } else if (response && !response.success) {
              delete pendingFfmpegDone[downloadId];
              if (p && p.clearTimeout) p.clearTimeout();
              done({
                success: false,
                error: (response && response.error) || "Conversion failed",
              });
            }
          }
          // Chrome extension messaging JSON-serializes; ArrayBuffer is lost. Send chunks as number[] so they survive.
          var CHUNK_SIZE = 64 * 1024;
          var chunks = [];
          for (var off = 0; off < totalLen; off += CHUNK_SIZE) {
            var slice = videoDataToSend.slice(off, off + CHUNK_SIZE);
            chunks.push(Array.from(new Uint8Array(slice)));
          }
          function sendNextChunk(index) {
            if (index >= chunks.length) {
              chrome.runtime.sendMessage(
                { action: "runFFmpegInExtension", operationId: downloadId, data: { format: "mp3", filename: mp3Filename } },
                onRunResponse,
              );
              return;
            }
            chrome.runtime.sendMessage(
              {
                action: "storeFFmpegVideoDataChunk",
                operationId: downloadId,
                totalChunks: chunks.length,
                totalByteLength: totalLen,
                chunkIndex: index,
                chunk: chunks[index],
              },
              function (storeResp) {
                var p = pendingFfmpegDone[downloadId];
                if (chrome.runtime.lastError) {
                  delete pendingFfmpegDone[downloadId];
                  if (p && p.clearTimeout) p.clearTimeout();
                  done({ success: false, error: chrome.runtime.lastError.message || "Failed to send video chunk" });
                  return;
                }
                if (!storeResp || !storeResp.success) {
                  delete pendingFfmpegDone[downloadId];
                  if (p && p.clearTimeout) p.clearTimeout();
                  done({ success: false, error: (storeResp && storeResp.error) || "Failed to store chunk" });
                  return;
                }
                if (storeResp.complete) {
                  sendNextChunk(chunks.length);
                } else {
                  sendNextChunk(index + 1);
                }
              },
            );
          }
          sendNextChunk(0);
          return;
        }
        // Direct download as MP4
        const blob = new Blob([arrayBuffer], { type: "video/mp4" });
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = blobUrl;
        const safeName = /\.mp4$/i.test(filename)
          ? filename
          : (filename.replace(/\.[^.]+$/, "") || filename || "tiktok_video") +
            ".mp4";
        a.download = safeName;
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(blobUrl);
        done({ success: true });
      } catch (err) {
        done({ success: false, error: (err && err.message) || String(err) });
      }
    };
    window.addEventListener("message", onMessage);
    setTimeout(
      () => done({ success: false, error: "Fetch timed out" }),
      120000,
    );

    const runFetch = () => {
      window.dispatchEvent(
        new CustomEvent("TIKTOK_DOWNLOADER_FETCH", {
          detail: { url, downloadId },
        }),
      );
    };
    if (window.__tiktokDownloaderFetchInjected) {
      runFetch();
    } else {
      const script = document.createElement("script");
      script.src = chrome.runtime.getURL("content/fetch-video-in-page.js");
      script.onload = () => {
        window.__tiktokDownloaderFetchInjected = true;
        script.remove();
        runFetch();
      };
      script.onerror = () => {
        done({ success: false, error: "Failed to load fetch script" });
      };
      (document.documentElement || document.body).appendChild(script);
    }
    return true;
  }

  return false;
});

// MP3 conversion runs in the extension's ffmpeg-runner page (external helper). No FFmpeg on TikTok page.

// Listen for FFmpeg result from extension runner (TIKTOK_FFMPEG_*)
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const t = event.data?.type;
  if (t === "TIKTOK_FFMPEG_RESULT") {
    const { operationId, processedData, filename, mimeType } = event.data;
    if (!processedData) return;
    var data = processedData;
    if (Array.isArray(data)) {
      var buf = new ArrayBuffer(data.length);
      new Uint8Array(buf).set(data);
      data = buf;
    }
    const name =
      filename ||
      (event.data.mimeType?.includes("audio") ? "audio.mp3" : "video.mp4");
    const type =
      mimeType || (name.endsWith(".mp3") ? "audio/mpeg" : "video/mp4");
    const blob = new Blob([data], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    if (operationId) {
      chrome.storage.local.set({
        [`downloadProgress_${operationId}`]: 100,
        [`downloadStatus_${operationId}`]: "Complete",
      });
    }
  } else if (t === "TIKTOK_FFMPEG_ERROR") {
    const { operationId, error } = event.data;
    if (operationId) {
      chrome.storage.local.set({
        [`downloadProgress_${operationId}`]: 0,
        [`downloadStatus_${operationId}`]: error || "Conversion failed",
      });
    }
  } else if (t === "TIKTOK_FFMPEG_PROGRESS") {
    const { operationId, progress, status } = event.data;
    if (operationId != null && progress != null) {
      chrome.storage.local.set({
        [`downloadProgress_${operationId}`]: progress,
        [`downloadStatus_${operationId}`]: status || "Converting...",
      });
    }
  } else if (
    t === "TIKTOK_ITEM_LIST" &&
    Array.isArray(event.data?.items) &&
    event.data.items.length > 0
  ) {
    chrome.runtime.sendMessage(
      { action: "itemListAppend", items: event.data.items },
      () => {
        if (chrome.runtime.lastError) {
          // ignore
        }
      },
    );
  }
});

// Append first videos from document (webapp.updated-items); item_list API adds more on scroll
if (window.self === window.top && location.hostname === "www.tiktok.com") {
  setTimeout(appendFirstVideosFromDocument, 150);
}
