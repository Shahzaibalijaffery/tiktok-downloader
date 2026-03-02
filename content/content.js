// Content script orchestrator for TikTok pages
// Modules are loaded via manifest.json before this script
// This file coordinates initialization and message routing

const DEBUG = false; // Enable for debugging notifications
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
    const { url, filename, downloadId } = request;
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
      // Trigger download in content script with blob URL so we never send large data through messaging
      // (Chrome message passing can drop or fail on large ArrayBuffers to the service worker)
      try {
        const blob = new Blob([arrayBuffer], { type: "video/mp4" });
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = blobUrl;
        // Ensure .mp4 extension so the file plays (browser may otherwise save as generic "video" type)
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

// Inject FFmpeg helper + webpage-ffmpeg into main world (once)
(function injectFFmpegScripts() {
  if (window.__dmFFmpegInjected) return;
  if (window.self !== window.top) return;
  window.__dmFFmpegInjected = true;

  function injectScript(src, onLoad) {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL(src);
    if (onLoad) script.onload = onLoad;
    (document.head || document.documentElement).appendChild(script);
  }

  // Use .js copy: Firefox blocks script loads with .cjs extension; build provides ffmpeg-helper-umd.js
  injectScript("js/ffmpeg-helper-umd.js", () => {
    injectScript("js/webpage-ffmpeg.js");
  });
})();

// Listen for FFmpeg result from main world and trigger download
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const t = event.data?.type;
  if (t === "DAILYMOTION_FFMPEG_RESULT") {
    const { operationId, processedData, filename, mimeType } = event.data;
    if (!processedData) return;
    const name =
      filename ||
      (event.data.mimeType?.includes("audio") ? "audio.mp3" : "video.mp4");
    const type =
      mimeType || (name.endsWith(".mp3") ? "audio/mpeg" : "video/mp4");
    const blob = new Blob([processedData], { type });
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
  } else if (t === "DAILYMOTION_FFMPEG_ERROR") {
    const { operationId, error } = event.data;
    if (operationId) {
      chrome.storage.local.set({
        [`downloadProgress_${operationId}`]: 0,
        [`downloadStatus_${operationId}`]: error || "Conversion failed",
      });
    }
  } else if (t === "DAILYMOTION_FFMPEG_PROGRESS") {
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
