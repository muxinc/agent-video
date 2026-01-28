# Agent Video

Give your AI agent the ability to record its screen and share video via Mux.

## What This Does

An MCP server that creates narrated screen recordings using a two-pass approach:

1. **Research pass** - Visits each page, analyzes the content, and generates contextual narration using Claude
2. **Performance pass** - Records smooth scroll animations timed to the generated audio
3. **Post-production** - Merges audio with video and uploads to Mux

The narration is based on what the tool actually sees on each page, so commentary is always relevant and contextual.

**Use cases:**
- Proof of work - agent shows exactly what it did
- Narrated demos - agent explores your product with commentary
- Persona-based reviews - "roast mode", "interested prospect", "caveman", etc.
- Video bug reports - agent reproduces and records issues
- Async handoffs - agent records context for humans

## Setup

### 1. Install dependencies

```bash
cd mcp-server
npm install
npx playwright install chromium
```

### 2. Set environment variables

Create a `.env` file in the project root:

```bash
ANTHROPIC_API_KEY="your-api-key"
ELEVENLABS_API_KEY="your-api-key"
MUX_TOKEN_ID="your-token-id"
MUX_TOKEN_SECRET="your-token-secret"
```

Get credentials from:
- [Anthropic Console](https://console.anthropic.com) > API Keys (for narration generation)
- [ElevenLabs](https://elevenlabs.io/app/settings/api-keys) > API Keys (for text-to-speech)
- [Mux Dashboard](https://dashboard.mux.com) > Settings > API Access Tokens (for video hosting)

### 3. Add to Claude Code settings

Add this MCP server to your Claude Code configuration. Edit `~/.claude/settings.json` (global) or `.claude/settings.local.json` (project):

```json
{
  "mcpServers": {
    "narrator": {
      "command": "node",
      "args": ["/path/to/agent-video/mcp-server/index.js"],
      "env": {}
    }
  }
}
```

Replace `/path/to/agent-video` with the actual path to this project.

### 4. Create output directory

```bash
mkdir -p ~/Movies/agent-recordings
```

## Tool: create_narrated_recording

Creates a narrated screen recording of web pages.

### Parameters

- `persona` (string, required): The character/style for narration. Can be anything you describe:
  - "a sarcastic tech reviewer who's seen it all"
  - "Gordon Ramsay reviewing websites"
  - "a confused grandparent trying to understand the internet"
  - "an overenthusiastic startup founder"

- `pages` (array, required): Pages to visit
  - `url` (string, required): The URL to visit
  - `narration` (string, optional): Custom narration. If omitted, auto-generated based on page content.

### Example (auto-generated narration)

```json
{
  "persona": "a jaded Silicon Valley investor who's seen a thousand pitch decks",
  "pages": [
    { "url": "https://example.com" },
    { "url": "https://example.com/about" },
    { "url": "https://example.com/pricing" }
  ]
}
```

### Example (custom narration)

```json
{
  "persona": "documentary narrator",
  "pages": [
    {
      "url": "https://example.com",
      "narration": "Here we observe the landing page in its natural habitat."
    }
  ]
}
```

### Returns

```json
{
  "success": true,
  "playbackUrl": "https://stream.mux.com/abc123",
  "sessionDir": "/Users/.../session-123456",
  "pagesRecorded": 3
}
```

## How It Works

1. **Research pass**: Opens browser, visits each page, takes snapshots
2. **Narration generation**: Sends snapshots to Claude API to generate contextual narration in the specified persona
3. **Audio generation**: Converts narration to speech via ElevenLabs
4. **Performance pass**: Opens browser again, records smooth scrolling timed to audio duration
5. **Post-production**: Extracts segments, merges audio with precise timing via ffmpeg
6. **Upload**: Sends final video to Mux, returns playback URL

## Why Mux?

For a single recording you watch yourself, Mux isn't necessary. But Mux adds value when:

- **Sharing with others** - instant playback URL that works everywhere
- **Analytics** - know if the recipient watched, how much, what they rewatched
- **Scale** - managing many recordings over time
- **Professional delivery** - adaptive streaming, works on any device

The agent doesn't care about Mux. But the human receiving the video gets a polished, trackable experience.
