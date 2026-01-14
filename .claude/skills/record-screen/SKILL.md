---
name: record-screen
description: Record screen activity and upload to Mux for sharing. Use when you need to capture what's happening on screen, record yourself completing a task, create video demos, or provide proof of work. Can add AI-generated voice narration with different personas.
---

# Screen Recording with Narration

Create narrated screen recordings using the `create_narrated_recording` MCP tool.

## How It Works

The tool opens a browser, visits each page you specify, generates AI voice narration for each page, records with smooth scrolling animation, and uploads the final video to Mux.

**One tool call does everything.** No multi-step workflows.

## Usage

Call the `create_narrated_recording` tool with:

1. **persona**: The character/style for narration
2. **pages**: Array of `{url, narration}` objects

### Example Tool Call

```json
{
  "persona": "roast",
  "pages": [
    {
      "url": "https://mux.com",
      "narration": "Well well well, another video API. Let's see what they've got here."
    },
    {
      "url": "https://mux.com/pricing",
      "narration": "Ah, the pricing page. Everyone's favorite destination."
    }
  ]
}
```

The tool returns a Mux playback URL like `https://stream.mux.com/abc123`.

## Personas

Choose a persona that matches the desired narration style:

- **roast**: Sarcastic critique. "Wow, another hero section with a gradient. How delightfully 2019."
- **interested prospect**: Curious exploration. "Ooh, what's this? Let me see what they've got..."
- **noir detective**: Dramatic storytelling. "The pricing page. I'd seen a thousand like it. But something felt different..."
- **excited intern**: Enthusiastic discovery. "Oh my gosh, THIS is where the analytics are! This is so cool!"
- **caveman**: Simple observations. "Me click button. Page change. Many word. Me confused."

## Example Prompts

> "Record mux.com with the roast persona. Visit homepage and pricing."

> "Create a noir detective walkthrough of stripe.com/docs"

> "Record yourself exploring vercel.com as an excited intern"

## What the Tool Does Internally

1. Launches a browser with video recording enabled (1280x720)
2. For each page:
   - Navigates to the URL
   - Generates audio via ElevenLabs text-to-speech
   - Records a scrolling animation timed to the audio duration
3. Closes browser
4. Extracts video segments and merges with audio using ffmpeg
5. Uploads final video to Mux
6. Returns the playback URL

## Requirements

Environment variables must be set:
- `ELEVENLABS_API_KEY` - For voice generation
- `MUX_TOKEN_ID` - For video upload
- `MUX_TOKEN_SECRET` - For video upload
