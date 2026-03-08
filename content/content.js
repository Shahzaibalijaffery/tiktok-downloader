// Content script orchestrator for TikTok pages
// Modules are loaded via manifest.json before this script
// This file coordinates initialization and message routing

const pendingFfmpegDone = {}; // operationId -> { done } for ffmpegResult delivery (survives service worker restart)
const __dmDebugState = {
  loadedAt: Date.now(),
  lastRestore: null,
  lastRestoreError: null,
  lastStorageSnapshot: null,
  lastShowNotification: null,
  lastShowNotificationError: null,
};

/** Only console in extension: hydration / document API response data */
function logHydrationAPI(source, dataWeGot, dataWeStore) {
  if (typeof console === "undefined" || typeof console.log !== "function")
    return;
  if (!dataWeStore || (Array.isArray(dataWeStore) && dataWeStore.length === 0))
    return;
  var data = Array.isArray(dataWeStore) ? dataWeStore : dataWeStore;
  console.log(
    "[TikTok DL Hydration] document API response — source:",
    source,
    "| data:",
    data,
  );
}

// Get video URL from item (same structure as item_list API: video.PlayAddrStruct.UrlList)
function getVideoUrlFromItem(item) {
  const playAddr = item && item.video && item.video.PlayAddrStruct;
  if (
    !playAddr ||
    !Array.isArray(playAddr.UrlList) ||
    playAddr.UrlList.length === 0
  )
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

function isVideoWatchPage() {
  const path = (typeof location !== "undefined" && location.pathname) || "";
  return /^\/@[^/]+\/video\/\d+/.test(path);
}

function getVideoIdFromPath() {
  const path = (typeof location !== "undefined" && location.pathname) || "";
  const m = path.match(/\/video\/(\d+)/);
  return m ? m[1] : null;
}

// Recursively find video items (with PlayAddrStruct) in hydration data.
function deepCollectVideoItems(data, out, seen) {
  if (!data || seen.has(data)) return;
  seen.add(data);
  if (Array.isArray(data)) {
    for (let i = 0; i < data.length; i++)
      deepCollectVideoItems(data[i], out, seen);
    return;
  }
  if (typeof data !== "object") return;
  if (data.video && data.video.PlayAddrStruct) {
    const url = getVideoUrlFromItem(data);
    if (url) {
      out.push({
        url,
        title: typeof data.desc === "string" ? data.desc.trim() : "",
        id: data.id || null,
      });
    }
    return;
  }
  for (const k of Object.keys(data)) deepCollectVideoItems(data[k], out, seen);
}

// Parse __UNIVERSAL_DATA_FOR_REHYDRATION__ on every page: collect from webapp.updated-items, ItemModule, video-detail, ItemList, and deep collect.
// Fallback: if no element with that id, search all script tags for same payload (TikTok sometimes uses different id or no id).
function getHydrationScriptText() {
  var el = document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__");
  if (el && el.textContent && el.textContent.trim().length > 0)
    return el.textContent;
  var scripts = document.querySelectorAll(
    'script[id*="REHYDRATION"], script[id*="rehydration"], script[type="application/json"]',
  );
  for (var i = 0; i < scripts.length; i++) {
    var t = scripts[i].textContent;
    if (
      t &&
      t.trim().length > 0 &&
      (t.indexOf("__DEFAULT_SCOPE__") !== -1 ||
        t.indexOf("webapp.updated-items") !== -1 ||
        t.indexOf("ItemModule") !== -1)
    )
      return t;
  }
  scripts = document.getElementsByTagName("script");
  for (i = 0; i < scripts.length; i++) {
    t = scripts[i].textContent;
    if (
      t &&
      t.length > 500 &&
      (t.indexOf("__DEFAULT_SCOPE__") !== -1 ||
        t.indexOf('"ItemModule"') !== -1 ||
        t.indexOf("webapp.updated-items") !== -1)
    ) {
      return t;
    }
  }
  return null;
}

function getItemsFromHydration() {
  const scriptText = getHydrationScriptText();
  if (!scriptText) {
    if (
      !document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__") &&
      !_hydrationPollingInterval
    )
      startHydrationPolling();
    return [];
  }
  try {
    const data = JSON.parse(scriptText);
    const path = (typeof location !== "undefined" && location.pathname) || "";
    const videoIdFromUrl = getVideoIdFromPath();

    const out = [];
    const seenIds = new Set();

    function pushItem(item) {
      if (!item?.video) return;
      const url = getVideoUrlFromItem(item);
      if (!url) return;
      const id = item.id != null ? String(item.id) : videoIdFromUrl || null;
      if (id && seenIds.has(id)) return;
      if (id) seenIds.add(id);
      out.push({
        url,
        title: typeof item.desc === "string" ? item.desc.trim() : "",
        id: id || null,
      });
    }

    const scope = data?.__DEFAULT_SCOPE__ || data?.data || data?.result || data;

    // 1) webapp.updated-items (feed-style, any page)
    const updated = scope?.["webapp.updated-items"];
    if (Array.isArray(updated)) {
      for (let i = 0; i < updated.length; i++) pushItem(updated[i]);
    }

    // 2) ItemModule (video-style, any page)
    const itemModule = scope?.ItemModule || scope?.itemModule;
    if (itemModule && typeof itemModule === "object") {
      if (videoIdFromUrl) {
        const single =
          itemModule[videoIdFromUrl] || itemModule[String(videoIdFromUrl)];
        if (single && single.video) pushItem(single);
      }
      Object.keys(itemModule).forEach((k) => pushItem(itemModule[k]));
    }

    // 3) webapp.video-detail / video-detail-more (watch page)
    const videoDetail =
      scope?.["webapp.video-detail"] || scope?.["webapp.video-detail-more"];
    if (videoDetail?.itemInfo?.itemStruct) {
      let itemStruct = videoDetail.itemInfo.itemStruct;
      if (videoDetail.itemInfo.id != null)
        itemStruct = Object.assign({}, itemStruct, {
          id: videoDetail.itemInfo.id,
        });
      pushItem(itemStruct);
    }

    // 4) ItemList / item_list and other list keys
    const listKeys = [
      "ItemList",
      "item_list",
      "recommendList",
      "videoList",
      "list",
      "items",
      "itemList",
      "feed",
    ];
    for (let k = 0; k < listKeys.length; k++) {
      const arr = scope?.[listKeys[k]];
      if (Array.isArray(arr)) {
        for (let i = 0; i < arr.length; i++) pushItem(arr[i]);
      }
    }

    // 4b) Top-level data.data / data.result item lists (alternative API shape)
    const alt = data?.data || data?.result;
    if (alt && typeof alt === "object") {
      for (let k = 0; k < listKeys.length; k++) {
        const arr = alt[listKeys[k]];
        if (Array.isArray(arr)) {
          for (let i = 0; i < arr.length; i++) pushItem(arr[i]);
        }
      }
    }

    // 5) Deep collect if we still have nothing or for extra items (output is already { url, title, id })
    if (out.length === 0 || videoIdFromUrl) {
      const deepOut = [];
      deepCollectVideoItems(data, deepOut, new Set());
      if (deepOut.length > 0 && videoIdFromUrl && !out.length)
        deepOut[0].id = deepOut[0].id || videoIdFromUrl;
      for (const e of deepOut) {
        const id = e.id != null ? String(e.id) : videoIdFromUrl || null;
        if (id && seenIds.has(id)) continue;
        if (id) seenIds.add(id);
        out.push({ url: e.url, title: e.title || "", id: id || null });
      }
    }

    if (out.length > 0)
      logHydrationAPI("__UNIVERSAL_DATA_FOR_REHYDRATION__", out, out);
    return out;
  } catch (e) {
    return [];
  }
}

function appendFirstVideosFromDocument() {
  const itemsToAppend = getItemsFromHydration();
  if (itemsToAppend.length === 0) return;
  if (chrome.runtime?.sendMessage) {
    chrome.runtime.sendMessage(
      { action: "itemListAppend", items: itemsToAppend },
      function () {
        if (chrome.runtime.lastError) {
          // ignore
        }
      },
    );
  }
}

// Catch unexpected errors (top frame only) – update debug state only, no console
try {
  if (window.self === window.top) {
    window.addEventListener("error", (ev) => {
      __dmDebugState.lastRestoreError =
        __dmDebugState.lastRestoreError ||
        ev?.error?.message ||
        ev?.message ||
        "unknown error";
    });
    window.addEventListener("unhandledrejection", (ev) => {
      __dmDebugState.lastRestoreError =
        __dmDebugState.lastRestoreError ||
        ev?.reason?.message ||
        String(ev?.reason) ||
        "unhandled rejection";
    });
  }
} catch (e) {
  // ignore
}

try {
  if (window.self === window.top) {
    window.__dmDownloaderDebug = {
      state: __dmDebugState,
      forceRestore: () => {},
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
            resolve(summary);
          });
        }),
      testNotification: () => {
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
        }
      },
      pingBackground: () =>
        new Promise((resolve) => {
          try {
            chrome.runtime.sendMessage({ action: "ping" }, (resp) => {
              const err = chrome.runtime.lastError?.message;
              resolve({ resp, err });
            });
          } catch (e) {
            resolve({ resp: null, err: e?.message || String(e) });
          }
        }),
    };
  }
} catch (e) {
  // ignore
}

