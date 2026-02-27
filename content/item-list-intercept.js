/**
 * Runs in page (main world). Hooks fetch to detect TikTok item_list API responses,
 * extracts video URL from item.video.PlayAddrStruct.UrlList and title from item.desc,
 * then posts TIKTOK_ITEM_LIST to the content script.
 */
(function () {
  "use strict";
  if (window.__tiktokItemListInterceptInstalled) return;
  window.__tiktokItemListInterceptInstalled = true;

  function getVideoUrl(item) {
    const playAddr = item.video && item.video.PlayAddrStruct;
    if (!playAddr || !Array.isArray(playAddr.UrlList) || playAddr.UrlList.length === 0)
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

  function handleItemList(itemList) {
    if (!Array.isArray(itemList) || itemList.length === 0) return;
    const items = [];
    for (let i = 0; i < itemList.length; i++) {
      const item = itemList[i];
      if (!item || !item.video) continue;
      const url = getVideoUrl(item);
      if (!url) continue;
      const title = typeof item.desc === "string" ? item.desc.trim() : "";
      items.push({ url, title, id: item.id || null });
    }
    if (items.length > 0) {
      window.postMessage({ type: "TIKTOK_ITEM_LIST", items }, "*");
    }
  }

  const origFetch = window.fetch;
  window.fetch = function (...args) {
    return origFetch.apply(this, args).then(function (response) {
      const url = typeof args[0] === "string" ? args[0] : args[0] && args[0].url;
      if (!url || !response.ok) return response;
      const clone = response.clone();
      clone
        .json()
        .then(function (data) {
          if (!data) return;
          const list = data.itemList || data.item_list;
          if (Array.isArray(list)) handleItemList(list);
        })
        .catch(function () {});
      return response;
    });
  };
})();
