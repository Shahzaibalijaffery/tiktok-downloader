const MAX_ITEMS_PER_TAB = 500;

function ensureTabItems(tabId) {
  if (!videoData[tabId]) {
    videoData[tabId] = { items: [] };
  }
  if (!Array.isArray(videoData[tabId].items)) {
    videoData[tabId].items = [];
  }
}

function appendItemList(tabId, newItems) {
  if (!tabId || tabId < 0 || !Array.isArray(newItems) || newItems.length === 0)
    return;
  ensureTabItems(tabId);
  const seen = new Set(videoData[tabId].items.map((i) => i.id || i.url));
  for (let i = 0; i < newItems.length; i++) {
    const it = newItems[i];
    const url = it.url && typeof it.url === "string" ? it.url.trim() : null;
    if (!url) continue;
    const id = it.id || url;
    if (seen.has(id)) continue;
    seen.add(id);
    videoData[tabId].items.push({
      url: fixUrlEncoding(url),
      title: typeof it.title === "string" ? it.title.trim() : "",
      id: it.id || null,
    });
  }

  console.log(newItems, "newItems", videoData);
  while (videoData[tabId].items.length > MAX_ITEMS_PER_TAB) {
    videoData[tabId].items.shift();
  }
  updateBadge(tabId);
}

function storeVideoUrl(
  tabId,
  url,
  type,
  fromNetworkRequest = false,
  videoTitle = null,
  videoId = null,
  fileSize = null,
) {
  url = fixUrlEncoding(url);
  if (!tabId || tabId < 0) {
    console.warn("Invalid tabId, skipping URL storage:", { tabId, url, type });
    return;
  }
  ensureTabItems(tabId);
  videoData[tabId].items.push({
    url,
    title: videoTitle || "",
    id: videoId || null,
  });
  while (videoData[tabId].items.length > MAX_ITEMS_PER_TAB) {
    videoData[tabId].items.shift();
  }
  updateBadge(tabId);
}
