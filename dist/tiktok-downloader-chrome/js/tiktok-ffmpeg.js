/**
 * TikTok Downloader – FFmpeg for MP3 conversion.
 * Uses external helper iframe (helper.addoncrop.com), not WASM.
 */
(function () {
  "use strict";

  if (window.TikTokFFmpeg) return;

  const FFMPEG_HELPER_URL = "https://helper.addoncrop.com/?build=full";

  const CONTAINER = {
    MP4: "mp4",
    MPEG_TS: "mpeg-ts",
    UNKNOWN: "unknown",
  };

  function detectContainerFormat(buf) {
    if (!buf || buf.length < 8) return CONTAINER.UNKNOWN;
    if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return CONTAINER.MP4;
    if (buf.length >= 12 && buf[8] === 0x66 && buf[9] === 0x74 && buf[10] === 0x79 && buf[11] === 0x70) return CONTAINER.MP4;
    if (buf[0] === 0x47) return CONTAINER.MPEG_TS;
    return CONTAINER.UNKNOWN;
  }

  function notifyProgress(operationId, status, progress, message) {
    window.postMessage(
      { type: "TIKTOK_FFMPEG_PROGRESS", operationId, status, progress, message: message || "" },
      "*"
    );
  }

  async function getFFmpegInstance() {
    if (typeof window.FFmpegHelper === "undefined") {
      return new Promise(function (resolve, reject) {
        var check = setInterval(function () {
          if (typeof window.FFmpegHelper !== "undefined") {
            clearInterval(check);
            resolve(getFFmpegInstance());
          }
        }, 100);
        setTimeout(function () {
          clearInterval(check);
          reject(new Error("FFmpeg helper not available"));
        }, 15000);
      });
    }
    var ffmpeg = new window.FFmpegHelper(FFMPEG_HELPER_URL, "error");
    if (!ffmpeg.iframe) throw new Error("FFmpeg helper iframe not created");
    await ffmpeg.Ready;
    return ffmpeg;
  }

  async function convertVideoToAudio(videoArrayBuffer, format, bitrate, ffmpegInstance, operationId) {
    var cleanBitrate = (bitrate || "192k").replace(/\s+/g, "");
    var uint8Array = new Uint8Array(videoArrayBuffer);
    if (uint8Array.length === 0) throw new Error("Empty video buffer");
    var safeId = operationId || Date.now();
    var inputFilename = "video_" + safeId + ".mp4";
    var outputFilename = "output_" + safeId + "." + format;
    try {
      if (ffmpegInstance.FS && ffmpegInstance.FS.unlink) {
        ffmpegInstance.FS.unlink(inputFilename);
        ffmpegInstance.FS.unlink(outputFilename);
      }
    } catch (e) {}
    var ffmpegArgs = [
      "-i", inputFilename,
      "-vn", "-map", "0:a:0",
      "-c:a", format === "mp3" ? "libmp3lame" : format === "aac" ? "aac" : "flac",
      "-b:a", cleanBitrate,
      "-filter:a", "volume=1",
      "-f", format,
      outputFilename
    ];
    if (operationId) notifyProgress(operationId, "converting", 30, "Running FFmpeg...");
    var fileData = new Uint8Array(uint8Array.length);
    fileData.set(uint8Array);
    var result = await ffmpegInstance.run(
      "exec",
      { args: ffmpegArgs, files: { [inputFilename]: fileData }, outputFilename: outputFilename },
      [fileData.buffer],
      null
    );
    try {
      if (ffmpegInstance.FS && ffmpegInstance.FS.unlink) {
        ffmpegInstance.FS.unlink(inputFilename);
        ffmpegInstance.FS.unlink(outputFilename);
      }
    } catch (e) {}
    var outputBuffer = result && (result.outputBuffer || result);
    if (outputBuffer instanceof ArrayBuffer) return outputBuffer;
    if (outputBuffer instanceof Uint8Array) {
      var ab = outputBuffer.buffer;
      return ab.byteLength === outputBuffer.byteLength ? ab : ab.slice(outputBuffer.byteOffset, outputBuffer.byteOffset + outputBuffer.byteLength);
    }
    return outputBuffer;
  }

  async function convertToMp4(uint8Array, ffmpegInstance, operationId) {
    var detected = detectContainerFormat(uint8Array);
    var inputExt = (detected === CONTAINER.MPEG_TS || detected === CONTAINER.UNKNOWN) ? "ts" : "mpg";
    var safeId = operationId != null ? operationId : Date.now();
    var inputFilename = "input_" + safeId + "." + inputExt;
    var outputFilename = "output_" + safeId + ".mp4";
    try {
      if (ffmpegInstance.FS && ffmpegInstance.FS.unlink) {
        ffmpegInstance.FS.unlink(inputFilename);
        ffmpegInstance.FS.unlink(outputFilename);
      }
    } catch (e) {}
    if (operationId != null) notifyProgress(operationId, "converting", 20, "Converting to MP4...");
    var fileData = new Uint8Array(uint8Array.length);
    fileData.set(uint8Array);
    var ffmpegArgs = ["-i", inputFilename, "-c", "copy", "-movflags", "+faststart", "-f", "mp4", outputFilename];
    var result = await ffmpegInstance.run(
      "exec",
      { args: ffmpegArgs, files: { [inputFilename]: fileData }, outputFilename: outputFilename },
      [fileData.buffer],
      null
    );
    try {
      if (ffmpegInstance.FS && ffmpegInstance.FS.unlink) {
        ffmpegInstance.FS.unlink(inputFilename);
        ffmpegInstance.FS.unlink(outputFilename);
      }
    } catch (e) {}
    var outputBuffer = (result && (result.outputBuffer || result)) || null;
    if (!outputBuffer || !outputBuffer.byteLength) throw new Error("FFmpeg produced no output");
    return outputBuffer;
  }

  function toOwnedUint8Array(videoData) {
    if (!videoData) return null;
    var view = new Uint8Array(videoData);
    if (view.length === 0) return null;
    var copy = new Uint8Array(view.length);
    copy.set(view);
    return copy;
  }

  async function handleOperation(operationId, data) {
    var videoData = data && data.videoData;
    var format = (data && data.format) || "";
    var filename = data && data.filename;
    if (!videoData) {
      window.postMessage({ type: "TIKTOK_FFMPEG_ERROR", operationId, error: "No video data" }, "*");
      return;
    }
    var buffer = toOwnedUint8Array(videoData);
    if (!buffer || buffer.length === 0) {
      window.postMessage({ type: "TIKTOK_FFMPEG_ERROR", operationId, error: "Invalid or empty video data" }, "*");
      return;
    }
    var requestedFormat = format.toLowerCase();
    var isMp4Requested = requestedFormat === "mp4";

    if (isMp4Requested) {
      var outFilename = (filename || "video.mp4").replace(/\.mp3$/i, ".mp4");
      var container = detectContainerFormat(buffer);
      if (container === CONTAINER.MP4) {
        window.postMessage(
          { type: "TIKTOK_FFMPEG_RESULT", operationId, processedData: buffer.buffer, filename: outFilename, mimeType: "video/mp4" },
          "*",
          [buffer.buffer]
        );
        return;
      }
      try {
        if (operationId != null) notifyProgress(operationId, "converting", 0, "Initializing FFmpeg...");
        var ffmpegInstance = await getFFmpegInstance();
        var mp4Buffer = await convertToMp4(buffer, ffmpegInstance, operationId);
        window.postMessage(
          { type: "TIKTOK_FFMPEG_RESULT", operationId, processedData: mp4Buffer, filename: outFilename, mimeType: "video/mp4" },
          "*",
          [mp4Buffer]
        );
      } catch (err) {
        window.postMessage({ type: "TIKTOK_FFMPEG_ERROR", operationId, error: (err && err.message) || String(err) }, "*");
      }
      return;
    }

    try {
      notifyProgress(operationId, "converting", 0, "Initializing FFmpeg...");
      var inst = await getFFmpegInstance();
      notifyProgress(operationId, "converting", 10, "Converting to audio...");
      var audioArrayBuffer = await convertVideoToAudio(buffer, (format || "mp3").toLowerCase(), "192k", inst, operationId);
      var outName = (filename && !filename.toLowerCase().endsWith(".mp3")) ? filename.replace(/\.[^.]+$/, "") + ".mp3" : (filename || "audio.mp3");
      window.postMessage(
        { type: "TIKTOK_FFMPEG_RESULT", operationId, processedData: audioArrayBuffer, filename: outName, mimeType: "audio/mpeg" },
        "*",
        [audioArrayBuffer]
      );
    } catch (err) {
      window.postMessage({ type: "TIKTOK_FFMPEG_ERROR", operationId, error: (err && err.message) || String(err) }, "*");
    }
  }

  window.TikTokFFmpeg = { handleOperation: handleOperation, getFFmpegInstance: getFFmpegInstance };

  window.addEventListener("message", function (event) {
    if (event.source !== window || !event.data || event.data.type !== "TIKTOK_FFMPEG_OPERATION") return;
    var operationId = event.data.operationId;
    var data = event.data.data;
    if (data && data.error) {
      window.postMessage({ type: "TIKTOK_FFMPEG_ERROR", operationId, error: data.error }, "*");
      return;
    }
    handleOperation(operationId, data || {}).catch(function (err) {
      window.postMessage({ type: "TIKTOK_FFMPEG_ERROR", operationId, error: (err && err.message) || String(err) }, "*");
    });
  });
})();
