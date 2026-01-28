#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execSync, spawnSync } from "child_process";
import { writeFileSync, readFileSync, mkdirSync, existsSync, unlinkSync, appendFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = dirname(__dirname);
const SESSION_BASE = join(process.env.HOME, "Movies", "agent-recordings");

const AGENT_BROWSER_BIN = 'agent-browser';

// Helper to run agent-browser commands
function agentBrowser(command, options = {}) {
  console.error(`[narrator] Using agent-browser at: ${AGENT_BROWSER_BIN}`);
  const fullCommand = `${AGENT_BROWSER_BIN} ${command}`;
  console.error(`[narrator] $ ${fullCommand}`);
  try {
    const result = execSync(fullCommand, {
      encoding: "utf-8",
      timeout: options.timeout || 30000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result.trim();
  } catch (error) {
    console.error(`[narrator] Command failed: ${error.message}`);
    if (error.stderr) console.error(`[narrator] stderr: ${error.stderr}`);
    throw error;
  }
}

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

// Sleep helper
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Generate narration using Claude API - returns structured data with scroll cues
async function generateNarration(persona, pageUrl, snapshot, refs) {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not set - required for auto-generating narration");
  }

  // Build a list of refs with names for Claude to choose from
  const refsWithNames = Object.entries(refs)
    .filter(([id, info]) => info.name && info.role)
    .map(([id, info]) => `${id}: ${info.role} "${info.name}"`)
    .join('\n');

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "structured-outputs-2025-11-13",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 800,
      messages: [
        {
          role: "user",
          content: `You are narrating a screen recording of a website visit. Your persona: ${persona}

You are currently viewing: ${pageUrl}

Here is the accessibility snapshot of the page:
${snapshot}

Here are the available element refs you can scroll to (only use refs from this list):
${refsWithNames}

Generate narration that flows naturally through the page from top to bottom. As you mention different parts of the page, we'll scroll to show them.

Guidelines:
- Create 3-5 segments that flow naturally as one continuous narration
- Each segment should be 1-2 sentences
- Start at the top of the page and work your way down
- For scrollTo, use "top" for the first segment, then use ref IDs (e.g. "e13", "e83", "e121") for elements you want to scroll to
- ONLY use ref IDs that appear in the list above - do not invent selectors
- Pick refs for headings, sections, or landmarks that match what you're talking about
- Keep it natural and conversational - this will be converted to speech
- Stay in character throughout`,
        },
      ],
      output_format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            segments: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  text: {
                    type: "string",
                    description: "The spoken narration for this segment"
                  },
                  scrollTo: {
                    type: "string",
                    description: "Element ref ID to scroll to (e.g. 'e13', 'e83') or 'top'/'bottom'. Must be from the provided refs list."
                  }
                },
                required: ["text", "scrollTo"],
                additionalProperties: false
              }
            }
          },
          required: ["segments"],
          additionalProperties: false
        }
      }
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Claude API error: ${error}`);
  }

  const data = await response.json();

  // With structured outputs, the response is guaranteed to be valid JSON
  const narrationData = JSON.parse(data.content[0].text);

  return narrationData;
}

// Calculate segment start times based on character positions in the full text
function calculateSegmentTimings(segments, charStartTimes, characters) {
  const fullText = segments.map(s => s.text).join(' ');
  const segmentTimings = [];
  let charOffset = 0;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const segmentText = segment.text;

    // Find the start time for this segment
    const startTime = charOffset < charStartTimes.length ? charStartTimes[charOffset] : 0;

    // Calculate end position (add segment length + 1 for space)
    const endCharOffset = charOffset + segmentText.length;
    const endTime = endCharOffset < charStartTimes.length ? charStartTimes[endCharOffset] : charStartTimes[charStartTimes.length - 1];

    segmentTimings.push({
      text: segmentText,
      scrollTo: segment.scrollTo,
      startTimeSec: startTime,
      endTimeSec: endTime,
      startTimeMs: Math.round(startTime * 1000),
      endTimeMs: Math.round(endTime * 1000),
    });

    // Move offset past this segment + space
    charOffset = endCharOffset + 1;
  }

  return segmentTimings;
}

// Generate audio via ElevenLabs
async function generateAudio(text, clipPath, segments = null) {
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

  // Get duration and timing alignment from response
  const alignment = data.alignment || {};
  const charStartTimes = alignment.character_start_times_seconds || [];
  const charEndTimes = alignment.character_end_times_seconds || [];
  const characters = alignment.characters || [];

  console.error(`[narrator] ElevenLabs alignment: ${charStartTimes.length} char times`);

  const durationSec = charEndTimes.length > 0 ? charEndTimes[charEndTimes.length - 1] : 3;
  const durationMs = Math.round(durationSec * 1000);

  // Calculate segment timings if segments provided
  let segmentTimings = null;
  if (segments && segments.length > 0) {
    segmentTimings = calculateSegmentTimings(segments, charStartTimes, characters);
    console.error(`[narrator] Segment timings calculated for ${segmentTimings.length} segments`);
  }

  return { durationMs, durationSec, charStartTimes, charEndTimes, characters, segmentTimings };
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
    headers: { "Content-Type": "video/webm" },
    body: videoBuffer,
  });

  // Wait for processing
  await sleep(5000);

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
async function createNarratedRecording(persona, pages, globalHighlightDefaults) {
  const sessionId = Date.now();
  const sessionDir = join(SESSION_BASE, `session-${sessionId}`);
  mkdirSync(sessionDir, { recursive: true });

  console.error(`[narrator] Starting session: ${sessionDir}`);
  console.error(`[narrator] Persona: ${persona}`);
  console.error(`[narrator] Pages: ${pages.length}`);

  // Create debug log file
  const debugLogPath = join(sessionDir, "debug.log");
  const logDebug = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    console.error(`[narrator] ${msg}`);
    appendFileSync(debugLogPath, line);
  };

  // Video output path
  const videoPath = join(sessionDir, "recording.webm");
  const clips = [];
  const pageData = [];

  try {
    // === RESEARCH PASS ===
    // Visit each page, get snapshot, generate narration if not provided
    console.error(`[narrator] === RESEARCH PASS ===`);

    // Open browser for research
    console.error(`[narrator] Opening browser for research...`);
    agentBrowser(`set viewport 1280 720`);
    agentBrowser(`open "${pages[0].url}" --headed`, { timeout: 60000 });
    await sleep(2000);

    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      console.error(`[narrator] Researching page ${i + 1}: ${page.url}`);

      // Navigate if not first page
      if (i > 0) {
        agentBrowser(`open "${page.url}"`, { timeout: 60000 });
        await sleep(2000);
      }

      // Get snapshot of the page with refs
      console.error(`[narrator] Taking snapshot...`);
      const snapshotJson = agentBrowser(`snapshot --json`);

      // Parse JSON from output (skip any leading text/status lines)
      const jsonStart = snapshotJson.indexOf('{');
      const snapshotData = JSON.parse(snapshotJson.substring(jsonStart));
      const snapshot = snapshotData.data.snapshot;
      const refs = snapshotData.data.refs;

      logDebug(`Snapshot has ${Object.keys(refs).length} refs`);

      // Generate narration
      logDebug(`Generating narration with Claude...`);
      const narrationData = await generateNarration(persona, page.url, snapshot, refs);
      logDebug(`Generated ${narrationData.segments.length} segments`);
      for (const seg of narrationData.segments) {
        logDebug(`  Segment: "${seg.text.substring(0, 50)}..." -> scrollTo: ${seg.scrollTo}`);
      }

      pageData.push({
        url: page.url,
        narrationData,
        highlights: page.highlights,
        highlightDefaults: page.highlightDefaults,
      });
    }

    // Close browser after research
    console.error(`[narrator] Closing browser after research...`);
    agentBrowser(`close`);
    await sleep(1000);

    // === AUDIO GENERATION ===
    console.error(`[narrator] === GENERATING AUDIO ===`);
    for (let i = 0; i < pageData.length; i++) {
      const clipPath = join(sessionDir, `clip_${i + 1}.mp3`);
      console.error(`[narrator] Generating audio for page ${i + 1}...`);

      // Combine segment texts into full narration
      const segments = pageData[i].narrationData.segments;
      const fullNarration = segments.map(s => s.text).join(' ');

      const audioData = await generateAudio(fullNarration, clipPath, segments);
      clips.push({
        clipNum: i + 1,
        clipPath,
        segments,
        ...audioData
      });
      console.error(`[narrator] Audio duration: ${audioData.durationSec.toFixed(2)}s`);
      if (audioData.segmentTimings) {
        for (const st of audioData.segmentTimings) {
          console.error(`[narrator]   Segment at ${st.startTimeSec.toFixed(2)}s: scroll to ${st.scrollTo}`);
        }
      }
    }

    // === PERFORMANCE PASS (RECORDING) ===
    console.error(`[narrator] === PERFORMANCE PASS ===`);

    // Set viewport
    console.error(`[narrator] Setting viewport...`);
    agentBrowser(`set viewport 1280 720`);

    // Navigate to first page
    console.error(`[narrator] Navigating to first page: ${pageData[0].url}`);
    agentBrowser(`open "${pageData[0].url}" --headed`, { timeout: 60000 });
    await sleep(2000);

    // Start recording
    console.error(`[narrator] Starting video recording: ${videoPath}`);
    agentBrowser(`record start "${videoPath}"`);

    const recordingStartMs = Date.now();
    const marks = [];

    // Process each page
    for (let i = 0; i < pageData.length; i++) {
      const { url, narrationData, highlights, highlightDefaults } = pageData[i];
      const clipNum = i + 1;
      const clip = clips[i];

      console.error(`[narrator] Recording page ${clipNum}: ${url}`);

      // Navigate if not first page
      if (i > 0) {
        agentBrowser(`open "${url}"`, { timeout: 60000 });
        await sleep(1000);
      }

      // Mark timestamp
      const offsetMs = Date.now() - recordingStartMs;
      marks.push({ clipNum, offsetMs, durationMs: clip.durationMs });
      console.error(`[narrator] Marked clip ${clipNum} at offset ${offsetMs}ms`);

      // Enable smooth scrolling and log page dimensions
      agentBrowser(`eval "document.documentElement.style.scrollBehavior = 'smooth'"`);
      const pageDimensions = agentBrowser(`eval "JSON.stringify({ scrollHeight: document.body.scrollHeight, viewportHeight: window.innerHeight, scrollable: document.body.scrollHeight > window.innerHeight })"`);
      logDebug(`Page dimensions: ${pageDimensions}`);

      // Content-aware scrolling based on segment timings
      if (clip.segmentTimings && clip.segmentTimings.length > 0) {
        logDebug(`Using content-aware scrolling with ${clip.segmentTimings.length} segments`);

        const segmentStartTime = Date.now();

        for (let segIdx = 0; segIdx < clip.segmentTimings.length; segIdx++) {
          const segment = clip.segmentTimings[segIdx];
          const targetScrollTo = segment.scrollTo;

          // Wait until it's time to scroll to this segment
          const elapsedMs = Date.now() - segmentStartTime;
          const waitMs = segment.startTimeMs - elapsedMs;
          if (waitMs > 0) {
            await sleep(waitMs);
          }

          logDebug(`Scrolling to: ${targetScrollTo} at ${segment.startTimeSec.toFixed(2)}s`);

          // Scroll to the target element/position
          if (targetScrollTo === 'top') {
            logDebug(`Scrolling to top of page`);
            agentBrowser(`eval "window.scrollTo({ top: 0, behavior: 'smooth' })"`);
          } else if (targetScrollTo === 'bottom') {
            logDebug(`Scrolling to bottom of page`);
            agentBrowser(`eval "window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })"`);
          } else {
            // Use scrollintoview with ref directly
            try {
              agentBrowser(`scrollintoview @${targetScrollTo}`);
              logDebug(`Scrolled to ref @${targetScrollTo}`);
            } catch (e) {
              logDebug(`Failed to scroll to ref @${targetScrollTo}: ${e.message}`);
            }
          }
        }

        // Wait for the rest of the audio duration
        const totalElapsed = Date.now() - segmentStartTime;
        const remainingMs = clip.durationMs - totalElapsed;
        if (remainingMs > 0) {
          await sleep(remainingMs);
        }
      } else {
        // Fallback: simple timed scroll if no segment timings
        logDebug(`WARNING: Using fallback scrolling (no segment timings available)`);
        await sleep(clip.durationMs);
      }

      console.error(`[narrator] Completed segment ${clipNum}`);
    }

    // Stop recording
    console.error(`[narrator] Stopping video recording...`);
    agentBrowser(`record stop`);

    // Close browser
    console.error(`[narrator] Closing browser...`);
    agentBrowser(`close`);

    // Wait for video file to be written
    await sleep(1000);

    // Write marks file
    const marksPath = join(sessionDir, "marks.txt");
    const marksContent = marks
      .map((m) => `${m.clipNum} ${m.offsetMs} ${m.durationMs}`)
      .join("\n");
    writeFileSync(marksPath, marksContent);

    // === POST-PROCESSING ===
    console.error(`[narrator] === POST-PROCESSING ===`);

    // Extract segments
    console.error(`[narrator] Extracting segments...`);
    const concatListPath = join(sessionDir, "concat_list.txt");
    let concatList = "";

    for (const mark of marks) {
      const startSec = (mark.offsetMs / 1000).toFixed(3);
      const durationSec = (mark.durationMs / 1000).toFixed(3);
      const segmentPath = join(sessionDir, `segment_${mark.clipNum}.mp4`);

      console.error(`[narrator] Extracting segment ${mark.clipNum}: ${startSec}s for ${durationSec}s`);

      execSync(
        `ffmpeg -y -i "${videoPath}" -ss ${startSec} -t ${durationSec} -c:v libx264 -preset fast -crf 23 "${segmentPath}" 2>/dev/null`
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
    // Try to clean up browser
    try {
      agentBrowser(`close`);
    } catch (e) {}
    throw error;
  }
}

// Create MCP server
const server = new Server(
  {
    name: "narrator-mcp-server",
    version: "2.0.0",
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
          "Create a narrated screen recording of web pages. Uses a two-pass approach: first visits each page to analyze content and generate contextual narration using Claude, then records with smooth scrolling timed to the narration. Uploads final video to Mux and returns a playback URL.",
        inputSchema: {
          type: "object",
          properties: {
            persona: {
              type: "string",
              description:
                'The persona/character for the narration style. Can be anything: "sarcastic tech reviewer", "Gordon Ramsay reviewing websites", "a confused grandparent", "overenthusiastic salesperson", etc.',
            },
            highlightDefaults: {
              type: "object",
              description: "Default settings for all highlights (can be overridden per-highlight)",
              properties: {
                style: {
                  type: "string",
                  enum: ["border", "pulse", "arrow", "zoom", "circle", "rectangle"],
                  description: "Default highlight style"
                },
                linger: {
                  type: "number",
                  description: "Default linger time in seconds after phrase ends (default: 1.0)"
                }
              }
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
                  highlightDefaults: {
                    type: "object",
                    description: "Default highlight settings for this page (overrides global defaults)",
                    properties: {
                      style: { type: "string", enum: ["border", "pulse", "arrow", "zoom", "circle", "rectangle"] },
                      linger: { type: "number" }
                    }
                  },
                  highlights: {
                    type: "array",
                    description: "Array of elements or regions to highlight, synced to narration timing",
                    items: {
                      type: "object",
                      properties: {
                        onText: {
                          type: "string",
                          description: "The phrase in the narration that triggers this highlight (used for timing)"
                        },
                        selector: {
                          type: "string",
                          description: "CSS selector for element-based highlights"
                        },
                        x: {
                          type: "number",
                          description: "X coordinate for coordinate-based highlights (circle, rectangle)"
                        },
                        y: {
                          type: "number",
                          description: "Y coordinate for coordinate-based highlights"
                        },
                        radius: {
                          type: "number",
                          description: "Radius for circle highlights (default: 50)"
                        },
                        width: {
                          type: "number",
                          description: "Width for rectangle highlights (default: 100)"
                        },
                        height: {
                          type: "number",
                          description: "Height for rectangle highlights (default: 60)"
                        },
                        style: {
                          type: "string",
                          enum: ["border", "pulse", "arrow", "zoom", "circle", "rectangle"],
                          description: "Highlight style. Element-based: border, pulse, arrow, zoom. Coordinate-based: circle, rectangle"
                        },
                        linger: {
                          type: "number",
                          description: "How long to keep highlight visible after phrase ends (seconds)"
                        }
                      },
                      required: ["onText"]
                    }
                  }
                },
                required: ["url"],
              },
            },
          },
          required: ["persona", "pages"],
        },
      },
      {
        name: "get_element_bounds",
        description:
          "Get the bounding box coordinates of a DOM element on a page. Useful for discovering coordinates for coordinate-based highlights (circle, rectangle).",
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "The URL of the page to inspect"
            },
            selector: {
              type: "string",
              description: "CSS selector for the element"
            }
          },
          required: ["url", "selector"]
        }
      }
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "create_narrated_recording") {
    try {
      const result = await createNarratedRecording(args.persona, args.pages, args.highlightDefaults);
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

  if (name === "get_element_bounds") {
    try {
      agentBrowser(`open "${args.url}"`, { timeout: 60000 });
      await sleep(1000);

      const result = agentBrowser(`get box "${args.selector}" --json`);
      agentBrowser(`close`);

      const bounds = JSON.parse(result);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(bounds, null, 2),
          },
        ],
      };
    } catch (error) {
      try {
        agentBrowser(`close`);
      } catch (e) {}

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
  console.error("[narrator] MCP server started (using agent-browser SDK)");
}

main().catch((error) => {
  console.error("[narrator] Fatal error:", error);
  process.exit(1);
});
