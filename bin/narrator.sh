#!/bin/bash
#
# Narrator - Helper script for narrated screen recordings
#
# Approach: Single recording session, extract segments in post-production
#
# Workflow:
#   1. narrator.sh init [persona]        Initialize session
#   2. browser_navigate to first URL     Recording starts
#   3. browser_snapshot                  Agent sees page
#   4. narrator.sh audio <num> "text"    Generate audio, get duration
#   5. narrator.sh mark <num>            Log timestamp (start of good segment)
#   6. browser_wait_for time=<duration>  Record the good segment
#   7. Repeat 3-6 for each page
#   8. browser_close                     Recording ends
#   9. narrator.sh video                 Save the video file
#  10. narrator.sh finalize              Extract segments, merge audio
#  11. narrator.sh upload                Upload to Mux
#

set -e

# Auto-load .env file if it exists (check common locations)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

if [[ -f "$PROJECT_DIR/.env" ]]; then
    export $(grep -v '^#' "$PROJECT_DIR/.env" | xargs)
elif [[ -f "$HOME/.env" ]]; then
    export $(grep -v '^#' "$HOME/.env" | xargs)
fi

SESSION_BASE="$HOME/Movies/agent-recordings"
SESSION_FILE="$SESSION_BASE/.current_session"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

get_timestamp_ms() {
    # Returns milliseconds since epoch
    python3 -c "import time; print(int(time.time() * 1000))"
}

cmd_init() {
    local persona="${1:-default}"
    local session_id=$(date +%s)
    local session_dir="$SESSION_BASE/session-$session_id"

    mkdir -p "$session_dir"

    # Save session info
    echo "$session_dir" > "$SESSION_FILE"
    echo "$persona" > "$session_dir/persona.txt"
    echo "0" > "$session_dir/clip_count.txt"

    # Initialize marks file (timestamps for segment extraction)
    echo "# clip_num start_ms duration_ms" > "$session_dir/marks.txt"

    echo -e "${GREEN}Session initialized:${NC} $session_dir"
    echo -e "${GREEN}Persona:${NC} $persona"
    echo ""
    echo "Workflow:"
    echo "  1. browser_navigate to first URL"
    echo "  2. narrator.sh start  ← IMMEDIATELY after browser opens"
    echo "  3. For each page:"
    echo "     a. browser_snapshot"
    echo "     b. narrator.sh audio <num> \"commentary\""
    echo "     c. narrator.sh mark <num>"
    echo "     d. browser_wait_for time=<duration>"
    echo "     e. browser_navigate to next page (or close if done)"
    echo "  4. browser_close"
    echo "  5. narrator.sh video"
    echo "  6. narrator.sh finalize"
    echo "  7. narrator.sh upload"
}

cmd_start() {
    local session_dir=$(cat "$SESSION_FILE" 2>/dev/null)
    if [[ -z "$session_dir" || ! -d "$session_dir" ]]; then
        echo -e "${RED}Error:${NC} No active session. Run 'init' first."
        exit 1
    fi

    # Log the video start time
    local now_ms=$(get_timestamp_ms)
    echo "$now_ms" > "$session_dir/recording_start_ms.txt"

    echo -e "${GREEN}Recording start time logged${NC}"
    echo ""
    echo -e "${BLUE}Next:${NC} browser_snapshot, then narrator.sh audio 1 \"...\""
}

