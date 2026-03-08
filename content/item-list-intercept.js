/**
 * Runs in page (main world). Hooks fetch to detect TikTok item_list API responses,
 * extracts video URL from item.video.PlayAddrStruct.UrlList and title from item.desc,
 * then posts TIKTOK_ITEM_LIST to the content script.
 */
(function () {
  "use strict";
  if (window.__tiktokItemListInterceptInstalled) return;
  window.__tiktokItemListInterceptInstalled = true;
  function logItemList() {}

  function getVideoUrl(item) {
    const playAddr = item.video && item.video.PlayAddrStruct;
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

  function itemToEntry(item) {
    if (!item || !item.video) return null;
    var url = getVideoUrl(item);
    if (!url) return null;
    return {
      url: url,
      title: typeof item.desc === "string" ? item.desc.trim() : "",
      id: item.id != null ? String(item.id) : null,
    };
  }

  /** Extract video items from hydration-style API response (__DEFAULT_SCOPE__, webapp.updated-items, ItemModule, webapp.video-detail, and other list keys). */
  function extractFromHydrationStyle(data) {
    var out = [];
    if (!data || typeof data !== "object") return out;
    var scope = data.__DEFAULT_SCOPE__ || data.data || data.result || data;
    var updated = scope["webapp.updated-items"];
    if (Array.isArray(updated)) {
      for (var i = 0; i < updated.length; i++) {
        var e = itemToEntry(updated[i]);
        if (e) out.push(e);
      }
    }
    var itemModule = scope.ItemModule || scope.itemModule;
    if (itemModule && typeof itemModule === "object") {
      var keys = Object.keys(itemModule);
      for (var k = 0; k < keys.length; k++) {
        var e = itemToEntry(itemModule[keys[k]]);
        if (e) out.push(e);
      }
    }
    var videoDetail =
      scope["webapp.video-detail"] || scope["webapp.video-detail-more"];
    if (
      videoDetail &&
      videoDetail.itemInfo &&
      videoDetail.itemInfo.itemStruct
    ) {
      var e = itemToEntry(videoDetail.itemInfo.itemStruct);
      if (e) out.push(e);
    }
    var listKeys = ["ItemList", "item_list", "itemList", "recommendList", "videoList", "list", "items", "feed"];
    for (var l = 0; l < listKeys.length; l++) {
      var arr = scope[listKeys[l]];
      if (Array.isArray(arr)) {
        for (var i = 0; i < arr.length; i++) {
          var e = itemToEntry(arr[i]);
          if (e) out.push(e);
        }
      }
    }
    return out;
  }

  function handleItemList(itemList) {
    if (!Array.isArray(itemList) || itemList.length === 0) return;
    logItemList("handleItemList: raw list length", itemList.length);
    const items = [];
    for (let i = 0; i < itemList.length; i++) {
      const item = itemList[i];
      if (!item || !item.video) continue;
      const url = getVideoUrl(item);
      if (!url) continue;
      const title = typeof item.desc === "string" ? item.desc.trim() : "";
      items.push({ url, title, id: item.id || null });
    }
    logItemList(
      "handleItemList: extracted items",
      items.length,
      "ids:",
      items.map(function (i) {
        return i.id;
      }),
    );
    if (items.length > 0) {
      window.postMessage({ type: "TIKTOK_ITEM_LIST", items }, "*");
    }
  }

  /** Try to find any array of video items anywhere in the response (other API shapes). */
  function deepFindVideoList(obj, seen) {
    if (!obj || typeof obj !== "object") return null;
    seen = seen || new Set();
    if (seen.has(obj)) return null;
    seen.add(obj);
    if (Array.isArray(obj)) {
      var hasVideo = obj.length > 0 && obj[0] && obj[0].video && obj[0].video.PlayAddrStruct;
      if (hasVideo) return obj;
      for (var i = 0; i < obj.length; i++) {
        var found = deepFindVideoList(obj[i], seen);
        if (found) return found;
      }
      return null;
    }
    var keys = Object.keys(obj);
    for (var k = 0; k < keys.length; k++) {
      var found = deepFindVideoList(obj[keys[k]], seen);
      if (found) return found;
    }
    return null;
  }

  function tryEmitFromData(data, url, source) {
    if (!data) return;
    var list =
      data.itemList ||
      data.item_list ||
      (data.data && (data.data.itemList || data.data.item_list)) ||
      (data.result && (data.result.itemList || data.result.item_list)) ||
      (data.body && (data.body.itemList || data.body.item_list));
    if (Array.isArray(list) && list.length > 0) {
      logItemList(source, "list detected", "url=", url, "length=", list.length);
      handleItemList(list);
      return;
    }
    var hydrationItems = extractFromHydrationStyle(data);
    if (hydrationItems.length > 0) {
      logItemList(source, "hydration-style", "url=", url, "items=", hydrationItems.length);
      window.postMessage({ type: "TIKTOK_ITEM_LIST", items: hydrationItems }, "*");
      return;
    }
    var deepList = deepFindVideoList(data);
    if (Array.isArray(deepList) && deepList.length > 0) {
      logItemList(source, "deep list detected", "url=", url, "length=", deepList.length);
      handleItemList(deepList);
    }
  }

  const origFetch = window.fetch;
  window.fetch = function (...args) {
    var url = typeof args[0] === "string" ? args[0] : args[0] && args[0].url;
    return origFetch.apply(this, args).then(function (response) {
      if (!url || !response.ok) return response;
      response
        .clone()
        .json()
        .then(function (data) {
          tryEmitFromData(data, url, "fetch");
        })
        .catch(function () {});
      return response;
    });
  };

  if (typeof XMLHttpRequest !== "undefined") {
    var origOpen = XMLHttpRequest.prototype.open;
    var origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this._ttUrl = url;
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      var xhr = this;
      var url = xhr._ttUrl;
      if (xhr.addEventListener) {
        xhr.addEventListener("load", function () {
          if (!url) return;
          var data = null;
          if (xhr.responseType === "json" && xhr.response && typeof xhr.response === "object") {
            data = xhr.response;
          } else if ((xhr.responseType === "" || xhr.responseType === "text") && xhr.responseText && xhr.responseText.length >= 50) {
            try {
              data = JSON.parse(xhr.responseText);
            } catch (e) {}
          }
          if (data) tryEmitFromData(data, url, "xhr");
        });
      }
      return origSend.apply(this, arguments);
    };
  }

  logItemList("item_list + hydration + xhr interceptor installed");
})();
