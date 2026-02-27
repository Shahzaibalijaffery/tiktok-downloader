/**
 * Dailymotion Downloader – main-world FFmpeg (same pattern as sound-catcher).
 * Converts video blob to MP3 or MP4; passthrough only when input is already valid MP4.
 * Uses FFmpegHelper iframe.
 */
(function () {
  "use strict";

  if (window.DailymotionFFmpeg) return;

  const FFMPEG_HELPER_URL = "https://helper.addoncrop.com/?build=full";

  const CONTAINER = {
    MP4: "mp4",
    MPEG_TS: "mpeg-ts",
    UNKNOWN: "unknown",
  };

  /**
   * Detect container format from magic bytes.
   * @param {Uint8Array} buf - First chunk of the file (at least 12 bytes)
   * @returns {"mp4"|"mpeg-ts"|"unknown"}
   */
  function detectContainerFormat(buf) {
    if (!buf || buf.length < 8) return CONTAINER.UNKNOWN;
    // MP4: "ftyp" at offset 4 (ISO base media)
    if (
      buf[4] === 0x66 &&
      buf[5] === 0x74 &&
      buf[6] === 0x79 &&
      buf[7] === 0x70
    ) {
      return CONTAINER.MP4;
    }
    // Optional: "ftyp" can appear after a small leading box (e.g. 8 bytes)
    if (buf.length >= 12 && buf[8] === 0x66 && buf[9] === 0x74 && buf[10] === 0x79 && buf[11] === 0x70) {
      return CONTAINER.MP4;
    }
    // MPEG-TS: sync byte 0x47 at start
    if (buf[0] === 0x47) return CONTAINER.MPEG_TS;
    return CONTAINER.UNKNOWN;
  }

  function notifyProgress(operationId, status, progress, message = "") {
    window.postMessage(
      {
        type: "DAILYMOTION_FFMPEG_PROGRESS",
        operationId,
        status,
        progress,
        message,
      },
      "*"
    );
  }

  async function getFFmpegInstance() {
    if (typeof window.FFmpegHelper === "undefined") {
      return new Promise((resolve, reject) => {
        const check = setInterval(() => {
          if (typeof window.FFmpegHelper !== "undefined") {
            clearInterval(check);
            resolve(getFFmpegInstance());
          }
        }, 100);
        setTimeout(() => {
          clearInterval(check);
          reject(new Error("FFmpegHelper not available"));
        }, 15000);
      });
    }
    const ffmpeg = new window.FFmpegHelper(FFMPEG_HELPER_URL, "error");
    if (!ffmpeg.iframe) throw new Error("FFmpeg iframe not created");
    await ffmpeg.Ready;
    return ffmpeg;
  }

  /**
   * Convert video (ArrayBuffer) to audio. Uses buffer directly to avoid Blob + FileReader copies.
   * @param {ArrayBuffer} videoArrayBuffer - Video bytes (e.g. MP4)
   * @param {string} format - "mp3" | "aac" | "flac"
   * @param {string} bitrate - e.g. "192k"
   * @param {object} ffmpegInstance - FFmpegHelper instance
   * @param {string|number} operationId - For progress
   * @returns {Promise<ArrayBuffer>} - Audio output buffer (transferable)
   */
  async function convertVideoToAudio(
    videoArrayBuffer,
    format,
    bitrate,
    ffmpegInstance,
    operationId
  ) {
    const cleanBitrate = (bitrate || "192k").replace(/\s+/g, "");
    const uint8Array = new Uint8Array(videoArrayBuffer);
    const safeId = operationId || Date.now();
    const inputFilename = `video_${safeId}.mp4`;
    const outputFilename = `output_${safeId}.${format}`;

    try {
      if (ffmpegInstance.FS?.unlink) {
        ffmpegInstance.FS.unlink(inputFilename);
        ffmpegInstance.FS.unlink(outputFilename);
      }
    } catch (e) {}

    const ffmpegArgs = [
      "-i",
      inputFilename,
      "-vn",
      "-map",
      "0:a:0",
      "-c:a",
      format === "mp3" ? "libmp3lame" : format === "aac" ? "aac" : "flac",
      "-b:a",
      cleanBitrate,
      "-filter:a",
      "volume=1",
      "-f",
      format,
      outputFilename,
    ];

    if (operationId) {
      notifyProgress(operationId, "converting", 30, "Running FFmpeg...");
    }

    const result = await ffmpegInstance.run(
      "exec",
      {
        args: ffmpegArgs,
        files: { [inputFilename]: uint8Array },
        outputFilename,
      },
      [uint8Array.buffer],
      null
    );

    if (ffmpegInstance.FS?.unlink) {
      try {
        ffmpegInstance.FS.unlink(inputFilename);
        ffmpegInstance.FS.unlink(outputFilename);
      } catch (e) {}
    }

    const outputBuffer = result?.outputBuffer || result;
    if (outputBuffer instanceof ArrayBuffer) return outputBuffer;
    if (outputBuffer instanceof Uint8Array) {
      const ab = outputBuffer.buffer;
      return ab.byteLength === outputBuffer.byteLength
        ? ab
        : ab.slice(outputBuffer.byteOffset, outputBuffer.byteOffset + outputBuffer.byteLength);
    }
    return outputBuffer;
  }

  /**
   * Convert non-MP4 video (e.g. MPEG-TS from HLS) to MP4 via FFmpeg (remux or transcode).
   * @param {Uint8Array} uint8Array - Raw video bytes
   * @param {object} ffmpegInstance - FFmpegHelper instance
   * @param {string|number} operationId - For progress
   * @returns {Promise<ArrayBuffer>} - MP4 output
   */
  async function convertToMp4(uint8Array, ffmpegInstance, operationId) {
    const detected = detectContainerFormat(uint8Array);
    // HLS segments are usually MPEG-TS; use .ts for unknown as well
    const inputExt = detected === CONTAINER.MPEG_TS || detected === CONTAINER.UNKNOWN ? "ts" : "mpg";
    const safeId = operationId ?? Date.now();
    const inputFilename = `input_${safeId}.${inputExt}`;
    const outputFilename = `output_${safeId}.mp4`;

    try {
      if (ffmpegInstance.FS?.unlink) {
        try {
          ffmpegInstance.FS.unlink(inputFilename);
          ffmpegInstance.FS.unlink(outputFilename);
        } catch (e) {}
      }
    } catch (e) {}

    if (operationId != null) {
      notifyProgress(operationId, "converting", 20, "Converting to MP4...");
    }

    // Remux to MP4 (copy streams, no re-encode). FFmpeg picks format from extension.
    const ffmpegArgs = [
      "-i",
      inputFilename,
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      outputFilename,
    ];

    const result = await ffmpegInstance.run(
      "exec",
      {
        args: ffmpegArgs,
        files: { [inputFilename]: uint8Array },
        outputFilename,
      },
      [uint8Array.buffer],
      null
    );

    if (ffmpegInstance.FS?.unlink) {
      try {
        ffmpegInstance.FS.unlink(inputFilename);
        ffmpegInstance.FS.unlink(outputFilename);
      } catch (e) {}
    }

    const outputBuffer = result?.outputBuffer ?? result;
    if (!outputBuffer || !outputBuffer.byteLength) {
      throw new Error("FFmpeg produced no output");
    }
    return outputBuffer;
  }

  async function handleOperation(operationId, data) {
    const { videoData, format, filename } = data;
    if (!videoData) {
      window.postMessage(
        {
          type: "DAILYMOTION_FFMPEG_ERROR",
          operationId,
          error: "No video data",
        },
        "*"
      );
      return;
    }

    const buffer = new Uint8Array(videoData);
    const requestedFormat = (format || "").toLowerCase();
    const isMp4Requested = requestedFormat === "mp4";

    if (isMp4Requested) {
      const outFilename = (filename || "video.mp4").replace(/\.mp3$/i, ".mp4");
      const container = detectContainerFormat(buffer);

      if (container === CONTAINER.MP4) {
        // Already valid MP4 – passthrough
        window.postMessage(
          {
            type: "DAILYMOTION_FFMPEG_RESULT",
            operationId,
            processedData: buffer.buffer,
            filename: outFilename,
            mimeType: "video/mp4",
          },
          "*",
          [buffer.buffer]
        );
        return;
      }

      // Not MP4 (e.g. MPEG-TS from HLS) – convert with FFmpeg
      try {
        if (operationId != null) {
          notifyProgress(operationId, "converting", 0, "Initializing FFmpeg...");
        }
        const ffmpegInstance = await getFFmpegInstance();
        const mp4Buffer = await convertToMp4(buffer, ffmpegInstance, operationId);
        window.postMessage(
          {
            type: "DAILYMOTION_FFMPEG_RESULT",
            operationId,
            processedData: mp4Buffer,
            filename: outFilename,
            mimeType: "video/mp4",
          },
          "*",
          [mp4Buffer]
        );
      } catch (err) {
        window.postMessage(
          {
            type: "DAILYMOTION_FFMPEG_ERROR",
            operationId,
            error: err?.message || String(err),
          },
          "*"
        );
      }
      return;
    }

    // MP3 (or other audio) path – pass buffer directly to avoid Blob + FileReader copies
    try {
      notifyProgress(operationId, "converting", 0, "Initializing FFmpeg...");
      const ffmpegInstance = await getFFmpegInstance();
      notifyProgress(operationId, "converting", 10, "Converting to audio...");
      const audioArrayBuffer = await convertVideoToAudio(
        buffer,
        (format || "mp3").toLowerCase(),
        "192k",
        ffmpegInstance,
        operationId
      );
      const outFilename =
        filename && !filename.toLowerCase().endsWith(".mp3")
          ? filename.replace(/\.[^.]+$/, "") + ".mp3"
          : filename || "audio.mp3";

      window.postMessage(
        {
          type: "DAILYMOTION_FFMPEG_RESULT",
          operationId,
          processedData: audioArrayBuffer,
          filename: outFilename,
          mimeType: "audio/mpeg",
        },
        "*",
        [audioArrayBuffer]
      );
    } catch (err) {
      window.postMessage(
        {
          type: "DAILYMOTION_FFMPEG_ERROR",
          operationId,
          error: err?.message || String(err),
        },
        "*"
      );
    }
  }

  window.DailymotionFFmpeg = { handleOperation, getFFmpegInstance };

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.type !== "DAILYMOTION_FFMPEG_OPERATION") return;
    const { operationId, data } = event.data;
    if (data?.error) {
      window.postMessage(
        {
          type: "DAILYMOTION_FFMPEG_ERROR",
          operationId,
          error: data.error,
        },
        "*"
      );
      return;
    }
    handleOperation(operationId, data || {}).catch((err) => {
      window.postMessage(
        {
          type: "DAILYMOTION_FFMPEG_ERROR",
          operationId,
          error: err?.message || String(err),
        },
        "*"
      );
    });
  });
})();