cmd_audio() {
    local clip_num="$1"
    local narration="$2"

    if [[ -z "$clip_num" || -z "$narration" ]]; then
        echo -e "${RED}Error:${NC} Usage: narrator.sh audio <clip_num> \"narration text\""
        exit 1
    fi

    local session_dir=$(cat "$SESSION_FILE" 2>/dev/null)
    if [[ -z "$session_dir" || ! -d "$session_dir" ]]; then
        echo -e "${RED}Error:${NC} No active session. Run 'init' first."
        exit 1
    fi

    local clip_file="$session_dir/clip_$clip_num.mp3"

    echo -e "${YELLOW}Generating audio for clip $clip_num...${NC}"

    # Call ElevenLabs
    local voice_id="${ELEVENLABS_VOICE_ID:-JBFqnCBsd6RMkjVDRZzb}"

    local response=$(curl -s -X POST "https://api.elevenlabs.io/v1/text-to-speech/$voice_id/with-timestamps?output_format=mp3_44100_128" \
        -H "xi-api-key: $ELEVENLABS_API_KEY" \
        -H "Content-Type: application/json" \
        -d "{\"text\": \"$narration\", \"model_id\": \"eleven_multilingual_v2\"}")

    # Check for error
    if echo "$response" | jq -e '.detail' > /dev/null 2>&1; then
        echo -e "${RED}Error from ElevenLabs:${NC}"
        echo "$response" | jq -r '.detail'
        exit 1
    fi

    # Save audio
    echo "$response" | jq -r '.audio_base64' | base64 -d > "$clip_file"

    # Get duration in seconds and milliseconds
    local duration_sec=$(echo "$response" | jq '[.alignment.character_end_times_seconds | last] | .[0]')
    local duration_ms=$(echo "$duration_sec" | awk '{printf "%.0f", $1 * 1000}')

    # Save duration for later use by mark command
    echo "$duration_ms" > "$session_dir/clip_${clip_num}_duration_ms.txt"

    # Update clip count if needed
    local current_count=$(cat "$session_dir/clip_count.txt")
    if [[ "$clip_num" -gt "$current_count" ]]; then
        echo "$clip_num" > "$session_dir/clip_count.txt"
    fi

    echo -e "${GREEN}Audio saved:${NC} $clip_file"
    echo -e "${GREEN}Duration:${NC} ${duration_sec}s"
    echo ""
    echo -e "${BLUE}Next steps:${NC}"
    echo "  1. narrator.sh mark $clip_num"
    echo "  2. browser_wait_for time=$duration_sec"
}

cmd_mark() {
    local clip_num="$1"

    if [[ -z "$clip_num" ]]; then
        echo -e "${RED}Error:${NC} Usage: narrator.sh mark <clip_num>"
        exit 1
    fi

    local session_dir=$(cat "$SESSION_FILE" 2>/dev/null)
    if [[ -z "$session_dir" || ! -d "$session_dir" ]]; then
        echo -e "${RED}Error:${NC} No active session."
        exit 1
    fi

    # Check that start was called
    if [[ ! -f "$session_dir/recording_start_ms.txt" ]]; then
        echo -e "${RED}Error:${NC} Recording start time not set. Run 'narrator.sh start' after browser_navigate."
        exit 1
    fi

    # Get current timestamp and calculate offset from recording start
    local now_ms=$(get_timestamp_ms)
    local start_ms=$(cat "$session_dir/recording_start_ms.txt")
    local offset_ms=$((now_ms - start_ms))

    # Get duration from audio command
    local duration_ms=$(cat "$session_dir/clip_${clip_num}_duration_ms.txt" 2>/dev/null)
    if [[ -z "$duration_ms" ]]; then
        echo -e "${RED}Error:${NC} No duration found for clip $clip_num. Run 'audio $clip_num' first."
        exit 1
    fi

    # Validate all values before saving
    if [[ -z "$clip_num" || -z "$offset_ms" || -z "$duration_ms" ]]; then
        echo -e "${RED}Error:${NC} Missing values - clip:$clip_num offset:$offset_ms duration:$duration_ms"
        exit 1
    fi

    # Save mark using printf for reliable formatting
    printf "%s %s %s\n" "$clip_num" "$offset_ms" "$duration_ms" >> "$session_dir/marks.txt"

    local offset_sec=$(echo "$offset_ms" | awk '{printf "%.2f", $1 / 1000}')
    local duration_sec=$(echo "$duration_ms" | awk '{printf "%.2f", $1 / 1000}')

    echo -e "${GREEN}Marked clip $clip_num:${NC} starts at ${offset_sec}s in video, duration ${duration_sec}s"
    echo ""
    echo -e "${BLUE}Next:${NC} browser_wait_for time=$duration_sec"
}

