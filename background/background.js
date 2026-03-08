// In Chrome (service worker) we use importScripts. In Firefox (background.scripts) the manifest loads these first.
if (typeof importScripts !== "undefined") {
  importScripts(
    "/scripts/utils.js",
    "/scripts/storage.js",
    "/scripts/messaging.js",
    "/background/state.js",
    "/background/videoData.js",
    "/background/cancelDownload.js",
    "/background/startDownload.js",
  );
}

function injectContentScriptIntoTab(tabId) {
  if (!chrome.scripting || !chrome.scripting.executeScript)
    return Promise.resolve();
  return chrome.scripting
    .executeScript({
      target: { tabId },
      files: CONTENT_SCRIPT_FILES,
    })
    .then(() => {
      // Content script will try at ~4.5s; if DOM wasn't ready, request again at 6s and 12s
      INJECT_BUTTON_RETRY_DELAYS_MS.forEach((delayMs) => {
        setTimeout(() => {
          chrome.tabs.sendMessage(
            tabId,
            { action: "requestInjectButton" },
            () => {
              if (chrome.runtime.lastError) {
                // Tab closed or script not ready; ignore
              }
            },
          );
        }, delayMs);
      });
    })
    .catch(() => {});
}

// On install/update: inject content scripts into all existing TikTok tabs so the download button appears without refresh
chrome.runtime.onInstalled.addListener((details) => {
  if (!chrome.scripting || !chrome.scripting.executeScript) return;
  chrome.tabs.query({ url: "https://www.tiktok.com/*" }, (tabs) => {
    tabs.forEach((tab) => {
      if (tab.id) injectContentScriptIntoTab(tab.id);
    });
  });
});

// Video URLs are collected only via item_list API interception in the content script (itemListAppend).

// FFmpeg runner tab (extension page): avoid running helper iframe on TikTok (CSP blocks it)
let ffmpegRunnerTabId = null;
/** tabId -> visible video ID (from DOM). Popup uses this to show the focused video. */
var visibleVideoIdByTab = Object.create(null);
const ffmpegRunnerReadyQueue = [];
const ffmpegResponseTimeouts = {};
const ffmpegPendingVideoData = {};
const ffmpegPendingChunks = {};
/** chrome.downloads id -> { ourDownloadId, blobUrl } so we set progress 100 when file is written. */
const blobDownloadByChromeId = new Map();
// Extension messaging does not preserve ArrayBuffer (content↔background, background↔runner). We send binary as number[] and reconstruct ArrayBuffer on receive.

