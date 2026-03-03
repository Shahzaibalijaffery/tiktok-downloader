const fs = require("fs");
const path = require("path");
const archiver = require("archiver");

// Files to include in the bundle (maintain directory structure)
const filesToInclude = [
  "manifest.json",
  "background/background.js",
  "background/state.js",
  "background/videoData.js",
  "background/cancelDownload.js",
  "background/startDownload.js",
  "js/ffmpeg-helper-umd.cjs",
  "js/ffmpeg-helper-umd.js",
  "js/tiktok-ffmpeg.js",
  "ffmpeg-runner.html",
  "ffmpeg-runner.js",
  "content/utils.js",
  "content/downloadNotifications.js",
  "content/downloadButton.js",
  "content/content.js",
  "content/downloadButton.css",
  "content/downloadNotifications.css",
  "popup/popup.html",
  "popup/popup.js",
  "popup/popup.css",
  "scripts/utils.js",
  "scripts/storage.js",
  "scripts/messaging.js",
  "icons/icon16.png",
  "icons/icon48.png",
  "icons/icon128.png",
  "assets/feed-download-icon.png",
];

/**
 * Create a zip from dist/. For Firefox, use manifest.firefox.json as manifest.json.
 * @param {'chrome'|'firefox'} target
 * @returns {Promise<void>}
 */
function createBundle(target = "chrome") {
  const isFirefox = target === "firefox";
  const zipName = isFirefox
    ? "tiktok-downloader-firefox.zip"
    : "tiktok-downloader-chrome.zip";
  const outputPath = path.join(__dirname, "dist", zipName);
  const output = fs.createWriteStream(outputPath);
  const archive = archiver("zip", {
    zlib: { level: 9 },
  });

  return new Promise((resolve, reject) => {
    output.on("close", () => {
      const sizeInMB = (archive.pointer() / 1024 / 1024).toFixed(2);
      console.log(
        `✅ ${isFirefox ? "Firefox" : "Chrome"} bundle: ${path.basename(outputPath)} (${sizeInMB} MB)`,
      );
      resolve();
    });

    archive.on("error", reject);
    archive.pipe(output);

    console.log(`📦 Creating ${isFirefox ? "Firefox" : "Chrome"} bundle...`);

    // Manifest: Chrome uses dist/manifest.json, Firefox uses manifest.firefox.json
    const manifestSource = isFirefox
      ? path.join(__dirname, "manifest.firefox.json")
      : path.join(__dirname, "dist", "manifest.json");
    if (fs.existsSync(manifestSource)) {
      archive.file(manifestSource, { name: "manifest.json" });
      console.log(`   ✓ Added: manifest.json (${target})`);
    } else {
      console.warn(`   ⚠️  manifest not found: ${manifestSource}`);
    }

    // Rest of files from dist (skip manifest.json for Firefox, we already added it)
    const otherFiles = filesToInclude.filter((f) => f !== "manifest.json");
    otherFiles.forEach((file) => {
      const filePath = path.join(__dirname, "dist", file);
      if (fs.existsSync(filePath)) {
        archive.file(filePath, { name: file });
        console.log(`   ✓ Added: ${file}`);
      } else {
        console.warn(`   ⚠️  Warning: ${file} not found in dist/, skipping...`);
      }
    });

    const sourceMapFiles = otherFiles.filter((f) => f.endsWith(".js"));
    sourceMapFiles.forEach((file) => {
      const mapPath = path.join(__dirname, "dist", file + ".map");
      if (fs.existsSync(mapPath)) {
        archive.file(mapPath, { name: file + ".map" });
        console.log(`   ✓ Added: ${file}.map`);
      }
    });

    archive.finalize();
  });
}

// Check if dist directory exists
if (!fs.existsSync(path.join(__dirname, "dist"))) {
  console.error(
    '❌ Error: dist/ directory not found. Run "npm run build" first.',
  );
  process.exit(1);
}

async function run() {
  console.log("🚀 Starting extension bundling...\n");
  await createBundle("chrome");
  await createBundle("firefox");
  console.log(
    "\n✅ Done. Load tiktok-downloader-firefox.zip in Firefox (Load Temporary Add-on → select zip).",
  );
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
