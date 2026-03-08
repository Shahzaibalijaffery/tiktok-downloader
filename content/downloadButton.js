/** URL for the download icon (assets/images/download.svg); used for feed button */
const DOWNLOAD_ICON_URL =
  typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL
    ? chrome.runtime.getURL("assets/images/download.svg")
    : "";

/** Only run button injection on the main TikTok site (https://www.tiktok.com). */
function isTikTokMainSite() {
  try {
    return window.location.hostname === "www.tiktok.com";
  } catch (e) {
    return false;
  }
}

/** Feed button classes and helpers for desktop feed (one-column-item-N action bars). */
const FEED_BTN_CLASS = "dm-download-feed-btn";
const FEED_WRAPPER_CLASS = "dm-download-feed-wrapper";

/* Feed download styles live in content/downloadButton.css */

/**
 * Build a button that matches the native action bar structure (Like / Comment / Share).
 * Structure: button.ButtonActionItem > span.SpanIconWrapper > img + strong.StrongText.
 * Copies classes from an existing sibling button in container when available.
 */
function createNativeStyleFeedButton(videoId) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.setAttribute("aria-label", "Download video");
  btn.setAttribute("data-video-id", String(videoId));
  btn.className = FEED_BTN_CLASS;

  const iconSpan = document.createElement("span");
  iconSpan.setAttribute("data-e2e", "download-icon");
  const iconImg = document.createElement("img");
  iconImg.src = DOWNLOAD_ICON_URL;
  iconImg.width = 24;
  iconImg.height = 24;
  iconImg.alt = "";
  iconImg.setAttribute("aria-hidden", "true");
  iconImg.className = "dm-download-icon-img";
  iconSpan.appendChild(iconImg);

  const labelStrong = document.createElement("strong");
  labelStrong.setAttribute("data-e2e", "download-label");
  labelStrong.textContent = "Download";

  btn.appendChild(iconSpan);
  btn.appendChild(labelStrong);
  return btn;
}

/**
 * Copy class names from a native action bar button so our button matches exactly.
 * Looks for button[class*="ButtonActionItem"] and its span/strong children classes.
 */
function copyNativeButtonClasses(container, btn) {
  const nativeBtn = container.querySelector(
    'button[class*="ButtonActionItem"]',
  );
  if (!nativeBtn) return;
  btn.className = nativeBtn.className + " " + FEED_BTN_CLASS;
  const iconSpan = btn.querySelector('[data-e2e="download-icon"]');
  const nativeIcon = nativeBtn.querySelector('span[class*="IconWrapper"]');
  if (iconSpan && nativeIcon) iconSpan.className = nativeIcon.className;
  const labelStrong = btn.querySelector('[data-e2e="download-label"]');
  const nativeStrong = nativeBtn.querySelector('strong[class*="StrongText"]');
  if (labelStrong && nativeStrong)
    labelStrong.className = nativeStrong.className;
}

/** Inject one Download button for a feed video. Uses native action bar button structure when container has sibling action buttons.
 *  getVideoData is requested with videoId to get the correct item. */
function appendFeedButtonToContainer(container, videoId) {
  const wrapper = document.createElement("div");
  wrapper.className = FEED_WRAPPER_CLASS;
  wrapper.setAttribute("data-video-id", String(videoId));
  wrapper.style.position = "relative";

  const btn = createNativeStyleFeedButton(videoId);
  copyNativeButtonClasses(container, btn);

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

  function handleButtonClick(e) {
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
          if (v.type && (v.type.includes("mp4-full") || v.type === "config"))
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
  }

  btn.addEventListener("click", handleButtonClick);
  wrapper.appendChild(btn);
  wrapper.appendChild(menu);
  if (container.children.length > 1) {
    container.insertBefore(wrapper, container.children[1]);
  } else {
    container.appendChild(wrapper);
  }
}

/** Get video ID from a feed article (id="xgwrapper-0-{videoId}" or link href /video/ID). */
function getVideoIdFromFeedArticle(article) {
  if (!article || !article.querySelector) return null;
  const xgPrefix = "xgwrapper-0-";
  const wrapper = article.querySelector('[id^="' + xgPrefix + '"]');
  if (wrapper && wrapper.id && wrapper.id.length > xgPrefix.length) {
    return wrapper.id.slice(xgPrefix.length);
  }
  const links = article.querySelectorAll('a[href*="/video/"]');
  for (let i = 0; i < links.length; i++) {
    const href = links[i].getAttribute("href") || "";
    const m = href.match(/\/video\/(\d+)/);
    if (m) return m[1];
  }
  return null;
}

/**
 * Desktop feed: inject Download button only for articles whose video ID exists in stored data,
 * and only when the action bar belongs to that article (avoids wrong placement / no id match).
 */
function injectFeedButtonsDesktop() {
  if (window.self !== window.top || !isTikTokMainSite()) return;
  if (!isExtensionContextValid()) return;

  const articles = document.querySelectorAll('[id^="one-column-item-"]');
  if (articles.length === 0) return;

  safeSendMessage({ action: "getStoredVideoIds" }, (response) => {
    if (!isExtensionContextValid()) return;
    const storedIds =
      response && Array.isArray(response.videoIds)
        ? new Set(response.videoIds)
        : new Set();
    for (let i = 0; i < articles.length; i++) {
      const article = articles[i];
      const videoId = getVideoIdFromFeedArticle(article);
      if (!videoId || !storedIds.has(videoId)) continue;

      const actionBar = article.querySelector(
        'section[class*="ActionBarContainer"]',
      );
      if (!actionBar) continue;
      // Ensure this action bar belongs to this article (avoid wrong placement when DOM is nested)
      if (actionBar.closest('[id^="one-column-item-"]') !== article) continue;
      if (
        actionBar.querySelector(
          `.${FEED_WRAPPER_CLASS}[data-video-id="${videoId}"]`,
        )
      )
        continue;

      appendFeedButtonToContainer(actionBar, videoId);
    }
  });
}

if (typeof document !== "undefined") {
  function runDesktopFeedInjection() {
    if (!isTikTokMainSite()) return;
    if (
      document.getElementById("column-list-container") ||
      document.querySelector('[id^="one-column-item-"]')
    ) {
      injectFeedButtonsDesktop();
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", runDesktopFeedInjection);
  } else {
    runDesktopFeedInjection();
  }
  setInterval(runDesktopFeedInjection, 2000);
  window.__dmRunDesktopFeedInjection = runDesktopFeedInjection;
}
