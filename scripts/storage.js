/**
 * Storage utility functions for Chrome extension
 * Provides safe wrappers around chrome.storage.local API
 */

/**
 * Safely get data from chrome.storage.local
 * Handles errors and extension context invalidation gracefully
 * 
 * @param {string|string[]|null} keys - Keys to retrieve (null = all keys)
 * @param {Function} callback - Callback function (items) => {}
 * @returns {void}
 */
function safeStorageGet(keys, callback) {
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
    console.warn('Chrome storage API not available');
    if (callback) callback({});
    return;
  }
  
  // Check if extension context is still valid
  if (!isExtensionContextValid()) {
    console.warn('Extension context invalidated, cannot access storage');
    if (callback) callback({});
    return;
  }
  
  try {
    chrome.storage.local.get(keys, (result) => {
      if (chrome.runtime.lastError) {
        const errorMessage = chrome.runtime.lastError.message || '';
        console.warn('Storage get error:', errorMessage);
        if (callback) callback({});
        return;
      }
      
      if (callback) {
        callback(result || {});
      }
    });
  } catch (e) {
    console.error('Error in safeStorageGet:', e);
    if (callback) callback({});
  }
}

/**
 * Safely set data in chrome.storage.local
 * Handles errors and extension context invalidation gracefully
 * 
 * @param {Object} items - Object with key-value pairs to store
 * @param {Function} callback - Optional callback function () => {}
 * @returns {Promise<void>} - Promise that resolves when storage is set
 */
function safeStorageSet(items, callback) {
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
    console.warn('Chrome storage API not available');
    if (callback) callback();
    return Promise.resolve();
  }
  
  // Check if extension context is still valid
  if (!isExtensionContextValid()) {
    console.warn('Extension context invalidated, cannot access storage');
    if (callback) callback();
    return Promise.resolve();
  }
  
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set(items, () => {
        if (chrome.runtime.lastError) {
          const errorMessage = chrome.runtime.lastError.message || '';
          console.warn('Storage set error:', errorMessage);
        }
        if (callback) callback();
        resolve();
      });
    } catch (e) {
      console.error('Error in safeStorageSet:', e);
      if (callback) callback();
      resolve();
    }
  });
}

/**
 * Safely remove data from chrome.storage.local
 * 
 * @param {string|string[]} keys - Keys to remove
 * @param {Function} callback - Optional callback function () => {}
 * @returns {void}
 */
function safeStorageRemove(keys, callback) {
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
    console.warn('Chrome storage API not available');
    if (callback) callback();
    return;
  }
  
  if (!isExtensionContextValid()) {
    console.warn('Extension context invalidated, cannot access storage');
    if (callback) callback();
    return;
  }
  
  try {
    chrome.storage.local.remove(keys, () => {
      if (chrome.runtime.lastError) {
        const errorMessage = chrome.runtime.lastError.message || '';
        console.warn('Storage remove error:', errorMessage);
      }
      if (callback) callback();
    });
  } catch (e) {
    console.error('Error in safeStorageRemove:', e);
    if (callback) callback();
  }
}

/**
 * Check if extension context is still valid
 * Useful for detecting when extension has been reloaded/removed
 * 
 * @returns {boolean} - True if extension context is valid
 */
function isExtensionContextValid() {
  try {
    // Try to access chrome.runtime.id - if context is invalid, this will throw
    return chrome.runtime && chrome.runtime.id !== undefined;
  } catch (e) {
    return false;
  }
}

/**
 * Get download progress key for a download ID
 * 
 * @param {string} downloadId - The download ID
 * @returns {string} - Storage key for download progress
 */
function getDownloadProgressKey(downloadId) {
  return `downloadProgress_${downloadId}`;
}

/**
 * Get download status key for a download ID
 * 
 * @param {string} downloadId - The download ID
 * @returns {string} - Storage key for download status
 */
function getDownloadStatusKey(downloadId) {
  return `downloadStatus_${downloadId}`;
}

/**
 * Get all download progress keys from storage
 * 
 * @param {Function} callback - Callback function (keys: string[]) => {}
 * @returns {void}
 */
function getAllDownloadProgressKeys(callback) {
  safeStorageGet(null, (items) => {
    const downloadKeys = Object.keys(items).filter(key => key.startsWith('downloadProgress_'));
    if (callback) callback(downloadKeys);
  });
}

// Export functions for use in different contexts
if (typeof module !== 'undefined' && module.exports) {
  // Node.js/CommonJS
  module.exports = {
    safeStorageGet,
    safeStorageSet,
    safeStorageRemove,
    isExtensionContextValid,
    getDownloadProgressKey,
    getDownloadStatusKey,
    getAllDownloadProgressKeys
  };
}
