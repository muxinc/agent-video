#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { chromium } from "playwright";
import { execSync, exec } from "child_process";
import { writeFileSync, readFileSync, mkdirSync, existsSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = dirname(__dirname);
const SESSION_BASE = join(process.env.HOME, "Movies", "agent-recordings");

// Load environment variables
function loadEnv() {
  const envPath = join(PROJECT_DIR, ".env");
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      if (line && !line.startsWith("#")) {
        const [key, ...valueParts] = line.split("=");
        const value = valueParts.join("=").replace(/^["']|["']$/g, "");
        process.env[key.trim()] = value.trim();
      }
    }
  }
}

loadEnv();

// Helper to get timestamp in ms
function getTimestampMs() {
  return Date.now();
}

// Generate audio via ElevenLabs
async function generateAudio(text, clipPath) {
  const voiceId = process.env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb";
  const apiKey = process.env.ELEVENLABS_API_KEY;

  if (!apiKey) {
    throw new Error("ELEVENLABS_API_KEY not set");
  }

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: text,
        model_id: "eleven_multilingual_v2",
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`ElevenLabs API error: ${error}`);
  }

  const data = await response.json();

  // Decode and save audio
  const audioBuffer = Buffer.from(data.audio_base64, "base64");
  writeFileSync(clipPath, audioBuffer);

  // Get duration from alignment data
  const endTimes = data.alignment?.character_end_times_seconds || [];
  const durationSec = endTimes.length > 0 ? endTimes[endTimes.length - 1] : 3;
  const durationMs = Math.round(durationSec * 1000);

  return { durationMs, durationSec };
}

// Upload to Mux
async function uploadToMux(videoPath) {
  const tokenId = process.env.MUX_TOKEN_ID;
  const tokenSecret = process.env.MUX_TOKEN_SECRET;

  if (!tokenId || !tokenSecret) {
    throw new Error("MUX_TOKEN_ID and MUX_TOKEN_SECRET must be set");
  }

  // Create upload
  const createResponse = await fetch("https://api.mux.com/video/v1/uploads", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(`${tokenId}:${tokenSecret}`).toString("base64")}`,
    },
    body: JSON.stringify({
      new_asset_settings: {
        playback_policy: ["public"],
        video_quality: "basic",
      },
      cors_origin: "*",
    }),
  });

  const uploadData = await createResponse.json();
  const uploadUrl = uploadData.data.url;
  const uploadId = uploadData.data.id;

  // Upload file
  const videoBuffer = readFileSync(videoPath);
  await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "video/mp4" },
    body: videoBuffer,
  });

  // Wait for processing
  await new Promise((r) => setTimeout(r, 5000));

  // Get asset ID
  const uploadStatusResponse = await fetch(
    `https://api.mux.com/video/v1/uploads/${uploadId}`,
    {
      headers: {
        Authorization: `Basic ${Buffer.from(`${tokenId}:${tokenSecret}`).toString("base64")}`,
      },
    }
  );
  const uploadStatus = await uploadStatusResponse.json();
  const assetId = uploadStatus.data.asset_id;

  // Get playback ID
  const assetResponse = await fetch(
    `https://api.mux.com/video/v1/assets/${assetId}`,
    {
      headers: {
        Authorization: `Basic ${Buffer.from(`${tokenId}:${tokenSecret}`).toString("base64")}`,
      },
    }
  );
  const assetData = await assetResponse.json();
  const playbackId = assetData.data.playback_ids[0].id;

  return `https://stream.mux.com/${playbackId}`;
}

