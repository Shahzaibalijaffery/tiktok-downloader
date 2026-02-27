const DM_BTN_LOG = "[DM Download Button]";

/** Selector for the native action bar node we insert the download button next to */
const BUTTON_CONTAINER_SELECTOR = '[data-testid="like-button"]';
/** Max time to wait for the container to appear (e.g. after skeleton/loading) */
const CONTAINER_WAIT_MS = 15000;
/** How often to poll for the container */
const CONTAINER_POLL_MS = 500;
/** Max number of extra attempts when container was not found (schedule retry) */
const MAX_INJECT_RETRIES = 2;

let _injectRetryCount = 0;

/** Class on our page (watch) download wrapper so we can confirm it's our button */
const PAGE_BUTTON_WRAPPER_CLASS = "dm-page-download-wrapper";

/**
 * Returns true if a valid download button for this videoId already exists:
 * same id, in document, and has our wrapper class (matches video id and is our UI).
 */
function hasValidDownloadButton(videoId) {
  if (!videoId) return false;
  const el = document.getElementById(`ext-${videoId}`);
  return !!(
    el &&
    document.contains(el) &&
    el.classList.contains(PAGE_BUTTON_WRAPPER_CLASS)
  );
}

/**
 * Returns true when the element is in the DOM and visible (not hidden/skeleton).
 * Uses offsetParent and size so we don't attach to a placeholder.
 */
