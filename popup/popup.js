// Popup script
// Utility functions are loaded via popup.html before this script

let currentTabId = null;
let currentVideoId = null;
let currentUrl = null;
let isLoading = false;
let latestVideoData = null; // last data received from background (used by download button)
let navigationCheckInterval = null;

const NAVIGATION_CHECK_INTERVAL_MS = 1000;

function isSupportedTikTokPage(url) {
  return url && typeof url === "string" && url.startsWith("https://www.tiktok.com");
}

function showNoVideosFinalState() {
  isLoading = false;
  const container = document.getElementById("videoList");
  if (container) {
    container.innerHTML = `
      <div class="no-videos">
        <div class="no-videos-icon">📭</div>
        <h3>No videos detected</h3>
        <p>Videos from this page will appear here once detected.</p>
      </div>
    `;
  }
}

// Initialize when popup opens
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (tabs && tabs.length > 0 && tabs[0]) {
    initializePopup(tabs[0]);
  } else {
    showError("No active tab found. Please open a TikTok video page.");
  }
});

/**
 * Initialize popup with current tab
 */
function initializePopup(tab) {
  currentTabId = tab.id;
  currentUrl = tab.url;
  currentVideoId = extractVideoId(tab.url);

  // Start loading video data
  loadVideoData(true);

  // Set up navigation detection (detect URL changes while popup is open)
  setupNavigationDetection();

  // Clean up when popup is hidden (user switched tab or closed popup) to free memory
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) cleanup();
  });

  // Fallback: clean up after 2 minutes max
  setTimeout(() => {
    cleanup();
  }, 120000);
}

/**
 * Load video data from background script
 * Always queries for fresh tab data to handle navigation
 */
function loadVideoData(showLoading = true, forceRefresh = false) {
  // Prevent multiple simultaneous loads
  if (isLoading && !forceRefresh) return;

  // Always query for active tab to get current URL (handles navigation)
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || tabs.length === 0) {
      showError("No active tab found.");
      return;
    }

    const tab = tabs[0];
    const newUrl = tab.url;
    const newVideoId = extractVideoId(newUrl);

    // Check if URL changed (navigation detected)
    if (currentUrl !== newUrl) {
      currentUrl = newUrl;
      currentVideoId = newVideoId;
      currentTabId = tab.id;
    } else if (currentTabId !== tab.id) {
      // Tab ID changed (tab was switched)
      currentTabId = tab.id;
      currentUrl = newUrl;
      currentVideoId = newVideoId;
    }

    if (!newUrl.startsWith("https://www.tiktok.com")) {
      showError("This extension works only on TikTok (tiktok.com).");
      return;
    }

    // Show loading state
    if (showLoading) {
      showLoadingState();
    }

    isLoading = true;

    // Request content script to actively detect videos (for lazy loading scenarios)
    requestVideoDetection(currentTabId);

    // Wake up service worker and get video data
    wakeServiceWorkerAndGetData(currentTabId, newVideoId);
  });
}

/**
 * Request content script to refresh video detection (no-op; video URLs come from service worker).
 * Kept for API compatibility with popup UI.
 */
function requestVideoDetection(tabId) {
  chrome.tabs.sendMessage(
    tabId,
    { action: "triggerVideoExtraction", reason: "popup-request" },
    () => {},
  );
}

/**
 * Wake up service worker and get video data
 */
function wakeServiceWorkerAndGetData(tabId, expectedVideoId) {
  // Step 1: Ping service worker to wake it up
  chrome.runtime.sendMessage({ action: "ping" }, (pingResponse) => {
    // Step 2: Get video data
    chrome.runtime.sendMessage(
      { action: "getVideoData", tabId: tabId },
      (response) => {
        isLoading = false;

        if (chrome.runtime.lastError) {
          handleError(chrome.runtime.lastError.message);
          return;
        }

        if (!response) {
          handleError("No response from background script");
          return;
        }

        const videoData = response.videoData || { urls: [] };
        latestVideoData = videoData;

        const hasVideos = videoData.urls && videoData.urls.length > 0;

        if (!hasVideos) {
          showNoVideosFinalState();
          return;
        }
        displayVideosWithTitle(videoData, tabId);
      },
    );
  });
}

/**
 * Display videos with title fetching
 */
