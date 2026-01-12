# Agent Video

Give your AI agent the ability to record its screen and share video via Mux.

## What This Does

An agent can:
1. Start screen recording (ffmpeg)
2. Do something (e.g., navigate a browser with Playwright)
3. Stop recording
4. Upload to Mux
5. Return a shareable playback URL

**Use cases:**
- Proof of work - agent shows exactly what it did
- Automated demos - agent records itself using your product
- Video bug reports - agent reproduces and records issues
- Async handoffs - agent records context for humans

## Setup

### 1. Install ffmpeg

```bash
brew install ffmpeg
```

### 2. Grant Screen Recording Permission

The terminal app running the agent needs screen recording access:

1. Open **System Preferences** > **Privacy & Security** > **Screen Recording**
2. Enable your terminal app (Terminal, iTerm2, Warp, etc.)
3. Restart the terminal

### 3. Set Mux Credentials

Add to your shell profile (`~/.zshrc` or `~/.bashrc`):

```bash
export MUX_TOKEN_ID="your-mux-token-id"
export MUX_TOKEN_SECRET="your-mux-token-secret"
```

Then reload:
```bash
source ~/.zshrc
```

Get credentials from [Mux Dashboard](https://dashboard.mux.com) > Settings > API Access Tokens.

### 4. Verify Setup

```bash
# Check ffmpeg
which ffmpeg

# Check Mux credentials
echo $MUX_TOKEN_ID

# Check screen recording permission (should list devices without hanging)
ffmpeg -f avfoundation -list_devices true -i "" 2>&1 | grep "Capture screen"
```

## Usage

The skill at `.claude/skills/record-screen.md` teaches the agent how to record and upload.

Example prompt:
> "Record yourself navigating to mux.com and clicking around, then upload to Mux and give me the link."

The agent will:
1. Start ffmpeg screen recording in background
2. Use Playwright to navigate and interact
3. Stop recording
4. Upload to Mux API
5. Return the playback URL

## Files

```
.
├── README.md
└── .claude/
    └── skills/
        └── record-screen/
            └── SKILL.md           # Screen recording skill
```

## Why Mux?

For a single recording you watch yourself, Mux isn't necessary. But Mux adds value when:

- **Sharing with others** - instant playback URL that works everywhere
- **Analytics** - know if the recipient watched, how much, what they rewatched
- **Scale** - managing many recordings over time
- **Professional delivery** - adaptive streaming, works on any device

The agent doesn't care about Mux. But the human receiving the video gets a polished, trackable experience.