let lastUrl = location.href;
var hydrationScriptObserver = null;

function runYourScriptAgain() {
  /* Only feed button is used; no watch-page button to re-inject */
}

/** Run hydration extraction multiple times after navigation/reload so we catch cache/async updates */
function scheduleHydrationAfterNavigation() {
  runHydrationAndMaybeInjectButton();
  [
    0, 50, 100, 200, 400, 1000, 2500, 5000, 8000, 12000, 15000, 20000, 25000,
  ].forEach((ms) => setTimeout(runHydrationAndMaybeInjectButton, ms));
  startHydrationFastPoll();
  startHydrationPolling();
}

var _hydrationPollingInterval = null;
var _hydrationFastPollInterval = null;

/** Fast poll every 100ms for 2s right after load — catch __UNIVERSAL_DATA_FOR_REHYDRATION__ as soon as it’s filled. */
function startHydrationFastPoll() {
  if (_hydrationFastPollInterval) return;
  var count = 0;
  var max = 20;
  _hydrationFastPollInterval = setInterval(function () {
    runHydrationAndMaybeInjectButton();
    count += 1;
    if (count >= max) {
      clearInterval(_hydrationFastPollInterval);
      _hydrationFastPollInterval = null;
    }
  }, 100);
}

/** Poll for hydration data every 2s for 26s (catches late API when reload/navigate). Only one active at a time. */
function startHydrationPolling() {
  if (_hydrationPollingInterval) clearInterval(_hydrationPollingInterval);
  var count = 0;
  var max = 13;
  _hydrationPollingInterval = setInterval(function () {
    runHydrationAndMaybeInjectButton();
    count += 1;
    if (count >= max) {
      clearInterval(_hydrationPollingInterval);
      _hydrationPollingInterval = null;
    }
  }, 2000);
}