function displayVideosWithTitle(videoData, tabId) {
  // Get title from tab if not available or generic
  if (
    !videoData.videoTitle ||
    videoData.videoTitle === "TikTok Video" ||
    videoData.videoTitle.toLowerCase().includes("tiktok video player")
  ) {
    chrome.tabs.get(tabId, (tab) => {
      if (!chrome.runtime.lastError && tab && tab.title) {
        const title = cleanVideoTitle(tab.title);
        if (title) {
          videoData.videoTitle = title;
        }
      }
      displayVideos(videoData);
    });
  } else {
    displayVideos(videoData);
  }
}

/**
 * Show loading state
 */
function showLoadingState() {
  const container = document.getElementById("videoList");
  if (container) {
    container.innerHTML = `
      <div class="no-videos">
        <div class="no-videos-icon">⏳</div>
        <h3>Loading Video Data...</h3>
        <p>Please wait while we detect video URLs.</p>
        <p>If the page is still loading, this may take a moment.</p>
      </div>
    `;
  }
}

/**
 * Handle errors
 */
function handleError(errorMsg) {
  isLoading = false;
  const container = document.getElementById("videoList");
  if (container) {
    const isConnectionError =
      errorMsg.includes("Could not establish connection") ||
      errorMsg.includes("Receiving end does not exist");

    container.innerHTML = `
      <div class="no-videos">
        <div class="no-videos-icon">⚠️</div>
        <h3>${isConnectionError ? "Service Worker Not Running" : "Connection Error"}</h3>
        <p>${isConnectionError ? "The extension service worker is not running." : `Error: ${errorMsg}`}</p>
        <p>Please reload the extension (chrome://extensions → Reload) and refresh the TikTok page.</p>
      </div>
    `;
  }
}

/**
 * Show error message
 */
function showError(message) {
  const container = document.getElementById("videoList");
  if (container) {
    container.innerHTML = `
      <div class="no-videos">
        <div class="no-videos-icon">⚠️</div>
        <h3>Error</h3>
        <p>${message}</p>
      </div>
    `;
  }
}

/**
 * Set up navigation detection
 */
function setupNavigationDetection() {
  if (navigationCheckInterval) {
    clearInterval(navigationCheckInterval);
  }

  navigationCheckInterval = setInterval(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs.length > 0 && tabs[0]) {
        const tab = tabs[0];
        const newUrl = tab.url;
        const newVideoId = extractVideoId(newUrl);

        // If URL or video ID changed, reload data
        if (newUrl !== currentUrl || newVideoId !== currentVideoId) {
          loadVideoData(true, true);
        }
      }
    });
  }, NAVIGATION_CHECK_INTERVAL_MS);
}

/**
 * Cleanup intervals and release large refs to avoid memory retention
 */
function cleanup() {
  if (navigationCheckInterval) {
    clearInterval(navigationCheckInterval);
    navigationCheckInterval = null;
  }
  latestVideoData = null;
}

// Rest of the file continues with displayVideos and other functions...
// [Previous displayVideos function and all other functions remain the same]

