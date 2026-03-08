/**
 * Runs at document_start so item_list and hydration API fetch interceptor is in place before the page requests.
 * Runs on every page under https://www.tiktok.com/ to collect video data everywhere.
 */
(function () {
  if (window.self !== window.top) return;

  // Listen for item_list results as early as possible (interceptor may fire before document_end).
  window.addEventListener("message", function (event) {
    if (event.source !== window || !event.data || event.data.type !== "TIKTOK_ITEM_LIST") return;
    var items = event.data.items;
    if (!Array.isArray(items) || items.length === 0) return;
    chrome.runtime.sendMessage(
      { action: "itemListAppend", items: items },
      function () { if (chrome.runtime.lastError) {} }
    );
  });

  var src = chrome.runtime.getURL("content/item-list-intercept.js");
  if (document.querySelector('script[src="' + src + '"]')) return;
  var script = document.createElement("script");
  script.src = src;
  (document.documentElement || document.head || document.body).appendChild(script);
})();
