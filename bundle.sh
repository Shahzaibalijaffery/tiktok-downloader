#!/bin/bash

# Simple shell script to bundle the Chrome extension (without minification)
# For minified builds, use: npm run bundle

VERSION=$(grep -o '"version": "[^"]*"' manifest.json | cut -d'"' -f4)
OUTPUT="dailymotion-downloader-v${VERSION}.zip"

echo "🚀 Bundling Chrome extension (unminified)..."
echo "📦 Creating: ${OUTPUT}"
echo "💡 For minified build, use: npm run bundle"

# Create zip file with all necessary files (maintain directory structure)
zip -r "${OUTPUT}" \
  manifest.json \
  background/ \
  content/ \
  popup/ \
  icons/ \
  -x "*.DS_Store" "*.git*" "node_modules/*" "*.zip" "*.log" "dist/*" "*.map" "build.js" "bundle.js" "bundle.sh" "package*.json"

if [ $? -eq 0 ]; then
  SIZE=$(du -h "${OUTPUT}" | cut -f1)
  echo "✅ Bundle created successfully!"
  echo "📦 File: ${OUTPUT}"
  echo "📊 Size: ${SIZE}"
else
  echo "❌ Error creating bundle"
  exit 1
fi