/** Start observing the hydration script element so when TikTok updates its content we re-extract */
function observeHydrationScriptContent() {
  var scriptEl = document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__");
  if (!scriptEl || hydrationScriptObserver) return;
  hydrationScriptObserver = new MutationObserver(function () {
    runHydrationAndMaybeInjectButton();
  });
  hydrationScriptObserver.observe(scriptEl, {
    characterData: true,
    characterDataOldValue: false,
    childList: true,
    subtree: true,
  });
}

// Inject item_list + hydration API interceptor on all tiktok.com pages. Early inject runs at document_start; this is fallback.
(function injectItemListInterceptor() {
  if (window.self !== window.top) return;
  const src = chrome.runtime.getURL("content/item-list-intercept.js");
  if (document.querySelector('script[src="' + src + '"]')) return;
  const script = document.createElement("script");
  script.src = src;
  (document.documentElement || document.body).appendChild(script);
})();

runYourScriptAgain();
new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    runYourScriptAgain();
    if (hydrationScriptObserver) {
      hydrationScriptObserver.disconnect();
      hydrationScriptObserver = null;
    }
    scheduleHydrationAfterNavigation();
    setTimeout(function () {
      observeHydrationScriptContent();
    }, 500);
  }
}).observe(document, { childList: true, subtree: true });