function isContainerReady(el) {
  if (!el || !el.parentNode || !document.contains(el)) return false;
  if (el.offsetParent === null) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * Polls until the button container exists and is ready (visible, not skeleton),
 * or until maxWaitMs has passed. Resolves with the element or null.
 */
function waitForButtonContainer(maxWaitMs, pollIntervalMs) {
  const start = Date.now();
  return new Promise((resolve) => {
    function check() {
      const el = document.querySelector(BUTTON_CONTAINER_SELECTOR);
      if (el && isContainerReady(el)) {
        resolve(el);
        return;
      }
      if (Date.now() - start >= maxWaitMs) {
        resolve(null);
        return;
      }
      setTimeout(check, pollIntervalMs);
    }
    check();
  });
}

/**
 * Entry point for the video (watch) page: decide if we should show the Download button, find its container,
 * wait for video data (getVideoData with retries), wait for container (handles slow load/skeleton), then inject.
 * Called from content.js and on requestInjectButton. Does not build DOM itself.
 */
function injectDownloadButton() {
  window.__dmInjectSource = undefined;

  if (!isExtensionContextValid()) {
    console.log(DM_BTN_LOG, "skip: extension context invalidated");
    return;
  }
  if (!isVideoPage()) {
    console.log(DM_BTN_LOG, "skip: not a video page");
    return;
  }
  if (window.self !== window.top) {
    console.log(DM_BTN_LOG, "skip: not top frame");
    return;
  }

  safeSendMessage(
    {
      action: "getVideoData",
      tabId: null,
    },
    (response) => {
      // Check again after async operation
      if (!isExtensionContextValid()) {
        return;
      }

      console.log(DM_BTN_LOG, "injectDownloadButton: got video data");

      const videoData = response?.videoData;
      const urls = videoData?.urls ?? [];
      const videoIds = videoData?.videoIds ?? {};
      const videoId =
        Object.keys(videoIds)[0] || (urls[0] && urls[0].videoId) || null;
      if (!videoId) {
        return;
      }
      if (hasValidDownloadButton(videoId)) {
        return;
      }

      // Title from videoIds or first url
      const videoTitle =
        (typeof cleanVideoTitle === "function" &&
          videoIds[videoId]?.title &&
          cleanVideoTitle(videoIds[videoId].title)) ||
        videoIds[videoId]?.title ||
        urls[0]?.videoTitle ||
        "Video";
      const safeTitle =
        !videoTitle ||
        videoTitle === "TikTok Video" ||
        /tiktok\s+video/i.test(videoTitle)
          ? "Video"
          : videoTitle;

      console.log(
        DM_BTN_LOG,
        "injectDownloadButton: got video data, waiting for container",
      );

      const reliableUrls = urls.filter((v) => {
        if (!v || !v.url) return false;
        if (v.type && v.type.includes("mp4-full")) return false;
        if (
          v.type === "config" ||
          (v.url && (v.url.includes("master.json") || v.url.includes("config")))
        )
          return false;
        if (
          typeof isFileTooSmall === "function" &&
          v.fileSize != null &&
          isFileTooSmall(v.fileSize)
        )
          return false;
        return true;
      });

      // Deduplicate by quality label (like feed)
      const seen = new Set();
      const deduped = [];
      for (const v of reliableUrls) {
        const label =
          typeof formatQualityLabel === "function"
            ? formatQualityLabel(v)
            : v.type || "Video";
        if (seen.has(label)) continue;
        seen.add(label);
        deduped.push({ ...v, qualityLabel: label });
      }

      const tag = (label) =>
        typeof getQualityTag === "function" ? getQualityTag(label) : null;
      function escapeHtml(s) {
        if (s == null) return "";
        const div = document.createElement("div");
        div.textContent = String(s);
        return div.innerHTML;
      }

      // Build dropdown items with same structure as feed (dm-feed-quality-menu / dm-feed-quality-item)
      const dropdownItemsHTML = deduped
        .map((v, i) => {
          const label = v.qualityLabel || v.type || "Video";
          const tagLabel = tag(label);
          const selectedClass =
            i === 0
              ? " dm-feed-quality-item selected"
              : " dm-feed-quality-item";
          return `<div class="dm-dropdown-item${selectedClass}" data-url="${(v.url || "").replace(/"/g, "&quot;")}" data-type="${(v.type || "").replace(/"/g, "&quot;")}" data-quality-label="${(label || "").replace(/"/g, "&quot;")}" data-video-title="${(safeTitle || "").replace(/"/g, "&quot;")}" data-video-id="${String(videoId).replace(/"/g, "&quot;")}" data-convert-mp3="false"><span class="quality-resolution">${escapeHtml(label)}</span>${tagLabel ? `<span class="quality-tag">${escapeHtml(tagLabel)}</span>` : ""}</div>`;
        })
        .join("");
      const firstSource = deduped[0] || reliableUrls[0] || urls[0];
      const convertItemHTML = `<div class="dm-dropdown-item dm-dropdown-item-mp3 dm-feed-quality-item" data-url="${(firstSource?.url || "").replace(/"/g, "&quot;")}" data-type="${(firstSource?.type || "").replace(/"/g, "&quot;")}" data-quality-label="" data-video-title="${(safeTitle || "").replace(/"/g, "&quot;")}" data-video-id="${String(videoId).replace(/"/g, "&quot;")}" data-convert-mp3="true"><span class="quality-resolution">Convert to MP3</span><span class="quality-tag">MP3</span></div>`;

      const firstLabel = deduped[0]
        ? tag(deduped[0].qualityLabel) || deduped[0].qualityLabel
        : "Download";
      const buttonHTML = `
        <span id="ext-${videoId}" class="dm-page-download-wrapper">
          <div class="vimeo-downloader-button-group dm-page-download-group">
            <button id="ext-dl-${videoId}" type="button" class="vimeo-downloader-download-btn" data-testid="dm-download-main" aria-label="Download video">
              <svg class="download-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path stroke="#0D0D0D" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 2.5v9M12 11.5l-3.5 4.2M12 11.5l3.5 4.2"/><path stroke="#0D0D0D" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M5.5 17.5h2v3h9v-3h2"/></svg>
              <span class="download-text">Download</span>
              <span class="dm-selected-quality-label dm-quality-pill">${escapeHtml(firstLabel)}</span>
            </button>
            <div class="dm-dropdown-container">
              <button id="ext-dd-${videoId}" type="button" class="vimeo-downloader-dropdown-btn" aria-haspopup="true" aria-expanded="false" aria-label="Select quality">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
              <div id="ext-dd-menu-${videoId}" class="dm-feed-quality-menu" style="display:none;">
                ${dropdownItemsHTML}
                ${convertItemHTML}
              </div>
            </div>
          </div>
        </span>
      `;

      waitForButtonContainer(CONTAINER_WAIT_MS, CONTAINER_POLL_MS).then(
        (node) => {
          if (!node || !node.parentNode) {
            if (_injectRetryCount < MAX_INJECT_RETRIES) {
              _injectRetryCount += 1;
              setTimeout(injectDownloadButton, 3000);
            }
            return;
          }
          _injectRetryCount = 0;

          const groupFragment = document
            .createRange()
            .createContextualFragment(buttonHTML);
          const groupElem = groupFragment.firstElementChild;
          const downloadButton = groupElem.querySelector(`#ext-dl-${videoId}`);
          const dropdownBtn = groupElem.querySelector(`#ext-dd-${videoId}`);
          const dropdownMenu = groupElem.querySelector(
            `#ext-dd-menu-${videoId}`,
          );
          const selectedLabelEl = groupElem.querySelector(
            ".dm-selected-quality-label",
          );

          // Selected option: default first item; user can change via dropdown, then main button uses this
          let selectedItem = dropdownMenu
            ? dropdownMenu.querySelector(".dm-dropdown-item")
            : null;

          function setSelectedItem(item) {
            if (!item) return;
            selectedItem = item;
            dropdownMenu
              .querySelectorAll(".dm-feed-quality-item")
              .forEach((el) => el.classList.remove("selected"));
            item.classList.add("selected");
            const label =
              item.getAttribute("data-convert-mp3") === "true"
                ? "MP3"
                : (item.querySelector(".quality-resolution") &&
                    item.querySelector(".quality-resolution").textContent) ||
                  item.getAttribute("data-quality-label") ||
                  "Download";
            if (selectedLabelEl) selectedLabelEl.textContent = label;
          }

          function startDownload(item) {
            if (!item) return;
            const url = item.getAttribute("data-url");
            const type = item.getAttribute("data-type") || "";
            const qualityLabel = item.getAttribute("data-quality-label") || "";
            const videoTitle =
              item.getAttribute("data-video-title") || safeTitle;
            const vid = item.getAttribute("data-video-id") || videoId;
            const convertToMp3 =
              item.getAttribute("data-convert-mp3") === "true";
            const baseName =
              (typeof sanitizeFilenameForDownload === "function"
                ? sanitizeFilenameForDownload(videoTitle)
                : videoTitle
              )
                .replace(/[\\/:*?"<>|]/g, "")
                .trim()
                .slice(0, 200) || "video";
            const ext = convertToMp3 ? "mp3" : "mp4";
            const filename = convertToMp3
              ? `${baseName}.mp3`
              : qualityLabel
                ? `${baseName} - ${qualityLabel}.${ext}`
                : `${baseName}.${ext}`;
            const downloadUrl = url || (deduped[0] && deduped[0].url);
            if (!downloadUrl && !convertToMp3) return;
            safeSendMessage(
              {
                action: "download",
                url: downloadUrl,
                filename,
                type,
                qualityLabel,
                convertToMp3,
                tabId: null,
                videoId: vid,
              },
              (res) => {
                if (res && res.error) console.warn(DM_BTN_LOG, res.error);
              },
            );
          }

          if (downloadButton) {
            downloadButton.addEventListener("click", function (e) {
              e.preventDefault();
              e.stopPropagation();
              if (selectedItem) {
                startDownload(selectedItem);
              } else if (dropdownMenu) {
                dropdownBtn.click();
              }
            });
          }

          if (dropdownBtn && dropdownMenu) {
            dropdownBtn.addEventListener("click", function (e) {
              e.stopPropagation();
              const shown =
                dropdownMenu.style.display !== "none" &&
                dropdownMenu.style.display !== "";
              dropdownMenu.style.display = shown ? "none" : "block";
              dropdownBtn.setAttribute("aria-expanded", String(!shown));
            });
            document.addEventListener("click", function closeMenu(e) {
              if (!groupElem.contains(e.target)) {
                dropdownMenu.style.display = "none";
                dropdownBtn.setAttribute("aria-expanded", "false");
              }
            });
            dropdownMenu.addEventListener("click", function (e) {
              const item = e.target.closest(".dm-dropdown-item");
              if (!item) return;
              setSelectedItem(item);
              dropdownMenu.style.display = "none";
              dropdownBtn.setAttribute("aria-expanded", "false");
            });
          }

          // Avoid duplicate if another attempt injected while we were waiting for container
          if (hasValidDownloadButton(videoId)) {
            return;
          }

          let parentNode = node.parentNode;
          if (parentNode) {
            parentNode.insertBefore(groupFragment, parentNode.firstChild);
          } else {
            node.parentNode.appendChild(groupFragment);
          }
        },
      );
    },
  );
}
/**
 * Feed: given a videoId (e.g. from the feed JSON API), find the video card in #homefeed and add a Download button.
 * Handles retries (homefeed/card may not be in DOM yet), dedup (no duplicate button per video), and container
 * lookup (like-button parent or card). Then calls appendFeedButtonToContainer(container, videoId) to create the UI.
 */

const FEED_BTN_CLASS = "dm-download-feed-btn";
const FEED_WRAPPER_CLASS = "dm-download-feed-wrapper";

/* Feed download styles live in content/downloadButton.css */

// Same classes as feed action buttons (e.g. Like) so our Download button matches native styling
const FEED_BTN_NATIVE_CLASSES =
  "HomeVideoCardButtons__buttonStyles___KhxTE LikeButton__likeButton___mqkhv Button__button___ro5TM Button__small___A3HdU Button__tertiary___lEWU7 Button__isButtonIcon___yfUeV";

// Download icon: thick rounded arrow above U-shaped tray with small gap (matches reference screenshot).
const FEED_DOWNLOAD_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" role="img" aria-hidden="true" fill="none" stroke="#0D0D0D" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5v9M12 11.5l-3.5 4.2M12 11.5l3.5 4.2"/><path d="M5.5 17.5h2v3h9v-3h2"/></svg>';

/** Inject one Download button for a feed video. Wrapper (with native classes) is direct child of container; click on wrapper opens quality dropdown. */
function appendFeedButtonToContainer(container, videoId) {
  const wrapper = document.createElement("div");
  wrapper.className = [
    FEED_WRAPPER_CLASS,
    "dm-feed-btn-native",
    FEED_BTN_NATIVE_CLASSES,
  ]
    .filter(Boolean)
    .join(" ");
  wrapper.setAttribute("data-video-id", videoId);
  wrapper.setAttribute("role", "button");
  wrapper.setAttribute("tabindex", "0");
  wrapper.setAttribute("aria-label", "Download video");

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = FEED_BTN_CLASS;
  btn.setAttribute("data-video-id", videoId);
  const iconImg = document.createElement("img");
  iconImg.src =
    typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL
      ? chrome.runtime.getURL("assets/feed-download-icon.png")
      : "";
  iconImg.alt = "Download";
  iconImg.onerror = () => {
    btn.innerHTML = FEED_DOWNLOAD_ICON_SVG;
  };
  if (iconImg.src) btn.appendChild(iconImg);
  else btn.innerHTML = FEED_DOWNLOAD_ICON_SVG;

  const menu = document.createElement("div");
  menu.className = "dm-feed-quality-menu";
  menu.setAttribute("role", "list");

  function closeMenu() {
    menu.classList.remove("dm-feed-menu-open");
    document.removeEventListener("click", docClick);
  }
  function docClick(e) {
    if (wrapper.contains(e.target)) return;
    closeMenu();
  }

  function openMenuWithQualities(urls, title) {
    menu.innerHTML = "";
    document.removeEventListener("click", docClick);

    const filenameBase = (
      typeof sanitizeFilenameForDownload === "function"
        ? sanitizeFilenameForDownload(title)
        : title
    )
      .replace(/[\\/:*?"<>|]/g, "_")
      .slice(0, 80);

    // Deduplicate by quality label so we don't show the same quality twice when scrolling back
    const seen = new Set();
    const deduped = urls.filter((v) => {
      const key =
        typeof formatQualityLabel === "function"
          ? formatQualityLabel(v)
          : v.type || v.url || "";
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    deduped.forEach((v) => {
      const qualityLabel =
        typeof formatQualityLabel === "function"
          ? formatQualityLabel(v)
          : v.type || "Video";
      const tag =
        typeof getQualityTag === "function"
          ? getQualityTag(qualityLabel)
          : null;
      const item = document.createElement("div");
      item.className = "dm-feed-quality-item";
      item.setAttribute("role", "option");
      const resSpan = document.createElement("span");
      resSpan.className = "quality-resolution";
      resSpan.textContent = qualityLabel;
      item.appendChild(resSpan);
      if (tag) {
        const tagSpan = document.createElement("span");
        tagSpan.className = "quality-tag";
        tagSpan.textContent = tag;
        item.appendChild(tagSpan);
      }
      item.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        closeMenu();
        const ext = "mp4";
        const filename = qualityLabel
          ? `${filenameBase} - ${qualityLabel}.${ext}`
          : filenameBase + "." + ext;
        safeSendMessage(
          {
            action: "download",
            url: v.url,
            filename: filename,
            type: v.type,
            tabId: null,
            videoId: v.videoId || videoId,
          },
          () => {},
        );
      });
      menu.appendChild(item);
    });

    // MP3 option (convert lowest quality to MP3)
    const lowest = deduped[deduped.length - 1];
    if (lowest && lowest.url) {
      const mp3Item = document.createElement("div");
      mp3Item.className = "dm-feed-quality-item";
      mp3Item.setAttribute("role", "option");
      const mp3Res = document.createElement("span");
      mp3Res.className = "quality-resolution";
      mp3Res.textContent = "MP3";
      mp3Item.appendChild(mp3Res);
      const mp3Tag = document.createElement("span");
      mp3Tag.className = "quality-tag";
      mp3Tag.textContent = "MP3";
      mp3Item.appendChild(mp3Tag);
      mp3Item.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        closeMenu();
        const filename = `${filenameBase} - MP3.mp3`;
        safeSendMessage(
          {
            action: "download",
            url: lowest.url,
            filename: filename,
            type: lowest.type,
            tabId: null,
            videoId: lowest.videoId || videoId,
            convertToMp3: true,
          },
          () => {},
        );
      });
      menu.appendChild(mp3Item);
    }

    menu.classList.add("dm-feed-menu-open");
    document.addEventListener("click", docClick);
  }

  wrapper.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (menu.classList.contains("dm-feed-menu-open")) {
      closeMenu();
      return;
    }
    safeSendMessage(
      { action: "getVideoData", tabId: null, videoId: videoId },
      (response) => {
        if (
          !response ||
          !response.videoData ||
          !response.videoData.urls ||
          response.videoData.urls.length === 0
        ) {
          menu.innerHTML = "";
          document.removeEventListener("click", docClick);
          const item = document.createElement("div");
          item.className = "dm-feed-quality-item disabled";
          item.textContent = "Play this video first to load options";
          menu.appendChild(item);
          menu.classList.add("dm-feed-menu-open");
          document.addEventListener("click", docClick);
          return;
        }
        const urls = response.videoData.urls.filter((v) => {
          if (
            v.type &&
            (v.type.includes("mp4-full") || v.type === "config")
          )
            return false;
          if (
            v.url &&
            (v.url.includes("master.json") || v.url.includes("config"))
          )
            return false;
          return true;
        });
        const title = (response.videoData.videoTitle || "video")
          .replace(/[\\/:*?"<>|]/g, "_")
          .slice(0, 80);
        if (urls.length === 0) {
          menu.innerHTML = "";
          document.removeEventListener("click", docClick);
          const item = document.createElement("div");
          item.className = "dm-feed-quality-item disabled";
          item.textContent = "Play this video first to load options";
          menu.appendChild(item);
          menu.classList.add("dm-feed-menu-open");
          document.addEventListener("click", docClick);
          return;
        }
        openMenuWithQualities(urls, title);
      },
    );
  });

  wrapper.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      wrapper.click();
    }
  });

  wrapper.appendChild(btn);
  wrapper.appendChild(menu);
  container.insertBefore(wrapper, container.firstChild);
}

