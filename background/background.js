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
      console.log(
        "[TikTok Downloader] Injected content script into tab",
        tabId,
      );
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
    .catch((err) => {
      console.warn(
        "[TikTok Downloader] Failed to inject content script into tab",
        tabId,
        err,
      );
    });
}

// On install/update: inject content scripts into all existing TikTok tabs so the download button appears without refresh
chrome.runtime.onInstalled.addListener((details) => {
  if (!chrome.scripting || !chrome.scripting.executeScript) return;
  chrome.tabs.query({ url: "*://*.tiktok.com/*" }, (tabs) => {
    tabs.forEach((tab) => {
      if (tab.id) injectContentScriptIntoTab(tab.id);
    });
  });
});

// Video URLs are collected only via item_list API interception in the content script (itemListAppend).

// Listen for messages from content script or popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Handle ping to wake up service worker
  if (request.action === "ping") {
    sendResponse({ success: true });
    return true;
  }

  if (request.action === "getVideoData") {
    let tabId = request.tabId;
    if (!tabId && sender && sender.tab && sender.tab.id) {
      tabId = sender.tab.id;
    }

    (async () => {
      const raw = videoData[tabId] || { items: [] };
      const items = Array.isArray(raw.items) ? raw.items : [];
      const urls = items.map((it) => ({
        url: it.url,
        type: "mp4",
        timestamp: Date.now(),
        fromNetworkRequest: true,
        videoTitle: it.title || null,
        videoId: it.id || null,
        fileSize: null,
      }));
      const last = items[items.length - 1] || null;
      const data = {
        urls,
        activeUrl: last ? last.url : null,
        videoTitle: last ? last.title : null,
        videoIds: {},
      };

      if (tabId) {
        updateBadge(tabId);
      }

      sendResponse({ videoData: data });
    })();
    return true;
  } else if (request.action === "itemListAppend") {
    const tabId = sender.tab && sender.tab.id;
    if (!tabId || !Array.isArray(request.items) || request.items.length === 0) {
      sendResponse({ success: false });
      return false;
    }
    appendItemList(tabId, request.items);
    sendResponse({ success: true });
    return false;
  } else if (request.action === "getDownloadInfo") {
    const info = downloadInfo.get(request.downloadId) || null;
    sendResponse({ info });
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
    // TikTok main-world fetch: content script sends raw data (ArrayBuffer or TypedArray); background creates blob and downloads
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
    chrome.downloads.download(
      {
        url,
        filename,
        saveAs: true,
      },
      (downloadId) => {
        URL.revokeObjectURL(url);
        if (chrome.runtime.lastError) {
          sendResponse({
            success: false,
            error: chrome.runtime.lastError.message,
          });
        } else {
          sendResponse({ success: true, downloadId });
        }
      },
    );
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

// Clean up old data when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  delete videoData[tabId];
});

// Clear stored video data for a tab (e.g. on navigation/refresh)
function clearTabVideoData(tabId) {
  if (!videoData[tabId]) return;
  videoData[tabId].items = [];
}

// Clear stored items only on full page load (navigation/refresh), not on SPA URL change
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tab.url || !tab.url.includes("tiktok.com")) return;
  if (changeInfo.status === "loading" && videoData[tabId]) {
    clearTabVideoData(tabId);
    updateBadge(tabId);
  }
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
  } catch (e) {
    console.warn("Failed to set badge:", e);
  }
}
