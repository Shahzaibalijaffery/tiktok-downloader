/**
 * Content script utility functions
 * Shared utilities for content script operations
 */

/**
 * Helper function to check if extension context is still valid
 * @returns {boolean} True if extension context is valid
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
 * Helper function to safely call chrome.storage.local.get with error handling
 * @param {string[]|null} keys - Keys to get (null for all)
 * @param {Function} callback - Callback function
 */
function safeStorageGet(keys, callback) {
  if (!isExtensionContextValid()) {
    console.warn('Extension context invalidated, cannot access storage');
    if (callback) callback({});
    return;
  }
  
  try {
    chrome.storage.local.get(keys, (result) => {
      if (chrome.runtime.lastError) {
        const errorMessage = chrome.runtime.lastError.message || '';
        if (errorMessage.includes('Extension context invalidated') || errorMessage.includes('message port closed')) {
          console.warn('Extension context invalidated during storage access');
          if (callback) callback({});
          return;
        }
      }
      if (callback) callback(result);
    });
  } catch (error) {
    console.warn('Error accessing storage:', error);
    if (callback) callback({});
  }
}

/**
 * Helper function to safely call chrome.runtime.sendMessage with error handling
 * @param {Object} message - Message to send
 * @param {Function} callback - Callback function
 */
function safeSendMessage(message, callback) {
  if (!isExtensionContextValid()) {
    // Don't log warning - extension context invalidation is expected when extension is reloaded
    // The calling code should check isExtensionContextValid() before calling this
    if (callback) callback({ success: false, error: 'Extension context invalidated' });
    return;
  }
  
  try {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        const errorMessage = chrome.runtime.lastError.message || '';
        if (errorMessage.includes('Extension context invalidated') || errorMessage.includes('message port closed')) {
          // Don't log warning - this is expected when extension is reloaded
          if (callback) callback({ success: false, error: 'Extension context invalidated' });
          return;
        }
      }
      if (callback) callback(response);
    });
  } catch (error) {
    // Don't log warning for context invalidation errors
    if (callback) callback({ success: false, error: error.message });
  }
}