cmd_video() {
    local session_dir=$(cat "$SESSION_FILE" 2>/dev/null)
    if [[ -z "$session_dir" || ! -d "$session_dir" ]]; then
        echo -e "${RED}Error:${NC} No active session."
        exit 1
    fi

    # Find most recent webm file (Playwright saves to videos/ subdirectory)
    local video_file=$(ls -t "$SESSION_BASE/videos"/*.webm 2>/dev/null | head -1)

    if [[ -z "$video_file" || ! -f "$video_file" ]]; then
        echo -e "${RED}Error:${NC} No video file found in $SESSION_BASE/videos"
        exit 1
    fi

    # Move to session dir
    mv "$video_file" "$session_dir/recording.webm"

    echo -e "${GREEN}Video saved:${NC} $session_dir/recording.webm"
    echo ""
    echo -e "${BLUE}Next:${NC} narrator.sh finalize"
}

cmd_finalize() {
    local session_dir=$(cat "$SESSION_FILE" 2>/dev/null)
    if [[ -z "$session_dir" || ! -d "$session_dir" ]]; then
        echo -e "${RED}Error:${NC} No active session."
        exit 1
    fi

    if [[ ! -f "$session_dir/recording.webm" ]]; then
        echo -e "${RED}Error:${NC} No recording found. Run 'video' first."
        exit 1
    fi

    local clip_count=$(cat "$session_dir/clip_count.txt")

    if [[ "$clip_count" -eq 0 ]]; then
        echo -e "${RED}Error:${NC} No clips found."
        exit 1
    fi

    cd "$session_dir"

    echo -e "${YELLOW}Finalizing $clip_count clips...${NC}"

    # Check recording duration
    local recording_duration=$(ffprobe -v error -show_entries format=duration -of csv=p=0 recording.webm 2>/dev/null)
    echo -e "Recording duration: ${recording_duration}s"
    echo ""

    # Step 1: Extract video segments
    echo -e "${BLUE}Step 1:${NC} Extracting video segments..."

    > concat_list.txt

    while read -r line; do
        # Skip comments and empty lines
        [[ "$line" =~ ^#.*$ ]] && continue
        [[ -z "$line" ]] && continue

        # Parse fields using awk (more robust)
        local num=$(echo "$line" | awk '{print $1}')
        local start_ms=$(echo "$line" | awk '{print $2}')
        local duration_ms=$(echo "$line" | awk '{print $3}')

        # Validate we have all fields
        if [[ -z "$num" || -z "$start_ms" || -z "$duration_ms" ]]; then
            echo "  Skipping malformed line: $line"
            continue
        fi

        # Convert ms to seconds
        local start_sec=$(echo "$start_ms" | awk '{printf "%.3f", $1 / 1000}')
        local duration_sec=$(echo "$duration_ms" | awk '{printf "%.3f", $1 / 1000}')

        local end_sec=$(echo "$start_sec $duration_sec" | awk '{printf "%.3f", $1 + $2}')
        echo "  Extracting segment $num: ${start_sec}s to ${end_sec}s (${duration_sec}s)"

        # Check if segment is within recording bounds
        local is_valid=$(echo "$end_sec $recording_duration" | awk '{print ($1 <= $2) ? "yes" : "no"}')
        if [[ "$is_valid" == "no" ]]; then
            echo -e "    ${RED}✗${NC} Segment end (${end_sec}s) exceeds recording duration (${recording_duration}s)"
            continue
        fi

        # Extract segment (use output seeking for accuracy)
        ffmpeg -y -i recording.webm -ss "$start_sec" -t "$duration_sec" \
            -c:v libx264 -preset fast -crf 23 \
            "segment_$num.mp4" 2>/dev/null

        if [[ -f "segment_$num.mp4" ]]; then
            local seg_size=$(ls -la "segment_$num.mp4" | awk '{print $5}')
            local seg_duration=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "segment_$num.mp4" 2>/dev/null)
            echo -e "    ${GREEN}✓${NC} segment_$num.mp4 (${seg_size} bytes, ${seg_duration}s)"
            echo "file 'segment_$num.mp4'" >> concat_list.txt
        else
            echo -e "    ${RED}✗${NC} segment_$num.mp4 NOT created"
        fi
    done < marks.txt

    echo ""
    echo "  Segments to concatenate:"
    cat concat_list.txt

    # Step 2: Concatenate video segments
    echo -e "${BLUE}Step 2:${NC} Concatenating video segments..."
    local segment_count=$(wc -l < concat_list.txt | tr -d ' ')
    echo "  Concatenating $segment_count segments..."

    ffmpeg -y -f concat -safe 0 -i concat_list.txt -c copy concat.mp4 2>/dev/null

    if [[ -f "concat.mp4" ]]; then
        local concat_duration=$(ffprobe -v error -show_entries format=duration -of csv=p=0 concat.mp4 2>/dev/null)
        echo -e "    ${GREEN}✓${NC} concat.mp4 created (${concat_duration}s)"
    else
        echo -e "    ${RED}✗${NC} concat.mp4 NOT created"
        exit 1
    fi

    # Step 3: Calculate audio offsets and build filter
    echo -e "${BLUE}Step 3:${NC} Building audio filter..."

    local audio_inputs=""
    local audio_filter=""
    local audio_labels=""
    local input_num=1
    local cumulative_offset_ms=0

    for i in $(seq 1 $clip_count); do
        if [[ -f "clip_$i.mp3" && -f "segment_$i.mp4" ]]; then
            audio_inputs="$audio_inputs -i clip_$i.mp3"

            audio_filter="${audio_filter}[$input_num]adelay=$cumulative_offset_ms|$cumulative_offset_ms[a$input_num];"
            audio_labels="${audio_labels}[a$input_num]"

            # Get segment duration for next offset
            local segment_duration_ms=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "segment_$i.mp4" 2>/dev/null | awk '{printf "%.0f", $1 * 1000}')
            cumulative_offset_ms=$((cumulative_offset_ms + segment_duration_ms))

            input_num=$((input_num + 1))
        fi
    done

    local num_audio=$((input_num - 1))

    # Step 4: Merge audio onto video
    echo -e "${BLUE}Step 4:${NC} Merging audio onto video..."

    if [[ $num_audio -gt 0 ]]; then
        audio_filter="${audio_filter}${audio_labels}amix=inputs=$num_audio:duration=longest[aout]"

        ffmpeg -y -i concat.mp4 $audio_inputs \
            -filter_complex "$audio_filter" \
            -map 0:v -map "[aout]" \
            -c:v copy -c:a aac \
            output.mp4 2>/dev/null

        echo -e "${GREEN}Created:${NC} $session_dir/output.mp4"
    else
        echo -e "${YELLOW}No audio clips found, copying video as-is${NC}"
        cp concat.mp4 output.mp4
        echo -e "${GREEN}Created:${NC} $session_dir/output.mp4"
    fi

    # Cleanup intermediate files
    rm -f concat.mp4 concat_list.txt segment_*.mp4

    echo ""
    echo -e "${GREEN}Finalization complete!${NC}"
    echo "Next: narrator.sh upload"
}

cmd_upload() {
    local video_file="$1"
    local session_dir=$(cat "$SESSION_FILE" 2>/dev/null)

    if [[ -z "$video_file" ]]; then
        video_file="$session_dir/output.mp4"
    fi

    if [[ ! -f "$video_file" ]]; then
        echo -e "${RED}Error:${NC} Video file not found: $video_file"
        exit 1
    fi

    echo -e "${YELLOW}Uploading to Mux...${NC}"

    local upload_response=$(curl -s -X POST https://api.mux.com/video/v1/uploads \
        -u "${MUX_TOKEN_ID}:${MUX_TOKEN_SECRET}" \
        -H "Content-Type: application/json" \
        -d '{"new_asset_settings": {"playback_policy": ["public"], "video_quality": "basic"}, "cors_origin": "*"}')

    local upload_url=$(echo "$upload_response" | jq -r '.data.url')
    local upload_id=$(echo "$upload_response" | jq -r '.data.id')

    if [[ "$upload_url" == "null" ]]; then
        echo -e "${RED}Error creating upload:${NC}"
        echo "$upload_response"
        exit 1
    fi

    echo -e "${YELLOW}Uploading file...${NC}"
    curl -s -X PUT "$upload_url" \
        -H "Content-Type: video/mp4" \
        --data-binary "@$video_file"

    echo -e "${YELLOW}Waiting for processing...${NC}"
    sleep 5

    local asset_id=$(curl -s "https://api.mux.com/video/v1/uploads/$upload_id" \
        -u "${MUX_TOKEN_ID}:${MUX_TOKEN_SECRET}" | jq -r '.data.asset_id')

    local playback_id=$(curl -s "https://api.mux.com/video/v1/assets/$asset_id" \
        -u "${MUX_TOKEN_ID}:${MUX_TOKEN_SECRET}" | jq -r '.data.playback_ids[0].id')

    echo ""
    echo -e "${GREEN}Upload complete!${NC}"
    echo -e "Asset ID: $asset_id"
    echo -e "Playback ID: $playback_id"
    echo ""
    echo -e "${GREEN}Watch URL:${NC} https://stream.mux.com/$playback_id"
}

cmd_status() {
    local session_dir=$(cat "$SESSION_FILE" 2>/dev/null)
    if [[ -z "$session_dir" || ! -d "$session_dir" ]]; then
        echo -e "${RED}No active session.${NC}"
        exit 1
    fi

    local persona=$(cat "$session_dir/persona.txt")
    local clip_count=$(cat "$session_dir/clip_count.txt")

    echo -e "${GREEN}Session:${NC} $session_dir"
    echo -e "${GREEN}Persona:${NC} $persona"
    echo -e "${GREEN}Clips:${NC} $clip_count"
    echo ""

    if [[ -f "$session_dir/marks.txt" ]]; then
        echo "Marks:"
        while read -r line; do
            [[ "$line" =~ ^#.*$ ]] && continue
            [[ -z "$line" ]] && continue
            local num=$(echo "$line" | awk '{print $1}')
            local start_ms=$(echo "$line" | awk '{print $2}')
            local dur_ms=$(echo "$line" | awk '{print $3}')
            local start_sec=$(echo "$start_ms" | awk '{printf "%.2f", $1 / 1000}')
            local dur_sec=$(echo "$dur_ms" | awk '{printf "%.2f", $1 / 1000}')
            echo "  Clip $num: ${start_sec}s for ${dur_sec}s"
        done < "$session_dir/marks.txt"
    fi

    echo ""
    for i in $(seq 1 $clip_count); do
        local has_audio="[ ]"
        local has_mark="[ ]"
        [[ -f "$session_dir/clip_$i.mp3" ]] && has_audio="[x]"
        grep -q "^$i " "$session_dir/marks.txt" 2>/dev/null && has_mark="[x]"
        echo "  Clip $i: Audio $has_audio  Marked $has_mark"
    done

    echo ""
    [[ -f "$session_dir/recording.webm" ]] && echo -e "Recording: ${GREEN}saved${NC}" || echo -e "Recording: ${RED}not saved${NC}"
    [[ -f "$session_dir/output.mp4" ]] && echo -e "Output: ${GREEN}ready${NC}" || echo -e "Output: ${RED}not ready${NC}"
}

cmd_animate() {
    local clip_num="$1"

    if [[ -z "$clip_num" ]]; then
        echo -e "${RED}Error:${NC} Usage: narrator.sh animate <clip_num>"
        exit 1
    fi

    local session_dir=$(cat "$SESSION_FILE" 2>/dev/null)
    if [[ -z "$session_dir" || ! -d "$session_dir" ]]; then
        echo -e "${RED}Error:${NC} No active session."
        exit 1
    fi

    local duration_ms=$(cat "$session_dir/clip_${clip_num}_duration_ms.txt" 2>/dev/null)
    if [[ -z "$duration_ms" ]]; then
        echo -e "${RED}Error:${NC} No duration found for clip $clip_num. Run 'audio $clip_num' first."
        exit 1
    fi

    # Output the JavaScript for browser_run_code
    cat << EOF
async (page) => {
  const duration = ${duration_ms};
  const scrollDistance = 150;
  const scrollTime = duration * 0.25;
  const pauseTime = duration * 0.50;
  const steps = 20;
  const stepDelay = scrollTime / steps;
  const stepDistance = scrollDistance / steps;

  // Smooth scroll down (25% of duration)
  for (let i = 0; i < steps; i++) {
    await page.evaluate((y) => window.scrollBy(0, y), stepDistance);
    await page.waitForTimeout(stepDelay);
  }

  // Pause in middle (50% of duration)
  await page.waitForTimeout(pauseTime);

  // Smooth scroll back up (25% of duration)
  for (let i = 0; i < steps; i++) {
    await page.evaluate((y) => window.scrollBy(0, y), -stepDistance);
    await page.waitForTimeout(stepDelay);
  }
}
EOF

    echo ""
    echo -e "${BLUE}Use with:${NC} browser_run_code with the above code"
}

cmd_help() {
    echo "Narrator - Helper script for narrated screen recordings"
    echo ""
    echo "Usage: narrator.sh <command> [args]"
    echo ""
    echo "Commands:"
    echo "  init [persona]         Initialize new session"
    echo "  start                  Log video start time (call RIGHT AFTER browser opens)"
    echo "  audio <num> \"text\"     Generate audio clip (calls ElevenLabs)"
    echo "  mark <num>             Mark timestamp for segment extraction"
    echo "  animate <num>          Output scroll animation JS (use instead of wait)"
    echo "  video                  Save the recording"
    echo "  status                 Show session status"
    echo "  finalize               Extract segments, merge audio"
    echo "  upload [video.mp4]     Upload to Mux"
    echo ""
    echo "Workflow:"
    echo "  1. narrator.sh init \"persona\""
    echo "  2. browser_navigate to first URL"
    echo "  3. narrator.sh start  ← IMMEDIATELY after browser opens"
    echo "  4. For each page:"
    echo "     - browser_snapshot"
    echo "     - narrator.sh audio <num> \"commentary\""
    echo "     - narrator.sh mark <num>"
    echo "     - browser_wait_for time=<duration>"
    echo "     - browser_navigate to next (or close if done)"
    echo "  5. browser_close"
    echo "  6. narrator.sh video"
    echo "  7. narrator.sh finalize"
    echo "  8. narrator.sh upload"
    echo ""
    echo "Environment variables:"
    echo "  ELEVENLABS_API_KEY     Required for TTS"
    echo "  ELEVENLABS_VOICE_ID    Optional (has default)"
    echo "  MUX_TOKEN_ID           Required for upload"
    echo "  MUX_TOKEN_SECRET       Required for upload"
}

# Main
case "${1:-help}" in
    init)     cmd_init "$2" ;;
    start)    cmd_start ;;
    audio)    cmd_audio "$2" "$3" ;;
    mark)     cmd_mark "$2" ;;
    animate)  cmd_animate "$2" ;;
    video)    cmd_video ;;
    status)   cmd_status ;;
    finalize) cmd_finalize ;;
    upload)   cmd_upload "$2" ;;
    help|*)   cmd_help ;;
esac