function displayVideos(videoData) {
  const container = document.getElementById("videoList");

  if (!videoData || !videoData.urls || videoData.urls.length === 0) {
    container.innerHTML = `
      <div class="no-videos">
        <div class="no-videos-icon">🎬</div>
        <h3>No Videos Detected</h3>
        <p>No video URLs detected yet.</p>
        <p>Play the video on TikTok and wait a moment for detection.</p>
      </div>
    `;
    return;
  }

  // Filter out unreliable or non-video URLs (TikTok: MP4 CDN URLs only)
  const reliableUrls = videoData.urls.filter((v) => {
    if (v.type && v.type.includes("mp4-full")) return false;
    if (
      v.type === "config" ||
      v.url.includes("master.json") ||
      v.url.includes("config")
    ) {
      return false;
    }
    if (isFileTooSmall(v.fileSize)) return false;
    return true;
  });

  // If all URLs were filtered out, show "No Videos Detected"
  if (reliableUrls.length === 0) {
    container.innerHTML = `
      <div class="no-videos">
        <div class="no-videos-icon">🎬</div>
        <h3>No Videos Detected</h3>
        <p>No video URLs detected yet.</p>
        <p>Play the video on TikTok and wait a moment for detection.</p>
      </div>
    `;
    return;
  }

  // Get video title from videoData (fallback); never use "TikTok Video" in UI
  let defaultVideoTitle =
    cleanVideoTitle(videoData.videoTitle) || videoData.videoTitle || "Video";
  if (
    !defaultVideoTitle ||
    defaultVideoTitle === "TikTok Video" ||
    /tiktok\s+video/i.test(defaultVideoTitle)
  ) {
    defaultVideoTitle = "Video";
  }

  // Group videos by videoId (page/video)
  const videosByPage = {};

  reliableUrls.forEach((video) => {
    const videoId = video.videoId || "unknown";
    if (!videosByPage[videoId]) {
      videosByPage[videoId] = [];
    }
    videosByPage[videoId].push(video);
  });

  container.innerHTML = "";

  // Function to group videos by videoId (same video, different qualities)
  const groupVideosByVideoId = (videos) => {
    const grouped = {};
    videos.forEach((video) => {
      // Normalize videoId to string for consistent grouping
      // Use videoId as primary key, fallback to videoTitle, then 'unknown'
      const videoIdKey = video.videoId ? String(video.videoId) : null;
      const key = videoIdKey || video.videoTitle || "unknown";

      if (!grouped[key]) {
        grouped[key] = [];
      }
      grouped[key].push(video);
    });

    return grouped;
  };

  // Function to sort and render videos
  const renderVideos = (videos) => {
    if (videos.length === 0) return;

    // Group videos by videoId (same video, different qualities)
    const groupedVideos = groupVideosByVideoId(videos);

    // Render each group (each unique video with its quality options)
    const videoKeys = Object.keys(groupedVideos);
    videoKeys.forEach((videoKey, index) => {
      const videoGroup = groupedVideos[videoKey];
      const isFirst = index === 0;

      const sortedQualities = videoGroup.sort((a, b) => {

        const qualityA = extractQuality(a.type, a.url) || 0;
        const qualityB = extractQuality(b.type, b.url) || 0;
        return qualityB - qualityA;
      });

      // Deduplicate by quality label so revisiting the same video doesn't duplicate rows (keep one per 720p, 480p, MP3, etc.)
      const uniqueByQualityLabel = new Map();
      sortedQualities.forEach((video) => {
        if (!video || !video.url) return;
        const label = formatQualityLabel(video);
        // Prefer first occurrence (already sorted: MP4 first, then by quality); skip if we already have this label
        if (!uniqueByQualityLabel.has(label)) {
          uniqueByQualityLabel.set(label, video);
        }
      });

      const deduplicatedQualities = Array.from(
        uniqueByQualityLabel.values(),
      ).sort((a, b) => {
        if (!a || !b) return 0;
        const qualityA = extractQuality(a.type, a.url) || 0;
        const qualityB = extractQuality(b.type, b.url) || 0;
        return qualityB - qualityA;
      });

      // Check if we have any videos after deduplication
      // If all were filtered out, use the original sortedQualities as fallback
      if (deduplicatedQualities.length === 0) {
        if (videoGroup.length === 0) {
          return; // Skip this group if no videos at all
        }
        // Use original videoGroup as fallback
        deduplicatedQualities.push(...videoGroup.slice(0, 1)); // Use at least the first video
      }

      // Get the first video for title and default selection
      const firstVideo = deduplicatedQualities[0];

      // Safety check: ensure firstVideo exists and is valid
      if (!firstVideo) return;

      let displayTitle = null;

      const videoIdForLookup = firstVideo.videoId
        ? String(firstVideo.videoId)
        : null;

      // Try to get title from videoId mapping first (most reliable)
      // This ensures each video group uses its own videoId's title
      if (videoIdForLookup && videoData.videoIds) {
        // Try both string and number key (in case of type mismatch)
        const titleFromMap =
          videoData.videoIds[videoIdForLookup]?.title ||
          videoData.videoIds[firstVideo.videoId]?.title;
        if (titleFromMap) {
          // Validate that the title is not generic before using it
          const lowerTitle = titleFromMap.toLowerCase();
          const isGeneric =
            titleFromMap === "TikTok Video" ||
            lowerTitle.includes("tiktok video player") ||
            lowerTitle.match(
              /^(tiktok|video|tiktok video player|video player)$/i,
            );
          if (!isGeneric) {
            displayTitle = titleFromMap;
          }
        }
      }

      // Fallback to video's own title (from the video object itself)
      if (!displayTitle) {
        // Try to find a video with a valid title in this group
        const videoWithTitle = deduplicatedQualities.find((v) => {
          if (!v || !v.videoTitle) return false;
          const lowerTitle = v.videoTitle.toLowerCase();
          // Accept any non-generic title
          return (
            v.videoTitle !== "TikTok Video" &&
            !lowerTitle.includes("tiktok video player") &&
            !lowerTitle.match(
              /^(tiktok|video|tiktok video player|video player)$/i,
            )
          );
        });
        if (videoWithTitle) {
          displayTitle = videoWithTitle.videoTitle;
        } else if (firstVideo && firstVideo.videoTitle) {
          const lowerTitle = firstVideo.videoTitle.toLowerCase();
          if (
            firstVideo.videoTitle !== "TikTok Video" &&
            !lowerTitle.includes("tiktok video player") &&
            !lowerTitle.match(
              /^(tiktok|video|tiktok video player|video player)$/i,
            )
          ) {
            displayTitle = firstVideo.videoTitle;
          }
        }
      }

      if (!displayTitle) {
        displayTitle = defaultVideoTitle || "Video";
      }
      // Never show "TikTok Video" in dropdown – use cleaned title or "Video"
      displayTitle = (
        cleanVideoTitle(displayTitle) ||
        displayTitle ||
        "Video"
      ).trim();
      if (
        !displayTitle ||
        displayTitle === "TikTok Video" ||
        /tiktok\s+video/i.test(displayTitle)
      ) {
        displayTitle = "Video";
      }

      // Create expandable video item with per-quality rows (name, format, tag, Download, Copy)
      const item = document.createElement("div");
      item.className = "video-item";

      const escapeAttr = (s) =>
        (s || "").replace(/"/g, "&quot;").replace(/</g, "&lt;");
      let qualityRowsHtml = "";

      const cell = (cls, content) =>
        content
          ? `<span class="${cls}">${escapeAttr(content)}</span>`
          : `<span class="${cls}"></span>`;

      deduplicatedQualities.forEach((video, idx) => {
        if (!video || !video.url) return;
        const qualityLabel = formatQualityLabel(video);
        const tag =
          typeof getQualityTag === "function"
            ? getQualityTag(qualityLabel)
            : null;
        const videoIndex = videoData.urls.findIndex((v) => v.url === video.url);
        const typeLabel = formatTypeLabel(video.type);
        qualityRowsHtml += `
          <div class="quality-row" data-url="${escapeAttr(video.url)}" data-index="${videoIndex >= 0 ? videoIndex : ""}" data-type="${escapeAttr(video.type)}" data-quality-label="${escapeAttr(qualityLabel)}" data-display-title="${escapeAttr(displayTitle)}" data-convert-mp3="0">
            ${cell("quality-name", qualityLabel)}
            ${cell("quality-format", typeLabel)}
            ${tag ? `<span class="quality-tag-pill">${escapeAttr(tag)}</span>` : '<span class="quality-tag-pill"></span>'}
            <div class="quality-row-actions">
              <button type="button" class="quality-download-btn" data-url="${escapeAttr(video.url)}" data-index="${videoIndex >= 0 ? videoIndex : ""}" data-type="${escapeAttr(video.type)}" data-quality-label="${escapeAttr(qualityLabel)}" data-display-title="${escapeAttr(displayTitle)}">Download</button>
              <button type="button" class="quality-copy-btn" data-url="${escapeAttr(video.url)}">Copy</button>
            </div>
          </div>`;
      });

      const lowestQuality =
        deduplicatedQualities[deduplicatedQualities.length - 1];
      if (lowestQuality && lowestQuality.url) {
        const lowestVideoIndex = videoData.urls.findIndex(
          (v) => v.url === lowestQuality.url,
        );
        qualityRowsHtml += `
          <div class="quality-row" data-url="${escapeAttr(lowestQuality.url)}" data-index="${lowestVideoIndex >= 0 ? lowestVideoIndex : ""}" data-type="${escapeAttr(lowestQuality.type)}" data-quality-label="MP3" data-display-title="${escapeAttr(displayTitle)}" data-convert-mp3="1">
            ${cell("quality-name", "MP3")}
            ${cell("quality-format", "320kbps")}
            <span class="quality-tag-pill">HQ</span>
            <div class="quality-row-actions">
              <button type="button" class="quality-download-btn" data-url="${escapeAttr(lowestQuality.url)}" data-index="${lowestVideoIndex >= 0 ? lowestVideoIndex : ""}" data-type="${escapeAttr(lowestQuality.type)}" data-quality-label="MP3" data-display-title="${escapeAttr(displayTitle)}" data-convert-mp3="1">Download</button>
              <button type="button" class="quality-copy-btn" data-url="${escapeAttr(lowestQuality.url)}">Copy</button>
            </div>
          </div>`;
      }

      item.innerHTML = `
        <div class="video-header expandable-header" role="button" tabindex="0" aria-expanded="${isFirst}">
          <div class="video-title">${escapeAttr(displayTitle)}</div>
          <span class="expand-chevron" aria-hidden="true">▼</span>
        </div>
        <div class="video-qualities">
          ${qualityRowsHtml}
        </div>
      `;

      if (isFirst) item.classList.add("expanded");
      container.appendChild(item);

      const header = item.querySelector(".expandable-header");
      if (header) {
        header.addEventListener("click", (e) => {
          e.stopPropagation();
          item.classList.toggle("expanded");
          header.setAttribute(
            "aria-expanded",
            item.classList.contains("expanded"),
          );
        });
        header.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            header.click();
          }
        });
      }
    });
  };

  if (reliableUrls.length > 0) {
    renderVideos(reliableUrls);
  }

  // Event delegation: quality row Download and Copy (replaces old .download-btn / .copy-btn)
  container.addEventListener("click", (e) => {
    const downloadBtn = e.target.closest(".quality-download-btn");
    if (downloadBtn) {
      e.preventDefault();
      e.stopPropagation();
      const url = downloadBtn.dataset.url;
      const index = parseInt(downloadBtn.dataset.index, 10) || 0;
      const videoItem =
        videoData.urls.find((v) => v.url === url) || videoData.urls[index];
      if (videoItem) {
        const videoTitle =
          downloadBtn.dataset.displayTitle ||
          cleanVideoTitle(videoItem.videoTitle) ||
          videoItem.videoTitle ||
          "Video";
        const qualityLabel = downloadBtn.dataset.qualityLabel || "";
        const convertToMp3 = downloadBtn.dataset.convertMp3 === "1";
        const videoIndex = videoData.urls.findIndex((v) => v.url === url);
        downloadVideo(
          url,
          videoIndex >= 0 ? videoIndex : 0,
          videoItem.type,
          videoTitle,
          qualityLabel,
          convertToMp3,
        );
      }
      return;
    }
    const copyBtn = e.target.closest(".quality-copy-btn");
    if (copyBtn) {
      e.preventDefault();
      e.stopPropagation();
      const url = copyBtn.dataset.url;
      if (url) {
        copyToClipboard(url);
        copyBtn.textContent = "Copied!";
        setTimeout(() => {
          copyBtn.textContent = "Copy";
        }, 2000);
      }
    }
  });

  // Add event listeners for parse buttons
  document.querySelectorAll(".parse-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const url = e.target.dataset.url;
      parseConfigFile(url);
      e.target.textContent = "⏳ Parsing...";
      e.target.disabled = true;
    });
  });
}

