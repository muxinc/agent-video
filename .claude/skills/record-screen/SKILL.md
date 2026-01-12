---
name: record-screen
description: Record screen activity and upload to Mux for sharing. Use when you need to capture what's happening on screen, record yourself completing a task, create video demos, or provide proof of work. Works with Playwright for browser recording.
---

# Screen Recording for Agents

Record screen activity and upload to Mux. Fully autonomous - no human UI required.

## When to Use

- Recording yourself completing a task (proof of work)
- Creating video demos or tutorials
- Capturing browser activity while using Playwright
- Any time you need to show what happened on screen

## Prerequisites

- `ffmpeg` installed (`brew install ffmpeg`)
- Screen recording permission granted to terminal app
- `MUX_TOKEN_ID` and `MUX_TOKEN_SECRET` environment variables set

## Quick Start

### 1. Start Recording

```bash
mkdir -p "$HOME/Movies/agent-recordings"
RECORDING_ID=$(date +%s)
RECORDING_FILE="$HOME/Movies/agent-recordings/recording-$RECORDING_ID.mov"

# Find screen device index (usually "Capture screen 0")
# ffmpeg -f avfoundation -list_devices true -i "" 2>&1 | grep "Capture screen"
SCREEN_DEVICE="4"

# Start recording in background
ffmpeg -f avfoundation -framerate 30 -i "${SCREEN_DEVICE}:none" -c:v libx264 -pix_fmt yuv420p "$RECORDING_FILE" > /dev/null 2>&1 &
FFMPEG_PID=$!
sleep 2  # Let ffmpeg initialize

echo "Recording started: PID=$FFMPEG_PID FILE=$RECORDING_FILE"
```

### 2. Do Your Task

Now perform whatever actions you want to record. If using Playwright:
- `browser_navigate` to URLs
- `browser_click`, `browser_type` to interact
- `browser_snapshot` to verify state

### 3. Stop Recording

```bash
kill -INT $FFMPEG_PID
sleep 2  # Let ffmpeg finalize file
ls -la "$RECORDING_FILE"
```

### 4. Upload to Mux

```bash
# Create upload URL
UPLOAD_RESPONSE=$(curl -s -X POST https://api.mux.com/video/v1/uploads \
  -u "${MUX_TOKEN_ID}:${MUX_TOKEN_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "new_asset_settings": {
      "playback_policy": ["public"],
      "video_quality": "basic"
    },
    "cors_origin": "*"
  }')

UPLOAD_URL=$(echo "$UPLOAD_RESPONSE" | grep -o '"url":"[^"]*"' | cut -d'"' -f4)
UPLOAD_ID=$(echo "$UPLOAD_RESPONSE" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

# Upload file
curl -X PUT "$UPLOAD_URL" \
  -H "Content-Type: video/quicktime" \
  --data-binary "@$RECORDING_FILE"

# Wait for processing
sleep 5

# Get asset ID
ASSET_RESPONSE=$(curl -s -X GET "https://api.mux.com/video/v1/uploads/$UPLOAD_ID" \
  -u "${MUX_TOKEN_ID}:${MUX_TOKEN_SECRET}")
ASSET_ID=$(echo "$ASSET_RESPONSE" | grep -o '"asset_id":"[^"]*"' | cut -d'"' -f4)

# Get playback ID
PLAYBACK_RESPONSE=$(curl -s -X GET "https://api.mux.com/video/v1/assets/$ASSET_ID" \
  -u "${MUX_TOKEN_ID}:${MUX_TOKEN_SECRET}")
PLAYBACK_ID=$(echo "$PLAYBACK_RESPONSE" | grep -o '"playback_ids":\[{"id":"[^"]*"' | grep -o '"id":"[^"]*"' | cut -d'"' -f4)

echo "Watch URL: https://stream.new/$PLAYBACK_ID"
```

## Full Example: Record a Browser Demo

```bash
# Setup
mkdir -p "$HOME/Movies/agent-recordings"
RECORDING_ID=$(date +%s)
RECORDING_FILE="$HOME/Movies/agent-recordings/recording-$RECORDING_ID.mov"
SCREEN_DEVICE="4"

# Start recording
ffmpeg -f avfoundation -framerate 30 -i "${SCREEN_DEVICE}:none" -c:v libx264 -pix_fmt yuv420p "$RECORDING_FILE" > /dev/null 2>&1 &
FFMPEG_PID=$!
sleep 2
```

Then use Playwright to navigate and interact with the browser.

```bash
# Stop and upload
kill -INT $FFMPEG_PID
sleep 2
# ... upload steps from above
```

Result: A shareable Mux URL showing exactly what you did.

## Troubleshooting

### ffmpeg hangs without output
Screen recording permission not granted. Go to **System Preferences** > **Privacy & Security** > **Screen Recording** and enable your terminal app.

### Wrong screen captured
Run `ffmpeg -f avfoundation -list_devices true -i "" 2>&1 | grep "Capture screen"` to find correct device index.

### Mux upload fails
Check that `MUX_TOKEN_ID` and `MUX_TOKEN_SECRET` are set: `echo $MUX_TOKEN_ID`
