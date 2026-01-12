---
name: record-screen
description: Record screen activity and upload to Mux for sharing. Use when you need to capture what's happening on screen, record yourself completing a task, create video demos, or provide proof of work. Works with Playwright for browser recording. Can add AI-generated voice narration with different personas.
---

# Screen Recording for Agents

Record browser activity with optional voice narration and upload to Mux.

## How It Works

The Playwright MCP is configured with `--save-video=1280x720`. Browser sessions are recorded to `~/Movies/agent-recordings/videos/`.

## Basic Recording (No Narration)

1. `browser_navigate` to URLs
2. `browser_click`, `browser_type`, `browser_snapshot` to interact
3. `browser_close` to end session

Video saves automatically when browser closes.

## Recording with Voice Narration

Use the `narrator.sh` helper script at `bin/narrator.sh`. The browser stays open for one continuous recording. Dead time (thinking, API calls) is cut out in post-production.

### 1. Initialize Session

```bash
./bin/narrator.sh init "roast"  # or any persona name
```

### 2. Navigate to First URL and Start Timer

```
browser_navigate to the first URL
```

Recording starts automatically when the browser opens.

**IMMEDIATELY after browser opens**, log the start time:

```bash
./bin/narrator.sh start
```

This syncs our timestamps with the video timeline. Must be called before any `mark` commands.

### 3. For Each Page

Repeat this cycle for each page:

**Step A: Take snapshot and analyze**
```
browser_snapshot
```
Look at the page. Generate your commentary based on what you see.

**Step B: Generate audio**
```bash
./bin/narrator.sh audio 1 "Your witty commentary here"
```
This calls ElevenLabs and returns the duration (e.g., 3.2s).

**Step C: Mark the timestamp**
```bash
./bin/narrator.sh mark 1
```
This logs the current time as the START of the good segment. Call this RIGHT BEFORE waiting.

**Step D: Wait for the audio duration**
```
browser_wait_for time=17.69
```
Use a SINGLE wait call matching the audio duration. Multiple scroll/wait cycles add overhead that breaks timing sync.

**Step E: Navigate to next page (or close if done)**
```
browser_navigate to next URL
```
The time between pages (thinking, API calls) will be cut out.

### 4. Close Browser

```
browser_close
```

### 5. Save the Recording

```bash
./bin/narrator.sh video
```

### 6. Finalize

```bash
./bin/narrator.sh finalize
```

This extracts only the "good" segments (the wait times after each mark), concatenates them, and overlays the audio.

### 7. Upload to Mux

```bash
./bin/narrator.sh upload
```

Returns the playback URL.

## Complete Example

```
./bin/narrator.sh init "roast"

browser_navigate → https://mux.com
./bin/narrator.sh start  ← IMMEDIATELY after browser opens

# Page 1: Homepage
browser_snapshot → (see the page, generate commentary)
./bin/narrator.sh audio 1 "Well well well, another video API..."
./bin/narrator.sh mark 1
browser_wait_for time=3.2  ← SINGLE wait matching audio duration

browser_navigate → https://mux.com/pricing

# Page 2: Pricing
browser_snapshot → (analyze pricing)
./bin/narrator.sh audio 2 "Ah, the pricing page. My favorite..."
./bin/narrator.sh mark 2
browser_wait_for time=2.8

browser_navigate → https://mux.com/player

# Page 3: Player
browser_snapshot → (analyze features)
./bin/narrator.sh audio 3 "Ooh, a player. Fancy..."
./bin/narrator.sh mark 3
browser_wait_for time=2.1

browser_close

./bin/narrator.sh video
./bin/narrator.sh finalize
./bin/narrator.sh upload
```

## How Segment Extraction Works

The recording captures everything, including dead time:

```
[Recording timeline]
0:00 - browser_navigate (video recording starts)
0:01 - narrator.sh start called ← T0 baseline set here
0:02 - Agent thinks, calls ElevenLabs (DEAD TIME - will be cut)
0:15 - mark 1 called ← segment 1 starts at 14s in video (0:15 - 0:01)
0:18 - wait ends ← segment 1 ends (3s of good video)
0:18 - Navigate to page 2
0:20 - Page 2 loads
0:22 - Agent thinks, calls ElevenLabs (DEAD TIME - will be cut)
0:35 - mark 2 called ← segment 2 starts at 34s in video (0:35 - 0:01)
0:38 - wait ends ← segment 2 ends (3s of good video)
...
```

The `start` command sets the baseline timestamp (T0). All `mark` offsets are calculated relative to this, so they align with the actual video timeline.

Finalize extracts segments [14s-17s], [34s-37s], etc. and concatenates them.

## Personas

**Interested Prospect**: "Ooh, what's this? A video API? Let me see what they've got..."

**Roast Mode**: "Wow, another hero section with a gradient. How delightfully 2019."

**Caveman**: "Me click button. Page change. Many word. Me confused."

**Noir Detective**: "The pricing page. I'd seen a thousand like it. But something felt different..."

**Excited Intern**: "Oh my gosh, THIS is where the analytics are! This is so cool!"

## Example Prompt

> "Create a narrated screen recording of mux.com in 'roast mode' persona. Visit the homepage, pricing, and player pages. Use narrator.sh to manage the session. Finalize and upload to Mux. Give me the link."

## Helper Script Reference

```
narrator.sh <command> [args]

Commands:
  init [persona]         Initialize new session
  start                  Log video start time (call RIGHT AFTER browser opens)
  audio <num> "text"     Generate audio clip (calls ElevenLabs, returns duration)
  mark <num>             Mark timestamp (start of good segment)
  video                  Save the recording
  status                 Show session status
  finalize               Extract segments, merge audio
  upload [video.mp4]     Upload to Mux
```

## Environment Variables

Required for upload:
- `MUX_TOKEN_ID`
- `MUX_TOKEN_SECRET`

Required for narration:
- `ELEVENLABS_API_KEY`
- `ELEVENLABS_VOICE_ID` (optional, has default)
