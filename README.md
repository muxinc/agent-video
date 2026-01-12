# Agent Video

Give your AI agent the ability to record its screen and share video via Mux.

## What This Does

An agent can:
1. Navigate a browser with Playwright (video records automatically)
2. Add voice narration in a persona (optional, via ElevenLabs)
3. Close the browser to finalize the recording
4. Merge audio narration onto video
5. Upload to Mux
6. Return a shareable playback URL

**Use cases:**
- Proof of work - agent shows exactly what it did
- Narrated demos - agent explores your product with commentary
- Persona-based reviews - "roast mode", "interested prospect", "caveman", etc.
- Video bug reports - agent reproduces and records issues
- Async handoffs - agent records context for humans

## Setup

### 1. Install Playwright Plugin

Ensure the Playwright plugin is installed in Claude Code. Then configure it for video recording by updating `~/.claude/plugins/cache/claude-plugins-official/playwright/<version>/.mcp.json`:

```json
{
  "playwright": {
    "command": "npx",
    "args": [
      "@playwright/mcp@latest",
      "--save-video=1280x720",
      "--output-dir=/Users/YOU/Movies/agent-recordings"
    ]
  }
}
```

Restart Claude Code after updating.

### 2. Set API Credentials

Add to your shell profile (`~/.zshrc` or `~/.bashrc`):

```bash
# Mux (required)
export MUX_TOKEN_ID="your-mux-token-id"
export MUX_TOKEN_SECRET="your-mux-token-secret"

# ElevenLabs (optional, for voice narration)
export ELEVENLABS_API_KEY="your-elevenlabs-api-key"
export ELEVENLABS_VOICE_ID="JBFqnCBsd6RMkjVDRZzb"  # optional, has default
```

Then reload:
```bash
source ~/.zshrc
```

Get credentials from:
- [Mux Dashboard](https://dashboard.mux.com) > Settings > API Access Tokens
- [ElevenLabs](https://elevenlabs.io/app/settings/api-keys) > API Keys

### 3. Create Output Directory

```bash
mkdir -p ~/Movies/agent-recordings
```

### 4. Verify Setup

```bash
# Check Mux credentials
echo $MUX_TOKEN_ID

# Check output directory exists
ls ~/Movies/agent-recordings/
```

## Usage

The skill at `.claude/skills/record-screen/SKILL.md` teaches the agent how to record and upload.

Example prompts:

**Basic recording:**
> "Navigate to mux.com, click around, close the browser, upload the recording to Mux, and give me the link."

**With narration:**
> "Explore mux.com in 'roast mode' persona. First do a research pass to generate all the narration, then do a performance pass to record the video. Merge the audio and upload to Mux. Give me the link."

### How Narrated Recording Works (Two-Pass Approach)

To avoid dead air from agent thinking time, narrated recordings use two passes:

1. **Pass 1 - Research**: Agent explores pages, generates commentary, calls ElevenLabs TTS to create audio clips. No video recording yet.
2. **Pass 2 - Performance**: Agent replays the journey while recording. Pauses at each page for the exact duration of each audio clip.
3. **Post-production**: ffmpeg merges audio clips onto video at the correct timestamps.

The `bin/narrator.sh` helper script manages session state, audio generation, and timing synchronization.

The agent will:
1. Use Playwright to navigate and interact (video records automatically)
2. Generate commentary and call ElevenLabs TTS (if narration requested)
3. Pause for each narration's duration to sync timing
4. Close the browser to finalize the video
5. Merge audio clips onto video with ffmpeg
6. Upload to Mux API
7. Return the playback URL

### Running Autonomously

For fully autonomous operation without permission prompts, run Claude Code with:

```bash
claude --dangerously-skip-permissions
```

This allows the agent to execute bash commands, use Playwright, and upload to Mux without asking for confirmation at each step. Only use this in trusted environments.

## Files

```
.
├── README.md
├── bin/
│   └── narrator.sh               # Helper script for narrated recordings
└── .claude/
    └── skills/
        └── record-screen/
            └── SKILL.md           # Screen recording skill
```

### Making the Helper Script Executable

After cloning, make the narrator script executable:

```bash
chmod +x bin/narrator.sh
```

## Why Mux?

For a single recording you watch yourself, Mux isn't necessary. But Mux adds value when:

- **Sharing with others** - instant playback URL that works everywhere
- **Analytics** - know if the recipient watched, how much, what they rewatched
- **Scale** - managing many recordings over time
- **Professional delivery** - adaptive streaming, works on any device

The agent doesn't care about Mux. But the human receiving the video gets a polished, trackable experience.