function parseConfigFile(configUrl) {
  chrome.runtime.sendMessage(
    {
      action: "parseConfig",
      url: configUrl,
      tabId: currentTabId,
    },
    (response) => {
      if (response && response.success) {
        setTimeout(() => {
          loadVideoData(true, true);
        }, 1000);
      } else {
        alert("Failed to parse config file. Check console for details.");
      }
    },
  );
}

function extractQuality(type, url = "") {
  let match = type && type.match(/(\d+)p/i);
  if (match) {
    return parseInt(match[1]);
  }

  match = type && type.match(/-(\d+)$/);
  if (match) return parseInt(match[1], 10);
  match = type && type.match(/-(\d+)p?$/i);
  if (match) return parseInt(match[1], 10);

  // Try to extract from URL (some URLs contain quality info)
  if (url) {
    // Look for patterns like /1080p/, /720p/, /480p/, etc. in URL
    match = url.match(/\/(\d+)p/i);
    if (match) {
      return parseInt(match[1]);
    }

    // Look for patterns like /1080/, /720/, /480/ in URL path
    match = url.match(/\/(\d{3,4})(?:\/|$)/);
    if (match) {
      const num = parseInt(match[1]);
      // Only return if it's a reasonable quality value (240-4320)
      if (num >= 240 && num <= 4320 && num % 10 === 0) {
        return num;
      }
    }
  }

  return null; // Return null instead of 0 to indicate unknown
}