// Main recording function
async function createNarratedRecording(persona, pages) {
  const sessionId = Date.now();
  const sessionDir = join(SESSION_BASE, `session-${sessionId}`);
  mkdirSync(sessionDir, { recursive: true });

  // Ensure videos directory exists
  const videosDir = join(SESSION_BASE, "videos");
  mkdirSync(videosDir, { recursive: true });

  console.error(`[narrator] Starting session: ${sessionDir}`);
  console.error(`[narrator] Persona: ${persona}`);
  console.error(`[narrator] Pages: ${pages.length}`);

  // Launch browser with video recording
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: {
      dir: videosDir,
      size: { width: 1280, height: 720 },
    },
  });
  const page = await context.newPage();

  // Track marks for segment extraction
  const marks = [];
  const clips = [];

  // Set T0 baseline immediately when recording starts (before any navigation)
  const recordingStartMs = getTimestampMs();
  console.error(`[narrator] Recording started at T0: ${recordingStartMs}`);

  try {
    // Navigate to first page
    console.error(`[narrator] Navigating to first page: ${pages[0].url}`);
    await page.goto(pages[0].url, { waitUntil: "networkidle" });
    await page.waitForTimeout(500); // Brief settle

    // Process each page
    for (let i = 0; i < pages.length; i++) {
      const { url, narration } = pages[i];
      const clipNum = i + 1;

      console.error(`[narrator] Processing page ${clipNum}: ${url}`);

      // Navigate if not first page
      if (i > 0) {
        await page.goto(url, { waitUntil: "networkidle" });
        await page.waitForTimeout(500);
      }

      // Generate audio
      const clipPath = join(sessionDir, `clip_${clipNum}.mp3`);
      console.error(`[narrator] Generating audio for clip ${clipNum}...`);
      const { durationMs, durationSec } = await generateAudio(narration, clipPath);
      console.error(`[narrator] Audio duration: ${durationSec}s`);
      clips.push({ clipNum, durationMs, clipPath });

      // Mark timestamp (start of good segment)
      const offsetMs = getTimestampMs() - recordingStartMs;
      marks.push({ clipNum, offsetMs, durationMs });
      console.error(`[narrator] Marked clip ${clipNum} at offset ${offsetMs}ms`);

      // Smooth scroll animation during narration
      const scrollDistance = 150;
      const scrollTime = durationMs * 0.25;
      const pauseTime = durationMs * 0.50;
      const steps = 20;
      const stepDelay = scrollTime / steps;
      const stepDistance = scrollDistance / steps;

      // Scroll down (25% of duration)
      for (let s = 0; s < steps; s++) {
        await page.evaluate((y) => window.scrollBy(0, y), stepDistance);
        await page.waitForTimeout(stepDelay);
      }

      // Pause in middle (50% of duration)
      await page.waitForTimeout(pauseTime);

      // Scroll back up (25% of duration)
      for (let s = 0; s < steps; s++) {
        await page.evaluate((y) => window.scrollBy(0, y), -stepDistance);
        await page.waitForTimeout(stepDelay);
      }

      console.error(`[narrator] Completed segment ${clipNum}`);
    }

    // Close browser to finalize video
    console.error(`[narrator] Closing browser...`);
    await page.close();
    await context.close();
    await browser.close();

    // Find the video file
    await new Promise((r) => setTimeout(r, 1000)); // Wait for video to be written
    const videoFiles = execSync(`ls -t "${videosDir}"/*.webm 2>/dev/null || true`)
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean);

    if (videoFiles.length === 0) {
      throw new Error("No video file found");
    }

    const rawVideoPath = videoFiles[0];
    const recordingPath = join(sessionDir, "recording.webm");
    execSync(`mv "${rawVideoPath}" "${recordingPath}"`);
    console.error(`[narrator] Video saved: ${recordingPath}`);

    // Write marks file
    const marksPath = join(sessionDir, "marks.txt");
    const marksContent = marks
      .map((m) => `${m.clipNum} ${m.offsetMs} ${m.durationMs}`)
      .join("\n");
    writeFileSync(marksPath, marksContent);

    // Finalize: Extract segments
    console.error(`[narrator] Extracting segments...`);
    const concatListPath = join(sessionDir, "concat_list.txt");
    let concatList = "";

    for (const mark of marks) {
      const startSec = (mark.offsetMs / 1000).toFixed(3);
      const durationSec = (mark.durationMs / 1000).toFixed(3);
      const segmentPath = join(sessionDir, `segment_${mark.clipNum}.mp4`);

      console.error(
        `[narrator] Extracting segment ${mark.clipNum}: ${startSec}s for ${durationSec}s`
      );

      execSync(
        `ffmpeg -y -i "${recordingPath}" -ss ${startSec} -t ${durationSec} -c:v libx264 -preset fast -crf 23 "${segmentPath}" 2>/dev/null`
      );

      concatList += `file '${segmentPath}'\n`;
    }

    writeFileSync(concatListPath, concatList);

    // Concatenate segments
    console.error(`[narrator] Concatenating segments...`);
    const concatPath = join(sessionDir, "concat.mp4");
    execSync(
      `ffmpeg -y -f concat -safe 0 -i "${concatListPath}" -c copy "${concatPath}" 2>/dev/null`
    );

    // Build audio filter
    console.error(`[narrator] Mixing audio...`);
    let audioInputs = "";
    let audioFilter = "";
    let audioLabels = "";
    let cumulativeOffsetMs = 0;

    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const inputNum = i + 1;

      audioInputs += ` -i "${clip.clipPath}"`;
      audioFilter += `[${inputNum}]adelay=${cumulativeOffsetMs}|${cumulativeOffsetMs}[a${inputNum}];`;
      audioLabels += `[a${inputNum}]`;

      // Get actual segment duration for next offset
      const segmentPath = join(sessionDir, `segment_${clip.clipNum}.mp4`);
      const segDuration = execSync(
        `ffprobe -v error -show_entries format=duration -of csv=p=0 "${segmentPath}" 2>/dev/null`
      )
        .toString()
        .trim();
      cumulativeOffsetMs += Math.round(parseFloat(segDuration) * 1000);
    }

    audioFilter += `${audioLabels}amix=inputs=${clips.length}:duration=longest[aout]`;

    // Merge audio
    const outputPath = join(sessionDir, "output.mp4");
    execSync(
      `ffmpeg -y -i "${concatPath}"${audioInputs} -filter_complex "${audioFilter}" -map 0:v -map "[aout]" -c:v copy -c:a aac "${outputPath}" 2>/dev/null`
    );

    console.error(`[narrator] Output created: ${outputPath}`);

    // Upload to Mux
    console.error(`[narrator] Uploading to Mux...`);
    const playbackUrl = await uploadToMux(outputPath);
    console.error(`[narrator] Upload complete: ${playbackUrl}`);

    // Cleanup intermediate files
    for (const mark of marks) {
      try {
        unlinkSync(join(sessionDir, `segment_${mark.clipNum}.mp4`));
      } catch (e) {}
    }
    try {
      unlinkSync(concatPath);
      unlinkSync(concatListPath);
    } catch (e) {}

    return {
      success: true,
      playbackUrl,
      sessionDir,
      pagesRecorded: pages.length,
    };
  } catch (error) {
    console.error(`[narrator] Error: ${error.message}`);
    try {
      await browser.close();
    } catch (e) {}
    throw error;
  }
}

