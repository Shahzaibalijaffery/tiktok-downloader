# Utility Scripts

This directory contains reusable utility functions that can be shared across the extension's background, content, and popup scripts.

## Files

### `utils.js`
General utility functions for common operations:
- `extractVideoId(url)` - Extract video ID from Dailymotion URLs
- `isVideoPage(url)` - Check if a URL is a video page
- `cleanVideoTitle(title)` - Clean and normalize video titles
- `extractQuality(type, url)` - Extract quality/resolution from video type or URL
- `formatQualityLabel(video)` - Format quality labels for display
- `fixUrlEncoding(url)` - Fix URL encoding issues
- `isChunkedRangeUrl(url)` - Check if URL is a chunked/range request

### `storage.js`
Safe wrappers around Chrome storage API:
- `safeStorageGet(keys, callback)` - Safely get data from storage
- `safeStorageSet(items, callback)` - Safely set data in storage
- `safeStorageRemove(keys, callback)` - Safely remove data from storage
- `isExtensionContextValid()` - Check if extension context is valid
- `getDownloadProgressKey(downloadId)` - Get progress key for download
- `getDownloadStatusKey(downloadId)` - Get status key for download
- `getAllDownloadProgressKeys(callback)` - Get all download progress keys

### `messaging.js`
Safe wrappers around Chrome messaging API:
- `safeSendMessage(message, callback)` - Safely send messages to background
- `sendMessagePromise(message)` - Send message and return Promise
- `isExtensionContextValid()` - Check if extension context is valid
- `pingServiceWorker(callback)` - Wake up service worker
- `getVideoData(tabId, callback)` - Get video data for a tab
- `getDownloadInfo(downloadId, callback)` - Get download info
- `cancelDownload(downloadId, callback)` - Cancel a download

## Usage

### Option 1: Include in Manifest (Recommended for Development)
Add utility scripts to your manifest.json before the main scripts:

```json
{
  "content_scripts": [{
    "matches": ["*://*.dailymotion.com/*"],
    "js": [
      "scripts/utils.js",
      "scripts/storage.js",
      "scripts/messaging.js",
      "content/content.js"
    ]
  }]
}
```

### Option 2: Bundle During Build
Update your build process to concatenate utility scripts before the main scripts.

### Option 3: Copy Functions Directly
Copy the utility functions directly into files that need them (current approach).

## Benefits

1. **Code Reusability** - Write once, use everywhere
2. **Consistency** - Same logic across all scripts
3. **Maintainability** - Update in one place
4. **Error Handling** - Centralized error handling
5. **Type Safety** - Consistent function signatures

## Refactoring Opportunities

The following functions in existing files can be replaced with utility functions:

### `background/background.js`
- `extractVideoId()` → `utils.extractVideoId()`
- `isVideoPage()` → `utils.isVideoPage()`
- `getVideoTitleFromTab()` → Use `utils.cleanVideoTitle()` for title cleaning
- `fixUrlEncoding()` → `utils.fixUrlEncoding()`
- `isChunkedRangeUrl()` → `utils.isChunkedRangeUrl()`
- Multiple `chrome.storage.local.get/set` calls → `storage.safeStorageGet/Set()`

### `content/content.js`
- `extractVideoIdFromUrl()` → `utils.extractVideoId()`
- `isVideoPage()` → `utils.isVideoPage()`
- `getVideoTitle()` → Use `utils.cleanVideoTitle()`
- `extractQuality()` → `utils.extractQuality()`
- `formatQualityLabel()` → `utils.formatQualityLabel()`
- `safeStorageGet()` → `storage.safeStorageGet()`
- `safeSendMessage()` → `messaging.safeSendMessage()`

### `popup/popup.js`
- `extractVideoIdFromUrl()` → `utils.extractVideoId()`
- Title cleaning logic → `utils.cleanVideoTitle()`
- `extractQuality()` → `utils.extractQuality()`
- `formatQualityLabel()` → `utils.formatQualityLabel()`
- Multiple `chrome.runtime.sendMessage` calls → `messaging.safeSendMessage()`

## Next Steps

1. Update `manifest.json` to include utility scripts
2. Refactor existing code to use utility functions
3. Update build process if needed
4. Test thoroughly to ensure no regressions