// Listen for messages from background script to handle blob downloads and download notifications
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // So background can detect that content script is loaded (e.g. before injecting into tab)
  if (request.action === "ping") {
    sendResponse({ pong: true });
    return false;
  }

  // FFmpeg result delivered via tab message (when runner sends ffmpegConversionDone – more reliable than sendResponse)
  if (request.action === "ffmpegResult") {
    const pending = pendingFfmpegDone[request.operationId];
    delete pendingFfmpegDone[request.operationId];
    if (pending && typeof pending.clearTimeout === "function")
      pending.clearTimeout();
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
          [`downloadStatus_${request.operationId}`]:
            request.error || "Conversion failed",
        });
        pending.done({
          success: false,
          error: request.error || "Conversion failed",
        });
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

  // Background asks to try injecting the download button (we only use feed button; no-op)
  if (request.action === "requestInjectButton") {
    sendResponse({ ok: true });
    return true;
  }

  // Popup requested re-extraction (e.g. no data yet after navigate) – re-run hydration and feed injection
  if (request.action === "triggerVideoExtraction") {
    if (window.self === window.top) {
      runHydrationAndMaybeInjectButton();
      if (typeof window.__dmRunDesktopFeedInjection === "function") {
        window.__dmRunDesktopFeedInjection();
      }
    }
    sendResponse({ ok: true });
    return true;
  }

  // Handle download start notification
  if (request.action === "downloadStarted") {
    const downloadId =
      request.downloadId ||
      `download_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const filename = request.filename || "video.mp4";
    const qualityLabel = request.qualityLabel || "";

    try {
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
          setTimeout(() => {
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
      sendResponse({ success: false, error: error.message });
    }
    return true; // Keep channel open for async response
  }

  // Handle download completion notification
  if (request.action === "downloadCompleted") {
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
                {
                  action: "runFFmpegInExtension",
                  operationId: downloadId,
                  data: { format: "mp3", filename: mp3Filename },
                },
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
                  done({
                    success: false,
                    error:
                      chrome.runtime.lastError.message ||
                      "Failed to send video chunk",
                  });
                  return;
                }
                if (!storeResp || !storeResp.success) {
                  delete pendingFfmpegDone[downloadId];
                  if (p && p.clearTimeout) p.clearTimeout();
                  done({
                    success: false,
                    error:
                      (storeResp && storeResp.error) || "Failed to store chunk",
                  });
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
        // Direct download as MP4: use background chrome.downloads so progress hits 100% when file is written
        const safeName = /\.mp4$/i.test(filename)
          ? filename
          : (filename.replace(/\.[^.]+$/, "") || filename || "tiktok_video") +
            ".mp4";
        chrome.runtime.sendMessage(
          {
            action: "downloadFile",
            downloadId,
            filename: safeName,
            data: arrayBuffer,
            mimeType: "video/mp4",
          },
          (response) => {
            if (chrome.runtime.lastError || !response?.success) {
              // Fallback: blob + click (e.g. message too large); set 100 after storage write
              const blob = new Blob([arrayBuffer], { type: "video/mp4" });
              const blobUrl = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = blobUrl;
              a.download = safeName;
              a.style.display = "none";
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              URL.revokeObjectURL(blobUrl);
              chrome.storage.local.set(
                {
                  [`downloadProgress_${downloadId}`]: 100,
                  [`downloadStatus_${downloadId}`]: "Complete",
                },
                () => done({ success: true }),
              );
            } else {
              done({ success: true });
            }
          },
        );
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
  } else if (t === "TIKTOK_VIDEO_FETCH_PROGRESS") {
    const { downloadId, loaded, total } = event.data;
    if (downloadId == null) return;
    const pct =
      total > 0 ? Math.min(99, Math.round((loaded / total) * 100)) : undefined;
    chrome.storage.local.set({
      [`downloadProgress_${downloadId}`]: pct !== undefined ? pct : 0,
      [`downloadStatus_${downloadId}`]: "Downloading...",
    });
  } else if (
    t === "TIKTOK_ITEM_LIST" &&
    Array.isArray(event.data?.items) &&
    event.data.items.length > 0
  ) {
    const items = event.data.items;
    logHydrationAPI("item_list API", items, items);
    chrome.runtime.sendMessage(
      { action: "itemListAppend", items: items },
      function () {},
    );
  }
});

// On video watch pages we only append once per page to avoid repeated itemListAppend and MutationObserver spam.
var lastHydrationAppendedPath = null;
var videoPageHydrationObserver = null;

function runHydrationAndMaybeInjectButton() {
  if (isVideoWatchPage()) {
    if (lastHydrationAppendedPath === location.pathname) return;
  }
  const itemsToAppend = getItemsFromHydration();
  if (itemsToAppend.length === 0) return;
  if (chrome.runtime?.sendMessage) {
    chrome.runtime.sendMessage(
      { action: "itemListAppend", items: itemsToAppend },
      function () {
        if (chrome.runtime.lastError) return;
        if (isVideoWatchPage() && itemsToAppend.length > 0) {
          lastHydrationAppendedPath = location.pathname;
          if (videoPageHydrationObserver) {
            videoPageHydrationObserver.disconnect();
            videoPageHydrationObserver = null;
          }
        }
      },
    );
  }
}

if (window.self === window.top) {
  runHydrationAndMaybeInjectButton();
  [0, 50, 100, 200, 150, 400, 800, 1200].forEach((ms) =>
    setTimeout(runHydrationAndMaybeInjectButton, ms),
  );
  [2500, 5000, 8000, 12000, 15000, 20000, 25000].forEach((ms) =>
    setTimeout(runHydrationAndMaybeInjectButton, ms),
  );
  startHydrationFastPoll();
  startHydrationPolling();
  var hydrationObserver = new MutationObserver(function (mutations) {
    var el = document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__");
    if (el) {
      runHydrationAndMaybeInjectButton();
      observeHydrationScriptContent();
      return;
    }
    for (var i = 0; i < mutations.length; i++) {
      var list = mutations[i].removedNodes;
      if (!list || list.length === 0) continue;
      for (var j = 0; j < list.length; j++) {
        var node = list[j];
        if (!node) continue;
        if (
          node.id === "__UNIVERSAL_DATA_FOR_REHYDRATION__" ||
          (node.querySelector &&
            node.querySelector("#__UNIVERSAL_DATA_FOR_REHYDRATION__"))
        ) {
          if (hydrationScriptObserver) {
            hydrationScriptObserver.disconnect();
            hydrationScriptObserver = null;
          }
          scheduleHydrationAfterNavigation();
          setTimeout(observeHydrationScriptContent, 500);
          return;
        }
      }
    }
  });
  hydrationObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  if (document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__")) {
    runHydrationAndMaybeInjectButton();
    observeHydrationScriptContent();
  }
  window.addEventListener("load", function () {
    runHydrationAndMaybeInjectButton();
    [100, 300, 600, 1000, 2500].forEach((ms) =>
      setTimeout(runHydrationAndMaybeInjectButton, ms),
    );
    startHydrationFastPoll();
  });
  window.addEventListener("pageshow", function (ev) {
    if (ev.persisted) {
      scheduleHydrationAfterNavigation();
      setTimeout(observeHydrationScriptContent, 300);
    }
  });
  window.addEventListener("popstate", function () {
    scheduleHydrationAfterNavigation();
    setTimeout(observeHydrationScriptContent, 300);
  });
}
