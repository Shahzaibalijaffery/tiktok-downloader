/**
 * Download notification and progress polling functionality
 * Handles displaying download notifications and polling for progress updates
 */

// Global state for notifications
let notificationContainer = null;
let activeDownloads = new Map(); // downloadId -> { filename, interval, element, pollingFailures, recreationCount }

function escapeHtml(s) {
  if (s == null) return "";
  const div = document.createElement("div");
  div.textContent = String(s);
  return div.innerHTML;
}

/** Create notification container if it doesn't exist. Styles in content/downloadNotifications.css */
function createNotificationContainer() {
  if (window.self !== window.top) return null;

  const existing = document.getElementById("vimeo-downloader-notifications");
  if (existing) {
    notificationContainer = existing;
    return notificationContainer;
  }
  if (notificationContainer && document.body.contains(notificationContainer)) {
    return notificationContainer;
  }
  if (!document.body) {
    setTimeout(createNotificationContainer, 100);
    return null;
  }

  notificationContainer = document.createElement("div");
  notificationContainer.id = "vimeo-downloader-notifications";
  document.body.appendChild(notificationContainer);
  return notificationContainer;
}

/**
 * Show download notification
 * @param {string} downloadId - Download ID
 * @param {string} filename - Filename
 * @param {string} status - Status message
 * @param {number|undefined} progress - Progress percentage
 * @param {string} qualityLabel - Quality label
 * @param {Object} __dmDebugState - Debug state object
 */
function showDownloadNotification(
  downloadId,
  filename,
  status,
  progress,
  qualityLabel = "",
  __dmDebugState = null,
) {
  if (window.self !== window.top) return;
  try {
    if (__dmDebugState) {
      __dmDebugState.lastShowNotification = {
        downloadId,
        filename,
        status,
        progress,
        qualityLabel,
        href: window.location.href,
        ts: new Date().toISOString(),
      };
      __dmDebugState.lastShowNotificationError = null;
    }
  } catch (e) {}

  if (!document.body) {
    setTimeout(
      () =>
        showDownloadNotification(
          downloadId,
          filename,
          status,
          progress,
          qualityLabel,
          __dmDebugState,
        ),
      100,
    );
    return;
  }

  const container = createNotificationContainer();

  if (!container) {
    setTimeout(
      () =>
        showDownloadNotification(
          downloadId,
          filename,
          status,
          progress,
          qualityLabel,
          __dmDebugState,
        ),
      200,
    );
    return;
  }

  let notificationEl = document.getElementById(
    `download-notification-${downloadId}`,
  );
  if (!notificationEl) {
    notificationEl = document.createElement("div");
    notificationEl.id = `download-notification-${downloadId}`;
    notificationEl.className = "dm-notification-card dm-notif-anim-in";
    container.appendChild(notificationEl);
  }

  const progressBarHtml =
    progress !== undefined
      ? `<div class="dm-notification-progress-wrap"><div class="dm-notification-progress-fill" style="width:${progress}%"></div></div><div class="dm-notification-progress-pct">${progress}%</div>`
      : "";
  const showCancelButton =
    progress !== undefined &&
    progress < 100 &&
    !status.includes("cancelled") &&
    !status.includes("complete");
  const cancelButtonHtml = showCancelButton
    ? `<button type="button" id="cancel-btn-${downloadId}" class="dm-notification-btn">❌ Cancel Download</button>`
    : "";
  const displayQuality = qualityLabel
    ? (qualityLabel.match(/(\d+p)/i) && qualityLabel.match(/(\d+p)/i)[1]) ||
      qualityLabel.split(" ")[0]
    : "";
  const qualityDisplayHtml = displayQuality
    ? `<span class="dm-notification-quality">${escapeHtml(displayQuality)}</span>`
    : "";

  notificationEl.innerHTML = `
    <div class="dm-notification-header">
      <span class="dm-notification-icon">⬇️</span>
      <div class="dm-notification-body">
        <div class="dm-notification-title">Download Started${qualityDisplayHtml}</div>
        <div class="dm-notification-filename">${escapeHtml(filename)}</div>
      </div>
    </div>
    <div class="dm-notification-status">${escapeHtml(status)}</div>
    ${progressBarHtml}
    ${cancelButtonHtml}
  `;

  if (showCancelButton) {
    const cancelBtn = notificationEl.querySelector(`#cancel-btn-${downloadId}`);
    if (cancelBtn) {
      const newCancelBtn = cancelBtn.cloneNode(true);
      cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);
      newCancelBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        stopDownloadProgressPolling(downloadId);
        hideDownloadNotification(downloadId);
        safeSendMessage({ action: "cancelDownload", downloadId }, () => {});
      });
    }
  }
}