// Listen for messages from content script or popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Runner page signals ready (so we can send runFFmpeg)
  if (request.type === "runnerReady") {
    if (sender && sender.tab && sender.tab.id) {
      ffmpegRunnerTabId = sender.tab.id;
    }
    ffmpegRunnerReadyQueue.forEach(function (r) {
      r();
    });
    ffmpegRunnerReadyQueue.length = 0;
    return false;
  }

  // Handle ping to wake up service worker
  if (request.action === "ping") {
    sendResponse({ success: true });
    return true;
  }

  if (request.action === "setVisibleVideoId") {
    const tabId = sender.tab && sender.tab.id;
    if (tabId != null && request.videoId != null && String(request.videoId).trim() !== "") {
      visibleVideoIdByTab[tabId] = String(request.videoId);
    }
    return false;
  }

  if (request.action === "getVideoData") {
    let tabId = request.tabId;
    if (!tabId && sender && sender.tab && sender.tab.id) {
      tabId = sender.tab.id;
    }

    (async () => {
      let raw = videoData[tabId] || { items: [] };
      let items = Array.isArray(raw.items) ? raw.items : [];
      if (items.length === 0 && tabId != null) {
        try {
          const key = "videoData_" + tabId;
          const stored = await new Promise((resolve) =>
            chrome.storage.local.get(key, (o) => resolve(o[key])),
          );
          if (
            stored &&
            Array.isArray(stored.items) &&
            stored.items.length > 0
          ) {
            items = stored.items;
          }
        } catch (_) {}
      }
      const requestedVideoId = request.videoId != null ? String(request.videoId) : undefined;
      const visibleVideoId = tabId != null ? visibleVideoIdByTab[tabId] : undefined;
      const videoIdToUse = requestedVideoId || visibleVideoId;
      let singleItem = null;
      if (videoIdToUse) {
        for (let i = 0; i < items.length; i++) {
          if (items[i] && String(items[i].id) === videoIdToUse) {
            singleItem = items[i];
            break;
          }
        }
      }
      const itemsToUse = singleItem ? [singleItem] : items;
      const validItems = itemsToUse.filter((it) => it && it.url);
      const urls = validItems.map((it) => ({
        url: it.url,
        type: "mp4",
        timestamp: Date.now(),
        fromNetworkRequest: true,
        videoTitle: it.title || null,
        videoId: it.id || null,
        fileSize: null,
      }));
      const last = validItems[validItems.length - 1] || null;
      const videoIds = {};
      for (var i = 0; i < validItems.length; i++) {
        var it = validItems[i];
        if (it && it.id != null)
          videoIds[String(it.id)] = { title: it.title || "" };
      }
      const data = {
        urls,
        activeUrl: last ? last.url : null,
        videoTitle: last ? last.title : null,
        videoIds: videoIds,
      };

      if (tabId) {
        updateBadge(tabId);
      }

      sendResponse({ videoData: data });
    })();
    return true;
  }

  if (request.action === "getStoredVideoIds") {
    let tabId = request.tabId;
    if (tabId == null && sender && sender.tab && sender.tab.id) {
      tabId = sender.tab.id;
    }
    (async () => {
      let items = [];
      const raw = videoData[tabId];
      if (raw && Array.isArray(raw.items)) {
        items = raw.items;
      }
      if (items.length === 0 && tabId != null) {
        try {
          const key = "videoData_" + tabId;
          const stored = await new Promise((resolve) =>
            chrome.storage.local.get(key, (o) => resolve(o[key])),
          );
          if (stored && Array.isArray(stored.items)) {
            items = stored.items;
          }
        } catch (_) {}
      }
      const videoIds = items
        .filter((it) => it && it.id != null)
        .map((it) => String(it.id));
      sendResponse({ videoIds });
    })();
    return true;
  }

  if (request.action === "itemListAppend") {
    const tabId = sender.tab && sender.tab.id;
    if (!tabId || !Array.isArray(request.items) || request.items.length === 0) {
      sendResponse({ success: false });
      return false;
    }
    appendItemList(tabId, request.items);
    persistVideoDataForTab(tabId);
    sendResponse({ success: true });
    return false;
  } else if (request.action === "getDownloadInfo") {
    const info = downloadInfo.get(request.downloadId) || null;
    sendResponse({ info });
  } else if (request.action === "getFFmpegVideoData") {
    var opId = request.operationId;
    var buf = opId != null ? ffmpegPendingVideoData[opId] : undefined;
    if (opId != null) delete ffmpegPendingVideoData[opId];
    // ArrayBuffer does not survive sendMessage to runner tab; send as number[] so runner can reconstruct.
    var payload =
      buf && buf.byteLength > 0 ? Array.from(new Uint8Array(buf)) : null;
    sendResponse({
      videoData: payload,
      format: request.format,
      filename: request.filename,
    });
    return false;
  } else if (request.action === "storeFFmpegVideoDataChunk") {
    var opId = request.operationId;
    var chunkIndex = request.chunkIndex;
    var totalChunks = request.totalChunks;
    var totalByteLength = request.totalByteLength;
    var chunk = request.chunk;
    if (
      opId == null ||
      totalChunks == null ||
      totalByteLength == null ||
      chunkIndex == null
    ) {
      sendResponse({ success: false, error: "Missing chunk params" });
      return false;
    }
    // Extension messaging JSON-serializes: ArrayBuffer is lost. Content script sends chunk as number[].
    var isChunkValid = false;
    if (
      Array.isArray(chunk) &&
      chunk.length > 0 &&
      chunk.length <= 50 * 1024 * 1024
    ) {
      try {
        var ab = new ArrayBuffer(chunk.length);
        new Uint8Array(ab).set(chunk);
        chunk = ab;
        isChunkValid = true;
      } catch (_) {}
    }
    if (
      !isChunkValid &&
      chunk &&
      typeof chunk.length === "number" &&
      chunk.length > 0 &&
      chunk.length <= 50 * 1024 * 1024
    ) {
      try {
        var ab2 = new ArrayBuffer(chunk.length);
        var view2 = new Uint8Array(ab2);
        for (var j = 0; j < chunk.length; j++) view2[j] = chunk[j];
        chunk = ab2;
        isChunkValid = true;
      } catch (_) {}
    }
    if (!isChunkValid) {
      sendResponse({ success: false, error: "Invalid chunk" });
      return false;
    }
    if (chunkIndex === 0) {
      ffmpegPendingChunks[opId] = {
        totalChunks: totalChunks,
        totalByteLength: totalByteLength,
        chunks: [],
      };
    }
    var pending = ffmpegPendingChunks[opId];
    if (!pending || chunkIndex !== pending.chunks.length) {
      sendResponse({ success: false, error: "Chunk order mismatch" });
      return false;
    }
    pending.chunks.push(chunk);
    var complete = pending.chunks.length === pending.totalChunks;
    if (complete) {
      var full = new ArrayBuffer(pending.totalByteLength);
      var view = new Uint8Array(full);
      var offset = 0;
      for (var i = 0; i < pending.chunks.length; i++) {
        view.set(new Uint8Array(pending.chunks[i]), offset);
        offset += pending.chunks[i].byteLength;
      }
      ffmpegPendingVideoData[opId] = full;
      delete ffmpegPendingChunks[opId];
    }
    sendResponse({ success: true, complete: complete });
    return false;
  } else if (request.action === "runFFmpegInExtension") {
    const operationId = request.operationId;
    const data = request.data || {};
    const targetTabId = sender.tab && sender.tab.id;
    const pendingSendResponse = sendResponse;

    var videoBuffer = data.videoData;
    if (!videoBuffer && operationId != null) {
      videoBuffer = ffmpegPendingVideoData[operationId];
    }
    var isValidBuffer =
      videoBuffer instanceof ArrayBuffer && videoBuffer.byteLength > 0;
    if (
      !isValidBuffer &&
      videoBuffer &&
      typeof videoBuffer.byteLength === "number" &&
      videoBuffer.buffer instanceof ArrayBuffer
    ) {
      videoBuffer = videoBuffer.buffer.slice(
        videoBuffer.byteOffset,
        videoBuffer.byteOffset + videoBuffer.byteLength,
      );
      isValidBuffer = videoBuffer.byteLength > 0;
    }
    if (!isValidBuffer) {
      pendingSendResponse({
        success: false,
        error:
          "No or invalid video data from page. Try storing the video first (Convert to MP3 again).",
      });
      return true;
    }
    ffmpegPendingVideoData[operationId] = videoBuffer;

    const RUNNER_READY_TIMEOUT_MS = 20000;
    const RESPONSE_TIMEOUT_MS = 95000;

    function ensureRunnerThenRun() {
      const waitReady = new Promise(function (resolve) {
        if (ffmpegRunnerTabId !== null) {
          chrome.tabs.get(ffmpegRunnerTabId, function (tab) {
            if (tab && !chrome.runtime.lastError) {
              resolve();
              return;
            }
            ffmpegRunnerTabId = null;
            ffmpegRunnerReadyQueue.push(resolve);
            chrome.tabs.create(
              {
                url: chrome.runtime.getURL("ffmpeg-runner.html"),
                active: false,
              },
              function (tab) {
                if (tab && tab.id) ffmpegRunnerTabId = tab.id;
              },
            );
          });
          return;
        }
        ffmpegRunnerReadyQueue.push(resolve);
        chrome.tabs.create(
          { url: chrome.runtime.getURL("ffmpeg-runner.html"), active: false },
          function (tab) {
            if (tab && tab.id) ffmpegRunnerTabId = tab.id;
          },
        );
      });

      const timeoutPromise = new Promise(function (resolve) {
        setTimeout(function () {
          resolve();
        }, RUNNER_READY_TIMEOUT_MS);
      });

      Promise.race([waitReady, timeoutPromise]).then(function () {
        const responseTimeout = setTimeout(function () {
          ffmpegResponseTimeouts[operationId] = null;
          if (operationId) delete ffmpegPendingVideoData[operationId];
          if (typeof pendingSendResponse !== "function") return;
          pendingSendResponse({
            success: false,
            error:
              "Conversion timed out. Try again or check if the FFmpeg helper loaded.",
          });
        }, RESPONSE_TIMEOUT_MS);
        ffmpegResponseTimeouts[operationId] = responseTimeout;

        chrome.runtime.sendMessage(
          {
            action: "runFFmpeg",
            operationId,
            targetTabId,
            data: {
              format: data.format || "mp3",
              filename: data.filename,
            },
          },
          function (response) {
            const tid = ffmpegResponseTimeouts[operationId];
            if (tid) {
              clearTimeout(tid);
              ffmpegResponseTimeouts[operationId] = null;
            }
            if (typeof pendingSendResponse !== "function") return;
            if (response && response.success) {
              pendingSendResponse({
                success: true,
                processedData: response.processedData,
                filename: response.filename,
                mimeType: response.mimeType,
              });
            } else {
              pendingSendResponse({
                success: false,
                error: (response && response.error) || "Conversion failed",
              });
            }
          },
        );
      });
    }

    ensureRunnerThenRun();
    return true;
  } else if (request.type === "ffmpegConversionDone") {
    const opId = request.operationId;
    const tid = ffmpegResponseTimeouts[opId];
    if (tid) {
      clearTimeout(tid);
      ffmpegResponseTimeouts[opId] = null;
    }
    const tabId = request.targetTabId;
    if (tabId) {
      chrome.tabs.sendMessage(
        tabId,
        {
          action: "ffmpegResult",
          operationId: request.operationId,
          success: request.success,
          processedData: request.processedData,
          filename: request.filename,
          mimeType: request.mimeType,
          error: request.error,
        },
        function () {
          if (chrome.runtime.lastError) {
          }
        },
      );
    }
    return false;
  } else if (request.action === "download") {
    return handleDownloadAction(
      request,
      sender,
      sendResponse,
      activeDownloads,
      downloadInfo,
      downloadControllers,
      videoData,
      activeChromeDownloads,
    );
  } else if (request.action === "downloadFile") {
    const filename = request.filename || "download";
    const data = request.data;
    const isArrayBuffer = data instanceof ArrayBuffer;
    const isView =
      typeof ArrayBuffer !== "undefined" &&
      typeof ArrayBuffer.isView === "function" &&
      ArrayBuffer.isView(data);
    if (!data || (!isArrayBuffer && !isView)) {
      sendResponse({ success: false, error: "No download data" });
      return true;
    }
    const blob = new Blob([data], { type: request.mimeType || "video/mp4" });
    const url = URL.createObjectURL(blob);
    const ourDownloadId = request.downloadId;
    chrome.downloads.download({ url, filename, saveAs: true }, (chromeId) => {
      if (chrome.runtime.lastError) {
        URL.revokeObjectURL(url);
        sendResponse({
          success: false,
          error: chrome.runtime.lastError.message,
        });
        return;
      }
      if (ourDownloadId != null) {
        blobDownloadByChromeId.set(chromeId, {
          ourDownloadId,
          blobUrl: url,
        });
      } else {
        URL.revokeObjectURL(url);
      }
      sendResponse({ success: true, downloadId: chromeId });
    });
    return true;
  } else if (request.action === "cancelDownload") {
    const downloadId = request.downloadId;
    if (!downloadId) {
      sendResponse({ success: false, error: "No downloadId provided" });
      return true;
    }

    // CRITICAL: Set cancellation flag and abort controller IMMEDIATELY
    // This ensures cancellation is detected even if service worker restarts
    chrome.storage.local.set({
      [`downloadCancelled_${downloadId}`]: true,
      [`downloadStatus_${downloadId}`]: "Download cancelled",
    });

    // Abort controller immediately if it exists
    const controllerInfo = downloadControllers.get(downloadId);
    if (controllerInfo?.controller) {
      controllerInfo.controller.abort();
    }

    // Do full cleanup asynchronously
    cancelDownload(
      downloadId,
      downloadControllers,
      activeChromeDownloads,
      activeDownloads,
      downloadInfo,
    )
      .then(() => {
        sendResponse({ success: true });
      })
      .catch((error) => {
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }
  return true;
});

chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state && delta.state.current === "complete") {
    const info = blobDownloadByChromeId.get(delta.id);
    if (!info) return;
    blobDownloadByChromeId.delete(delta.id);
    try {
      URL.revokeObjectURL(info.blobUrl);
    } catch (e) {}
    chrome.storage.local.set({
      [`downloadProgress_${info.ourDownloadId}`]: 100,
      [`downloadStatus_${info.ourDownloadId}`]: "Complete",
    });
  }
});

const VIDEO_DATA_CACHE_MAX_ITEMS = 100;

function persistVideoDataForTab(tabId) {
  const raw = videoData[tabId];
  if (!raw || !Array.isArray(raw.items) || raw.items.length === 0) return;
  const items = raw.items.slice(-VIDEO_DATA_CACHE_MAX_ITEMS);
  const key = "videoData_" + tabId;
  chrome.storage.local.set(
    { [key]: { items, updatedAt: Date.now() } },
    function () {
      if (chrome.runtime.lastError) {
      }
    },
  );
}

chrome.tabs.onRemoved.addListener((tabId) => {
  delete videoData[tabId];
  delete visibleVideoIdByTab[tabId];
  chrome.storage.local.remove("videoData_" + tabId, function () {});
  if (tabId === ffmpegRunnerTabId) ffmpegRunnerTabId = null;
});

function updateBadge(tabId) {
  if (!videoData[tabId]) return;

  try {
    const items = videoData[tabId].items;
    const count = Array.isArray(items) ? items.length : 0;

    chrome.action.setBadgeText({
      text: count > 0 ? count.toString() : "",
      tabId: tabId,
    });
    chrome.action.setBadgeBackgroundColor({ color: "#4CAF50" });
  } catch (e) {}
}
