/**
 * Messaging utility functions for Chrome extension
 * Provides safe wrappers around chrome.runtime.sendMessage API
 */

/**
 * Safely send a message to the background script (service worker)
 * Handles errors and extension context invalidation gracefully
 * 
 * @param {Object} message - Message object to send
 * @param {Function} callback - Optional callback function (response) => {}
 * @returns {void}
 */
function safeSendMessage(message, callback) {
  if (typeof chrome === 'undefined' || !chrome.runtime) {
    console.warn('Chrome runtime API not available');
    if (callback) callback(null);
    return;
  }
  
  // Check if extension context is still valid
  if (!isExtensionContextValid()) {
    console.warn('Extension context invalidated, cannot send message');
    if (callback) callback(null);
    return;
  }
  
  try {
    if (message.action === 'cancelDownload') {
      console.log('🚫 [MESSAGING] Sending cancelDownload message:', message);
    }
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        const errorMessage = chrome.runtime.lastError.message || '';
        
        // Don't log connection errors as warnings - they're often expected
        // (e.g., when service worker is sleeping or extension is reloading)
        const isConnectionError = errorMessage.includes('Could not establish connection') ||
                                 errorMessage.includes('Receiving end does not exist') ||
                                 errorMessage.includes('Extension context invalidated');
        
        if (message.action === 'cancelDownload') {
          console.error('🚫 [MESSAGING] Error sending cancelDownload:', errorMessage);
        } else if (!isConnectionError) {
          console.warn('Message send error:', errorMessage);
        }
        
        if (callback) callback(null);
        return;
      }
      
      if (message.action === 'cancelDownload') {
        console.log('🚫 [MESSAGING] cancelDownload response received:', response);
      }
      
      if (callback) {
        callback(response);
      }
    });
  } catch (e) {
    console.error('Error in safeSendMessage:', e);
    if (callback) callback(null);
  }
}

/**
 * Send a message and return a Promise
 * Useful for async/await patterns
 * 
 * @param {Object} message - Message object to send
 * @returns {Promise<*>} - Promise that resolves with the response
 */
function sendMessagePromise(message) {
  return new Promise((resolve) => {
    safeSendMessage(message, (response) => {
      resolve(response);
    });
  });
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
 * Ping the service worker to wake it up
 * Useful before sending important messages
 * 
 * @param {Function} callback - Optional callback function () => {}
 * @returns {void}
 */
function pingServiceWorker(callback) {
  safeSendMessage({ action: 'ping' }, (response) => {
    // Ignore response, just use it to wake up the service worker
    if (callback) callback();
  });
}

/**
 * Get video data for a specific tab
 * 
 * @param {number} tabId - The tab ID
 * @param {Function} callback - Callback function (videoData) => {}
 * @returns {void}
 */
function getVideoData(tabId, callback) {
  pingServiceWorker(() => {
    safeSendMessage({ action: 'getVideoData', tabId: tabId }, (response) => {
      if (callback) {
        callback(response ? (response.videoData || { urls: [] }) : { urls: [] });
      }
    });
  });
}

/**
 * Get download info for a specific download
 * 
 * @param {string} downloadId - The download ID
 * @param {Function} callback - Callback function (downloadInfo) => {}
 * @returns {void}
 */
function getDownloadInfo(downloadId, callback) {
  safeSendMessage({ action: 'getDownloadInfo', downloadId: downloadId }, (response) => {
    if (callback) {
      callback(response && response.info ? response.info : null);
    }
  });
}

/**
 * Cancel a download
 * 
 * @param {string} downloadId - The download ID
 * @param {Function} callback - Optional callback function () => {}
 * @returns {void}
 */
function cancelDownload(downloadId, callback) {
  safeSendMessage({ action: 'cancelDownload', downloadId: downloadId }, (response) => {
    if (callback) callback();
  });
}

// Export functions for use in different contexts
if (typeof module !== 'undefined' && module.exports) {
  // Node.js/CommonJS
  module.exports = {
    safeSendMessage,
    sendMessagePromise,
    isExtensionContextValid,
    pingServiceWorker,
    getVideoData,
    getDownloadInfo,
    cancelDownload
  };
}
