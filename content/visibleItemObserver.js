/**
 * Detect visible feed item on scroll. Finds the most visible feed block and extracts
 * the video ID from a link href (/@x/video/ID), then sends setVisibleVideoId to background.
 */
(function () {
  "use strict";
  if (window.self !== window.top) return;

  const ratioByEl = new WeakMap();
  let lastLoggedVideoId = null;

  var XGWRAPPER_PREFIX = "xgwrapper-0-";
  function getVideoIdFromElement(el) {
    if (!el || !el.querySelector) return null;
    var wrapper = el.querySelector("[id^=\"" + XGWRAPPER_PREFIX + "\"]");
    if (wrapper && wrapper.id && wrapper.id.length > XGWRAPPER_PREFIX.length) {
      return wrapper.id.slice(XGWRAPPER_PREFIX.length);
    }
    var links = el.querySelectorAll('a[href*="/video/"]');
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute("href") || "";
      var m = href.match(/\/video\/(\d+)/);
      if (m) return m[1];
    }
    return null;
  }

  function onIntersection(entries) {
    var items = document.querySelectorAll("[id^='one-column-item-']");
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e.target && e.target.id && e.target.id.startsWith("one-column-item-")) {
        ratioByEl.set(e.target, e.intersectionRatio);
      }
    }
    var bestEl = null;
    var bestRatio = 0;
    for (var j = 0; j < items.length; j++) {
      var r = ratioByEl.get(items[j]);
      if (r != null && r > bestRatio) {
        bestRatio = r;
        bestEl = items[j];
      }
    }
    if (bestEl && bestRatio >= 0.25) {
      var videoId = getVideoIdFromElement(bestEl);
      if (videoId && videoId !== lastLoggedVideoId) {
        lastLoggedVideoId = videoId;
        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
          try {
            chrome.runtime.sendMessage({ action: "setVisibleVideoId", videoId: videoId }, function () {
              if (chrome.runtime.lastError) {}
            });
          } catch (err) {}
        }
      }
    }
  }

  var io = new IntersectionObserver(onIntersection, {
    root: null,
    rootMargin: "0px",
    threshold: [0, 0.1, 0.25, 0.5, 0.75, 1],
  });

  function observeItem(el) {
    if (!el || !el.id || !el.id.startsWith("one-column-item-")) return;
    if (ratioByEl.has(el)) return;
    ratioByEl.set(el, 0);
    io.observe(el);
  }

  function discoverAndObserve() {
    document.querySelectorAll("[id^='one-column-item-']").forEach(observeItem);
  }

  var mo = new MutationObserver(discoverAndObserve);

  function start() {
    discoverAndObserve();
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