// Create MCP server
const server = new Server(
  {
    name: "narrator-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "create_narrated_recording",
        description:
          "Create a narrated screen recording of web pages. Opens a browser, visits each page, generates AI voice narration, records with smooth scrolling animation, and uploads the final video to Mux. Returns a playback URL.",
        inputSchema: {
          type: "object",
          properties: {
            persona: {
              type: "string",
              description:
                'The persona/character for the narration style. Examples: "roast" (sarcastic critique), "interested prospect" (curious explorer), "noir detective" (dramatic storytelling), "excited intern" (enthusiastic), "caveman" (simple observations)',
            },
            pages: {
              type: "array",
              description: "Array of pages to visit and narrate",
              items: {
                type: "object",
                properties: {
                  url: {
                    type: "string",
                    description: "The URL to visit",
                  },
                  narration: {
                    type: "string",
                    description:
                      "The narration text for this page (will be converted to speech)",
                  },
                },
                required: ["url", "narration"],
              },
            },
          },
          required: ["persona", "pages"],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "create_narrated_recording") {
    try {
      const result = await createNarratedRecording(args.persona, args.pages);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: error.message }, null, 2),
          },
        ],
        isError: true,
      };
    }
  }

  return {
    content: [{ type: "text", text: `Unknown tool: ${name}` }],
    isError: true,
  };
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[narrator] MCP server started");
}

main().catch((error) => {
  console.error("[narrator] Fatal error:", error);
  process.exit(1);
});