/** Inject one Download button for a feed video. Wrapper (with native classes) is direct child of container; click on wrapper opens quality dropdown. */
function injectFeedButtonForVideoId(videoId, retryCount) {
  console.log(
    DM_BTN_LOG,
    "injectFeedButtonForVideoId: injecting button for videoId:",
    videoId,
  );
  if (retryCount === undefined) retryCount = 0;
  const MAX_RETRIES = 5;
  const RETRY_DELAY_MS = 400;

  if (!isExtensionContextValid()) return;
  if (typeof isFeedPage !== "function" || !isFeedPage()) return;

  const homefeed = document.getElementById("homefeed");
  if (!homefeed) {
    if (retryCount < MAX_RETRIES) {
      setTimeout(
        () => injectFeedButtonForVideoId(videoId, retryCount + 1),
        RETRY_DELAY_MS * (retryCount + 1),
      );
    }
    return;
  }

  // Already have a feed download button for this video anywhere in homefeed (e.g. after scrolling back)
  if (
    homefeed.querySelector(`.${FEED_WRAPPER_CLASS}[data-video-id="${videoId}"]`)
  )
    return;

  const el = homefeed.querySelector(
    `[id="${videoId}"], [data-xid="${videoId}"], a[href*="/video/${videoId}"]`,
  );
  if (!el) {
    if (retryCount < MAX_RETRIES) {
      setTimeout(
        () => injectFeedButtonForVideoId(videoId, retryCount + 1),
        RETRY_DELAY_MS * (retryCount + 1),
      );
    }
    return;
  }

  const likeBtn = el.querySelector('[data-testid="like-button"]');
  const container = likeBtn ? likeBtn.parentElement : el.closest("div") || el;
  if (!container || !homefeed.contains(container)) return;
  if (container.querySelector(`.${FEED_BTN_CLASS}[data-video-id="${videoId}"]`))
    return;

  appendFeedButtonToContainer(container, videoId);
}