/**
 * Show in-page notification when download is blocked (max 2 downloads or large file >500 segments)
 * @param {string} message - Message to show (e.g. "Maximum 2 downloads at a time...")
 * @param {string} reason - 'maxConcurrent' | 'largeFile'
 */
function showDownloadBlockedToast(message, reason = "maxConcurrent") {
  if (window.self !== window.top) return;
  const container = createNotificationContainer();
  if (!container) return;

  const id = "download-blocked-toast";
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement("div");
    el.id = id;
    el.className = "dm-notification-toast";
    container.appendChild(el);
  }

  const title =
    reason === "largeFile"
      ? "Large file downloading"
      : "Download limit reached";
  el.innerHTML = `
    <div class="dm-notification-header">
      <span class="dm-notification-icon">⏳</span>
      <div class="dm-notification-body">
        <div class="dm-notification-title">${escapeHtml(title)}</div>
        <div class="dm-notification-status">${escapeHtml(message)}</div>
      </div>
    </div>
  `;
  el.style.display = "block";
  el.classList.remove("dm-notif-anim-out");
  el.offsetHeight;
  el.classList.add("dm-notif-anim-in");

  const hide = () => {
    el.classList.remove("dm-notif-anim-in");
    el.classList.add("dm-notif-anim-out");
    setTimeout(() => {
      el.style.display = "none";
    }, 300);
  };
  setTimeout(hide, 6000);
}

/**
 * Update download notification
 * @param {string} downloadId - Download ID
 * @param {string} filename - Filename
 * @param {string} status - Status message
 * @param {number|undefined} progress - Progress percentage
 */
function updateDownloadNotification(downloadId, filename, status, progress) {
  if (window.self !== window.top) return;
  const container = createNotificationContainer();
  if (!container) return;

  const notificationEl = document.getElementById(
    `download-notification-${downloadId}`,
  );
  if (!notificationEl) {
    safeSendMessage({ action: "getDownloadInfo", downloadId }, (response) => {
      showDownloadNotification(
        downloadId,
        filename,
        status,
        progress,
        response?.info?.qualityLabel || "",
      );
    });
    return;
  }

  const progressBarHtml =
    progress !== undefined
      ? `<div class="dm-notification-progress-wrap"><div class="dm-notification-progress-fill" style="width:${progress}%"></div></div><div class="dm-notification-progress-pct">${progress}%</div>`
      : "";
  const isCancelled = status && status.toLowerCase().includes("cancelled");
  const isFailed =
    status &&
    (status.toLowerCase().includes("failed") ||
      status.toLowerCase().includes("error"));
  const statusIcon = isCancelled
    ? "❌"
    : isFailed
      ? "⚠️"
      : progress === 100
        ? "✅"
        : "⬇️";
  const statusText = isCancelled
    ? "Download Cancelled"
    : isFailed
      ? "Download Failed"
      : progress === 100
        ? "Download Complete"
        : "Downloading";
  const showCancelButton =
    progress !== undefined &&
    progress < 100 &&
    !isCancelled &&
    !isFailed &&
    !status.includes("complete");
  const showDismissButton = isFailed || isCancelled;
  const cancelButtonHtml = showCancelButton
    ? `<button type="button" id="cancel-btn-${downloadId}" class="dm-notification-btn">❌ Cancel Download</button>`
    : "";
  const dismissButtonHtml = showDismissButton
    ? `<button type="button" id="dismiss-btn-${downloadId}" class="dm-notification-btn">✕ Dismiss</button>`
    : "";

  notificationEl.innerHTML = `
    <div class="dm-notification-header">
      <span class="dm-notification-icon">${statusIcon}</span>
      <div class="dm-notification-body">
        <div class="dm-notification-title">${escapeHtml(statusText)}</div>
        <div class="dm-notification-filename">${escapeHtml(filename)}</div>
      </div>
    </div>
    <div class="dm-notification-status">${escapeHtml(status)}</div>
    ${progressBarHtml}
    ${cancelButtonHtml}
    ${dismissButtonHtml}
  `;

  if (showCancelButton) {
    const cancelBtn = notificationEl.querySelector(`#cancel-btn-${downloadId}`);
    if (cancelBtn) {
      const newBtn = cancelBtn.cloneNode(true);
      cancelBtn.parentNode.replaceChild(newBtn, cancelBtn);
      newBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        safeStorageGet([`downloadStatus_${downloadId}`], (result) => {
          const s = (result && result[`downloadStatus_${downloadId}`]) || "";
          if (/failed|error|cancelled/i.test(s)) {
            hideDownloadNotification(downloadId);
            return;
          }
          stopDownloadProgressPolling(downloadId);
          hideDownloadNotification(downloadId);
          safeSendMessage({ action: "cancelDownload", downloadId }, () => {});
        });
      });
    }
  }
  if (showDismissButton) {
    const dismissBtn = notificationEl.querySelector(
      `#dismiss-btn-${downloadId}`,
    );
    if (dismissBtn) {
      dismissBtn.addEventListener("click", () =>
        hideDownloadNotification(downloadId),
      );
    }
  }
}

