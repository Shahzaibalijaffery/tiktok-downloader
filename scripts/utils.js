function extractVideoId(url) {
  // Logic removed – video IDs are no longer used.
  return null;
}

function isVideoPage(url) {
  // Logic removed – we treat all TikTok tabs the same for detection/cleanup.
  return true;
}

function cleanVideoTitle(title) {
  if (!title || typeof title !== "string") {
    return null;
  }

  try {
    // Remove common suffixes: " - TikTok", " | TikTok", etc.
    let cleaned = title.replace(/\s*[-|]\s*TikTok.*$/i, "").trim();
    cleaned = cleaned.replace(/\s*[-|]\s*video\s+TikTok.*$/i, "").trim();

    // Remove "TikTok Video" and "TikTok Video Player" from end or as full title
    cleaned = cleaned
      .replace(/\s*[-|]\s*TikTok\s+Video\s+Player.*$/i, "")
      .trim();
    cleaned = cleaned.replace(/\s*[-|]\s*TikTok\s+Video\s*$/i, "").trim();
    cleaned = cleaned
      .replace(/^TikTok\s+Video\s+Player\s*[-|]?\s*/i, "")
      .trim();
    cleaned = cleaned.replace(/^TikTok\s+Video\s*$/i, "").trim();

    if (!cleaned || cleaned.length < 2) return null;

    cleaned = cleaned
      .replace(/\s+video\s+TikTok(\s+Player)?\s*$/i, "")
      .trim();

    const lowerTitle = cleaned.toLowerCase();
    if (
      lowerTitle.match(
        /^(tiktok|video|tiktok video|video tiktok|tiktok video player|video player)$/i,
      )
    ) {
      return null;
    }

    return cleaned;
  } catch (e) {
    return null;
  }
}

function normalizeToTiktokQuality(height) {
  if (
    height == null ||
    (typeof height !== "number" && typeof height !== "string")
  )
    return null;
  var n = typeof height === "string" ? parseInt(height, 10) : height;
  if (isNaN(n)) return null;
  if (n <= 240) return 240;
  if (n <= 380) return 380;
  if (n <= 480) return 480;
  if (n <= 720) return 720;
  if (n <= 1080) return 1080;
  if (n <= 1440) return 1440;
  if (n <= 2160) return 2160;
  return 4320;
}

function getQualityDisplayLabel(quality) {
  if (quality == null) return "Unknown Quality";
  var standard = normalizeToTiktokQuality(quality);
  return standard != null ? standard + "p" : "Unknown Quality";
}

function getQualityTag(qualityLabel) {
  if (!qualityLabel || typeof qualityLabel !== "string") return null;
  const s = qualityLabel.trim();
  if (s === "MP3") return "MP3";
  const match = s.match(/(\d+)p/i);
  if (!match) return null;
  const p = parseInt(match[1], 10);
  if (p <= 480) return "SD";
  if (p <= 720) return "HD";
  if (p <= 1080) return "FHD";
  if (p <= 1440) return "QHD";
  if (p <= 2160) return "4K";
  if (p <= 4320) return "8K";
  return null;
}

function extractQuality(type, url = "") {
  if (!type && !url) {
    return null;
  }

  // Try to extract from type first (e.g., "mp4-1080p", "hls-1080p", "hls-720p")
  if (type) {
    const match = type.match(/(\d+)p/i);
    if (match) {
      return parseInt(match[1], 10);
    }
  }

  // Try to extract from URL if type doesn't have quality
  if (url) {
    const match = url.match(/(\d+)p/i);
    if (match) {
      return parseInt(match[1], 10);
    }
  }

  return null;
}

function formatQualityLabel(video) {
  if (!video || !video.type) {
    return "Video";
  }

  const quality = extractQuality(video.type, video.url);
  const isMP4 = video.type.includes("mp4") && !video.type.includes("m3u8");
  const isHLS = video.type.includes("m3u8") || video.type.includes("hls");

  let qualityLabel = "";

  if (quality != null) {
    qualityLabel = getQualityDisplayLabel(quality);
  } else if (isHLS && video.type) {
    var typeMatch = video.type.match(/hls-(\d+)p?/i);
    if (typeMatch) {
      qualityLabel = getQualityDisplayLabel(parseInt(typeMatch[1], 10));
    } else if (video.url) {
      if (video.url.includes("4320") || video.url.includes("8k")) {
        qualityLabel = "4320p";
      } else if (video.url.includes("2160") || video.url.includes("4k")) {
        qualityLabel = "2160p";
      } else if (video.url.includes("1440")) {
        qualityLabel = "1440p";
      } else if (video.url.includes("1080") || video.url.includes("hd")) {
        qualityLabel = "1080p";
      } else if (video.url.includes("720")) {
        qualityLabel = "720p";
      } else if (video.url.includes("480")) {
        qualityLabel = "480p";
      } else if (
        video.url.includes("380") ||
        video.url.includes("360") ||
        video.url.includes("288")
      ) {
        qualityLabel = "380p";
      } else if (video.url.includes("240")) {
        qualityLabel = "240p";
      } else {
        qualityLabel = "Unknown Quality";
      }
    } else {
      qualityLabel = "Stream";
    }
  } else {
    if (isHLS) {
      qualityLabel = "Stream";
    } else if (isMP4) {
      qualityLabel = "MP4";
    } else {
      qualityLabel = video.type || "Video";
    }
  }

  // Add format suffix only for MP4; HLS shows quality only (e.g. 720p, 1080p)
  if (isMP4) {
    return `${qualityLabel} (MP4)`;
  }
  return qualityLabel;
}

