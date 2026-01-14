# Narrator MCP Server

An MCP server that provides a single tool for creating narrated screen recordings.

## Setup

### 1. Install dependencies

```bash
cd mcp-server
npm install
npx playwright install chromium
```

### 2. Set environment variables

Create a `.env` file in the project root with:

```bash
ELEVENLABS_API_KEY="your-api-key"
MUX_TOKEN_ID="your-token-id"
MUX_TOKEN_SECRET="your-token-secret"
```

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

## Tool: create_narrated_recording

Creates a narrated screen recording of web pages.

### Parameters

- `persona` (string): The character/style for narration
  - "roast" - Sarcastic critique
  - "interested prospect" - Curious exploration
  - "noir detective" - Dramatic storytelling
  - "excited intern" - Enthusiastic discovery
  - "caveman" - Simple observations

- `pages` (array): Pages to visit and narrate
  - `url` (string): The URL to visit
  - `narration` (string): The narration text for this page

### Example

```json
{
  "persona": "roast",
  "pages": [
    {
      "url": "https://mux.com",
      "narration": "Well well well, another video API."
    },
    {
      "url": "https://mux.com/pricing",
      "narration": "Ah, the pricing page."
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
  "pagesRecorded": 2
}
```

## How It Works

1. Launches Chromium with video recording (1280x720)
2. For each page:
   - Navigates to URL
   - Generates audio via ElevenLabs TTS
   - Records a scroll animation timed to audio duration
3. Closes browser
4. Extracts segments using ffmpeg
5. Merges audio with precise timing
6. Uploads to Mux
7. Returns playback URL
