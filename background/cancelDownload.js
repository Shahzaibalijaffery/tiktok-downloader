async function cancelDownload(
  downloadId,
  downloadControllers,
  activeChromeDownloads,
  activeDownloads,
  downloadInfo,
) {
  try {
    // Get controller info before cleanup
    const controllerInfo = downloadControllers.get(downloadId);
    // Cancel Chrome download if active in controller
    if (controllerInfo?.chromeDownloadId) {
      chrome.downloads.cancel(controllerInfo.chromeDownloadId, () => {});
    }
    // Remove from tracking maps
    downloadControllers.delete(downloadId);
    // Cancel any active Chrome downloads for this downloadId
    for (const [
      chromeDownloadId,
      chromeDownloadInfo,
    ] of activeChromeDownloads.entries()) {
      if (chromeDownloadInfo.downloadId === downloadId) {
        chrome.downloads.cancel(chromeDownloadId, () => {});
        if (chromeDownloadInfo.blobUrl) {
          try {
            chrome.runtime.sendMessage(
              { action: "revokeBlobUrl", blobUrl: chromeDownloadInfo.blobUrl },
              () => {},
            );
          } catch (e) {}
        }
        if (chromeDownloadInfo.blobId) {
          cleanupIndexedDBBlob(chromeDownloadInfo.blobId);
        }
        activeChromeDownloads.delete(chromeDownloadId);
      }
    }
    // Remove from activeDownloads
    for (const [url, id] of activeDownloads.entries()) {
      if (id === downloadId) {
        activeDownloads.delete(url);
        break;
      }
    }

    // Get tabId for notification before removing downloadInfo
    const info = downloadInfo.get(downloadId);
    const tabId = info?.tabId;
    downloadInfo.delete(downloadId);

    // Remove progress and downloadInfo from storage (cleanup)
    // Keep cancellation flag and status temporarily so download process can detect cancellation
    await chrome.storage.local.remove([
      `downloadProgress_${downloadId}`,
      `downloadInfo_${downloadId}`,
    ]);

    // Clean up ALL download-related storage keys after delay
    // Keep cancellation flag/status for 2 seconds so download process can detect it, then remove everything
    setTimeout(() => {
      chrome.storage.local.remove(
        [`downloadStatus_${downloadId}`, `downloadCancelled_${downloadId}`],
        () => {
          if (chrome.runtime.lastError) {
          }
        },
      );
    }, 2000);

    // Notify content script
    if (tabId) {
      chrome.tabs.sendMessage(
        tabId,
        {
          action: "downloadCancelled",
          downloadId: downloadId,
        },
        () => {},
      );
    } else {
      chrome.tabs.query({ url: "https://www.tiktok.com/*" }, (tabs) => {
        if (tabs && tabs.length > 0) {
          chrome.tabs.sendMessage(
            tabs[0].id,
            {
              action: "downloadCancelled",
              downloadId: downloadId,
            },
            () => {},
          );
        }
      });
    }
  } catch (error) {
    throw error;
  }
}

/**
 * Helper function to check if download is cancelled
 * @param {string} downloadId - The download ID to check
 * @returns {Promise<boolean>}
 */
async function isDownloadCancelled(downloadId) {
  return new Promise((resolve) => {
    chrome.storage.local.get([`downloadCancelled_${downloadId}`], (items) => {
      resolve(!!items[`downloadCancelled_${downloadId}`]);
    });
  });
}