/**
 * Hide download notification
 * @param {string} downloadId - Download ID
 */
function hideDownloadNotification(downloadId) {
  const notificationEl = document.getElementById(
    `download-notification-${downloadId}`,
  );
  if (!notificationEl) return;
  notificationEl.classList.add("dm-notif-exit");
  setTimeout(() => {
    if (notificationEl.parentNode)
      notificationEl.parentNode.removeChild(notificationEl);
    activeDownloads.delete(downloadId);
  }, 300);
}

/**
 * Start polling for download progress
 * @param {string} downloadId - Download ID
 * @param {string} filename - Filename
 */
const MAX_CONCURRENT_POLLING_DOWNLOADS = 12;

function startDownloadProgressPolling(downloadId, filename) {
  // Don't start if already polling for this download
  if (activeDownloads.has(downloadId)) return;

  // Cap number of simultaneous polling intervals to prevent memory/CPU leak
  if (activeDownloads.size >= MAX_CONCURRENT_POLLING_DOWNLOADS) {
    const firstKey = activeDownloads.keys().next().value;
    if (firstKey) stopDownloadProgressPolling(firstKey);
  }

  // Check if extension context is valid before starting
  if (!isExtensionContextValid()) return;

  // Check immediately
  const checkProgress = () => {
    // Check if extension context is still valid - stop immediately if invalidated
    if (!isExtensionContextValid()) {
      // Stop polling silently - extension was reloaded
      stopDownloadProgressPolling(downloadId);
      return;
    }

    // Check if this download is still being tracked (might have been stopped already)
    if (!activeDownloads.has(downloadId)) {
      // Polling was already stopped, don't continue
      return;
    }

    // Use safe storage access
    safeStorageGet(
      [`downloadProgress_${downloadId}`, `downloadStatus_${downloadId}`],
      (result) => {
        // Check again if extension context is still valid after async operation
        if (!isExtensionContextValid()) {
          stopDownloadProgressPolling(downloadId);
          return;
        }

        // Check again if download is still being tracked
        if (!activeDownloads.has(downloadId)) {
          return;
        }
        if (!result) return;

        const progress = result[`downloadProgress_${downloadId}`];
        const status = result[`downloadStatus_${downloadId}`];

        // Verify notification element still exists
        const notificationEl = document.getElementById(
          `download-notification-${downloadId}`,
        );
        if (!notificationEl) {
          // Check if download still exists before recreating
          const downloadInfo = activeDownloads.get(downloadId);
          if (!downloadInfo) {
            // Polling was stopped, don't recreate - this is normal when download completes
            return;
          }

          // Check if we're still on a video page and container exists before recreating
          if (
            !isVideoPage() ||
            !document.getElementById("vimeo-downloader-notifications")
          ) {
            // Page navigated away or container removed, stop polling silently
            stopDownloadProgressPolling(downloadId);
            return;
          }

          // Check if download exists in background and is still active
          safeSendMessage(
            { action: "getDownloadInfo", downloadId: downloadId },
            (response) => {
              if (response && response.info) {
                // Check if download is complete
                safeStorageGet(
                  [
                    `downloadProgress_${downloadId}`,
                    `downloadStatus_${downloadId}`,
                  ],
                  (progressResult) => {
                    const downloadProgress =
                      progressResult[`downloadProgress_${downloadId}`];
                    const downloadStatus =
                      progressResult[`downloadStatus_${downloadId}`] || "";

                    // If download is complete or failed, don't recreate notification
                    if (
                      downloadProgress === 100 ||
                      downloadStatus.toLowerCase().includes("complete") ||
                      downloadStatus.toLowerCase().includes("failed") ||
                      downloadStatus.toLowerCase().includes("cancelled")
                    ) {
                      stopDownloadProgressPolling(downloadId);
                      return;
                    }

                    // Download exists and is still active, recreate notification (but limit recreations)
                    if (!downloadInfo.recreationCount) {
                      downloadInfo.recreationCount = 0;
                    }
                    downloadInfo.recreationCount++;

                    // Only recreate a few times to prevent loops
                    if (downloadInfo.recreationCount <= 3) {
                      showDownloadNotification(
                        downloadId,
                        filename,
                        status || "Preparing download...",
                        progress || 0,
                      );
                    } else {
                      stopDownloadProgressPolling(downloadId);
                    }
                  },
                );
              } else {
                stopDownloadProgressPolling(downloadId);
              }
            },
          );
          return;
        }

        // Reset recreation count and polling failures if notification exists
        const downloadInfo = activeDownloads.get(downloadId);
        if (downloadInfo) {
          downloadInfo.recreationCount = 0;
          if (downloadInfo.pollingFailures > 0) {
            downloadInfo.pollingFailures = 0;
          }
        }

        if (progress !== undefined && progress !== null) {
          updateDownloadNotification(
            downloadId,
            filename,
            status || "Preparing download...",
            progress,
          );

          // Check if download is complete (progress 100 or status includes "complete")
          const isComplete =
            progress === 100 ||
            (status && status.toLowerCase().includes("complete"));

          if (isComplete) {
            // Download complete - update notification to show completion FIRST
            updateDownloadNotification(
              downloadId,
              filename,
              status || "Download complete!",
              100,
            );
            // Stop polling after updating notification
            stopDownloadProgressPolling(downloadId);
            // Hide notification after delay so user sees completion
            setTimeout(() => {
              hideDownloadNotification(downloadId);
            }, 5000); // Increased from 3s to 5s so user can see completion
            return;
          }

          // Check if cancelled or failed
          if (
            status &&
            (status.toLowerCase().includes("cancelled") ||
              status.toLowerCase().includes("failed") ||
              status.toLowerCase().includes("error"))
          ) {
            // Download was cancelled or failed, stop polling but keep notification visible with dismiss button
            stopDownloadProgressPolling(downloadId);
            // Update notification one more time to show dismiss button
            updateDownloadNotification(downloadId, filename, status, progress);
            return;
          }
        } else {
          // No progress data - check if download still exists in background
          const downloadInfo = activeDownloads.get(downloadId);
          if (!downloadInfo) {
            stopDownloadProgressPolling(downloadId);
            return;
          }

          // Check if download still exists in background script
          safeSendMessage(
            { action: "getDownloadInfo", downloadId: downloadId },
            (response) => {
              if (!response || !response.info) {
                stopDownloadProgressPolling(downloadId);
                // Hide notification if it exists
                const notificationEl = document.getElementById(
                  `download-notification-${downloadId}`,
                );
                if (notificationEl) {
                  hideDownloadNotification(downloadId);
                }
                return;
              }

              // Download exists but no progress data - might be a temporary storage issue
              // Track polling failures
              if (!downloadInfo.pollingFailures) {
                downloadInfo.pollingFailures = 0;
              }
              downloadInfo.pollingFailures++;

              if (downloadInfo.pollingFailures > 10) {
                stopDownloadProgressPolling(downloadId);
                // Update notification to show "Waiting for progress..."
                updateDownloadNotification(
                  downloadId,
                  filename,
                  "Waiting for progress update...",
                  undefined,
                );
              }
            },
          );
        }
      },
    );
  };

  checkProgress();

  // Poll every 500ms
  const interval = setInterval(checkProgress, 500);
  activeDownloads.set(downloadId, {
    filename,
    interval,
    element: null,
    pollingFailures: 0,
  });
}

/**
 * Stop polling for download progress
 * @param {string} downloadId - Download ID
 */
function stopDownloadProgressPolling(downloadId) {
  const download = activeDownloads.get(downloadId);
  if (download && download.interval) {
    clearInterval(download.interval);
  }
  activeDownloads.delete(downloadId);
}

/**
 * Get active downloads map (for external access)
 * @returns {Map} Active downloads map
 */
function getActiveDownloads() {
  return activeDownloads;
}