function formatTypeLabel(type) {
  if (!type) return "";
  if (type.includes("mp4")) return type.toUpperCase();
  return type.toUpperCase();
}

function downloadVideo(
  url,
  index,
  type,
  videoTitle = "TikTok Video",
  qualityLabel = "",
  convertToMp3 = false,
) {
  // Use cleaned title for filename; never put "TikTok Video" in filename
  const titleForFilename = cleanVideoTitle(videoTitle) || videoTitle || "video";
  const baseTitle =
    !titleForFilename ||
    titleForFilename === "TikTok Video" ||
    /tiktok\s+video/i.test(titleForFilename)
      ? "video"
      : titleForFilename;

  // Sanitize filename: remove invalid characters, limit length
  const sanitizeFilename = (name) => {
    let sanitized = (name || "").replace(/[\/\\:\*\?"<>\|]/g, "");
    sanitized = sanitized.trim().replace(/^\.+|\.+$/g, "");
    if (sanitized.length > 200) sanitized = sanitized.substring(0, 200);
    return sanitized || "video";
  };

  const sanitizedTitle = sanitizeFilename(baseTitle);
  const extension = convertToMp3 ? "mp3" : getExtension(url);

  let filename;
  if (convertToMp3) {
    filename = `${sanitizedTitle} - MP3.mp3`;
  } else if (qualityLabel && qualityLabel.trim()) {
    const qualityPart =
      (qualityLabel.match(/(\d+p)/i) && qualityLabel.match(/(\d+p)/i)[1]) ||
      qualityLabel.split(" ")[0];
    filename = `${sanitizedTitle} - ${qualityPart}.${extension}`;
  } else {
    filename = `${sanitizedTitle}.${extension}`;
  }

  chrome.runtime.sendMessage(
    {
      action: "download",
      url: url,
      filename: filename,
      type: type,
      qualityLabel: qualityLabel,
      convertToMp3: convertToMp3,
      tabId: currentTabId,
      // Prefer the known videoId from captured data (avoids "fmp4" / other false IDs)
      videoId:
        latestVideoData &&
        latestVideoData.urls &&
        latestVideoData.urls[index] &&
        latestVideoData.urls[index].videoId
          ? latestVideoData.urls[index].videoId
          : undefined,
    },
    (downloadResponse) => {
      if (downloadResponse && downloadResponse.success) {
      } else if (downloadResponse && downloadResponse.error) {
        // Show user-friendly error message in popup
        const errorMsg = downloadResponse.error;
        if (errorMsg.includes("already being downloaded")) {
          showNotification(
            "⏳ Download in Progress",
            "This file is already being downloaded. Please wait for the current download to complete.",
            "warning",
          );
        } else {
          showNotification("Download Failed", errorMsg, "error");
        }
      }
    },
  );
}

// Show notification in popup (replaces alert)
function showNotification(title, message, type = "info") {
  const notificationArea = document.getElementById("notificationArea");
  if (!notificationArea) return;

  // Clear any existing notification
  notificationArea.innerHTML = "";

  // Show the notification area
  notificationArea.style.display = "block";

  const notificationEl = document.createElement("div");
  notificationEl.className = `notification ${type}`;
  notificationEl.innerHTML = `
    <div class="notification-title">${title}</div>
    <div class="notification-message">${message}</div>
  `;

  notificationArea.appendChild(notificationEl);

  // Show with slide-down animation
  setTimeout(() => {
    notificationEl.style.transform = "translateY(0)";
    notificationEl.style.opacity = "1";
  }, 10);

  // Auto-hide after 5 seconds
  setTimeout(() => {
    notificationEl.style.transform = "translateY(-100%)";
    notificationEl.style.opacity = "0";
    setTimeout(() => {
      if (notificationEl.parentNode) {
        notificationEl.parentNode.removeChild(notificationEl);
      }
      // Hide notification area if empty
      if (notificationArea.children.length === 0) {
        notificationArea.style.display = "none";
      }
    }, 300);
  }, 5000);
}

function getExtension(url) {
  if (url && url.includes(".mp4")) return "mp4";
  return "mp4";
}

function copyToClipboard(text) {
  navigator.clipboard
    .writeText(text)
    .then(() => {})
    .catch(() => {});
}