function fixUrlEncoding(url) {
  if (!url || typeof url !== "string") {
    return url;
  }

  // Fix \\u0026 to & and other common encoding issues
  return url
    .replace(/\\u0026/g, "&")
    .replace(/\\u003d/g, "=")
    .replace(/\\u002f/g, "/");
}

function isChunkedRangeUrl(url) {
  if (!url || typeof url !== "string") {
    return false;
  }

  try {
    const urlObj = new URL(url);
    // Range URLs often contain /range/ in the path or a range query param
    if (urlObj.pathname.includes("/range/")) return true;
    if (urlObj.searchParams.has("range") || urlObj.searchParams.has("bytes")) {
      return true;
    }
  } catch (e) {
    // URL parsing failed, check string patterns
  }

  // Check for range request patterns in URL string
  return (
    url.includes("range=") ||
    url.includes("bytes=") ||
    url.match(/\/\d+-\d+\.mp4/) !== null ||
    url.includes("/range/")
  ); // Range URLs often contain /range/ in the path
}

function normalizeUrlForDownload(url) {
  if (!url || typeof url !== "string") {
    return url;
  }

  try {
    const urlObj = new URL(url);
    // Remove query params that don't affect the actual video content
    urlObj.searchParams.delete("range");
    urlObj.searchParams.delete("t");
    urlObj.searchParams.delete("timestamp");
    return urlObj.toString();
  } catch (e) {
    return url;
  }
}

function generateDownloadId() {
  return `download_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function isMP4(type) {
  if (!type || typeof type !== "string") {
    return false;
  }
  return type.includes("mp4") && !type.includes("m3u8");
}

function isHLS(type) {
  if (!type || typeof type !== "string") {
    return false;
  }
  return type.includes("m3u8") || type.includes("hls");
}

function validateJsonResponse(response, responseText) {
  if (!response || !responseText) {
    return false;
  }

  // Check content-type
  const contentType = response.headers.get("content-type") || "";
  const isJson =
    contentType.includes("application/json") ||
    contentType.includes("text/json");

  // Check if response starts with HTML tags (not JSON)
  const trimmed = responseText.trim();
  if (
    trimmed.startsWith("<!DOCTYPE") ||
    trimmed.startsWith("<html") ||
    trimmed.startsWith("<")
  ) {
    return false;
  }

  // If content-type doesn't indicate JSON, check if it looks like JSON
  if (!isJson && !trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return false;
  }

  return true;
}

function formatFileSize(bytes, decimals = 2) {
  if (!bytes || bytes === 0) {
    return "0 Bytes";
  }

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
}

function isFileTooSmall(fileSize, minSizeBytes = 300 * 1024) {
  if (fileSize === null || fileSize === undefined) {
    return false; // Unknown size, don't filter
  }
  return fileSize < minSizeBytes;
}

function cleanupIndexedDBBlob(blobId) {
  try {
    const request = indexedDB.open("TikTokDownloaderDB", 1);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(["blobs"], "readwrite");
      tx.objectStore("blobs").delete(blobId);
      tx.oncomplete = () => {
        db.close();
        console.log("Cleaned up IndexedDB blob:", blobId);
      };
      tx.onerror = () => {
        console.error("Failed to clean up IndexedDB blob:", tx.error);
        db.close();
      };
    };
    request.onerror = () => {
      console.error("Failed to open IndexedDB for cleanup:", request.error);
    };
  } catch (error) {
    console.error("Error cleaning up IndexedDB:", error);
  }
}

function isFeedPage(url) {
  // Logic removed; feed-specific handling is no longer needed.
  return false;
}

function sanitizeFilenameForDownload(filename) {
  if (!filename || typeof filename !== "string") return "tiktok_video.mp4";
  const invalid = /[\\/:*?"<>|\u0000-\u001F]/g;
  const lastDot = filename.lastIndexOf(".");
  const ext = lastDot > 0 ? filename.slice(lastDot) : "";
  let base = lastDot > 0 ? filename.slice(0, lastDot) : filename;
  base = base.replace(invalid, " ");
  base = base.replace(/[^\x20-\x7E]/g, " ");
  base = base.replace(/\s+/g, " ").trim();
  base = base.replace(/^[.\s]+|[.\s]+$/g, "");
  if (!base) base = "tiktok_video";
  const extSafe = /\.(mp4|ts|mkv|webm|mpegts|mp3)$/i.test(ext) ? ext : ".mp4";
  const sanitized = base + extSafe;
  return sanitized.length > 200
    ? base.slice(0, 200 - extSafe.length) + extSafe
    : sanitized;
}

// Export functions for use in different contexts
if (typeof module !== "undefined" && module.exports) {
  // Node.js/CommonJS
  module.exports = {
    extractVideoId,
    isVideoPage,
    cleanVideoTitle,
    extractQuality,
    formatQualityLabel,
    getQualityTag,
    fixUrlEncoding,
    isChunkedRangeUrl,
    normalizeUrlForDownload,
    generateDownloadId,
    isMP4,
    validateJsonResponse,
    formatFileSize,
    isFileTooSmall,
    cleanupIndexedDBBlob,
    isFeedPage,
    sanitizeFilenameForDownload,
  };
}
