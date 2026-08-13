#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
ASSET_DIR="$ROOT_DIR/docs/assets"
BUILD_DIR="$SCRIPT_DIR/build"
FONT="/System/Library/Fonts/Hiragino Sans GB.ttc"
MONO_FONT="/System/Library/Fonts/SFNSMono.ttf"

for command_name in magick ffmpeg; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name" >&2
    exit 1
  fi
done

if [[ ! -f "$FONT" || ! -f "$MONO_FONT" ]]; then
  echo "This renderer currently expects the bundled macOS system fonts." >&2
  exit 1
fi

mkdir -p "$BUILD_DIR"

make_ui_scene() {
  local source_image="$1"
  local output_image="$2"
  local kicker="$3"
  local title="$4"
  local subtitle="$5"

  magick \
    -size 1920x1080 xc:'#07080B' \
    -fill '#0D1017' -draw 'rectangle 0,198 1920,1080' \
    \( "$source_image" -resize '1408x880!' -bordercolor '#303440' -border 1 \) \
    -gravity south -geometry +0+0 -compose over -composite \
    -font "$MONO_FONT" -fill '#B9A2FF' -pointsize 22 -kerning 2 \
    -gravity northwest -annotate +256+35 "$kicker" \
    -font "$FONT" -fill '#F7F8FB' -pointsize 58 -kerning 0 \
    -annotate +256+72 "$title" \
    -fill '#9A9EAA' -pointsize 24 \
    -annotate +256+151 "$subtitle" \
    "$output_image"
}

make_ui_scene \
  "$ASSET_DIR/tw-dashboard-overview.jpg" \
  "$BUILD_DIR/scene-02.png" \
  'MISSION CONTROL' \
  '一个人。一整队 Agent。' \
  '所有进展，所有等待，所有需要你的事，都在这里。'

make_ui_scene \
  "$ASSET_DIR/tw-dashboard-agent-workspace.jpg" \
  "$BUILD_DIR/scene-03.png" \
  'ISOLATED BY DEFAULT' \
  '每个任务，都有自己的工作区。' \
  '独立 branch、Git worktree 与 tmux session。一起开工，互不打架。'

make_ui_scene \
  "$ASSET_DIR/tw-dashboard-code-editor.jpg" \
  "$BUILD_DIR/scene-04.png" \
  'ONE TASK CONTEXT' \
  '终端、代码、上下文，始终在一起。' \
  '从 Agent 的回答，到真正发生改变的那一行代码。'

make_ui_scene \
  "$ASSET_DIR/tw-dashboard-git-log.jpg" \
  "$BUILD_DIR/scene-05.png" \
  'REVIEW IN CONTEXT' \
  '不只看答案。看懂每一次改变。' \
  '状态、diff 与 commit graph，都属于同一个任务。'

magick \
  -size 1920x1080 xc:'#07080B' \
  \( "$ASSET_DIR/tw-dashboard-mobile-relay.jpg" \
     -resize '1920x1200^' -gravity center -extent 1920x1080 \
     -blur 0x34 -modulate 35,55,100 \) \
  -gravity center -compose over -composite \
  -fill 'rgba(5,6,9,0.64)' -draw 'rectangle 0,0 1920,1080' \
  \( "$ASSET_DIR/tw-dashboard-mobile-relay.jpg" \
     -crop '820x185+410+520' +repage -resize '1640x370!' \
     -bordercolor '#343844' -border 1 \) \
  -gravity center -geometry +0+55 -compose over -composite \
  -font "$MONO_FONT" -fill '#74E0B3' -pointsize 22 -kerning 2 \
  -gravity northwest -annotate +140+65 'RELAY V2 · CONNECTED' \
  -font "$FONT" -fill '#F7F8FB' -pointsize 68 \
  -annotate +140+105 '离开电脑。不离开任务。' \
  -fill '#A4A8B3' -pointsize 26 \
  -annotate +140+205 '同一个任务，从 Mac 接力到 Android。' \
  -font "$MONO_FONT" -fill '#777D8B' -pointsize 22 -kerning 2 \
  -gravity south -annotate +0+92 'MAC  →  RELAY V2  →  ANDROID' \
  "$BUILD_DIR/scene-06.png"

magick \
  -size 1920x1080 xc:'#050609' \
  \( "$ROOT_DIR/app/src-tauri/icons/icon.png" -resize '150x150' \) \
  -gravity north -geometry +0+155 -compose over -composite \
  -font "$FONT" -fill '#FAFAFC' -pointsize 98 \
  -gravity center -annotate +0-5 'AI 在跑。' \
  -annotate +0+105 '你不必守着。' \
  -font "$MONO_FONT" -fill '#999EAA' -pointsize 25 -kerning 3 \
  -gravity south -annotate +0+108 'TW · AGENT MISSION CONTROL' \
  "$BUILD_DIR/scene-01.png"

magick \
  "$ASSET_DIR/tw-dashboard-hero.png" \
  -resize '1920x1080^' -gravity center -extent 1920x1080 \
  -fill 'rgba(3,4,7,0.63)' -draw 'rectangle 0,0 1920,260' \
  -font "$MONO_FONT" -fill '#FFBE40' -pointsize 22 -kerning 2 \
  -gravity northwest -annotate +140+58 'LOCAL-FIRST · SELF-HOSTED' \
  -font "$FONT" -fill '#FFFFFF' -pointsize 72 \
  -annotate +140+95 '你的 Agent。你的机器。' \
  -fill '#C0C3CA' -pointsize 26 \
  -annotate +140+194 '不是另一个模型。是你已经在用的一切，终于有了同一张控制台。' \
  "$BUILD_DIR/scene-07.png"

magick \
  -size 1920x1080 xc:'#050609' \
  \( "$ROOT_DIR/app/src-tauri/icons/icon.png" -resize '118x118' \) \
  -gravity north -geometry +0+148 -compose over -composite \
  -font "$MONO_FONT" -fill '#B8A0FF' -pointsize 27 -kerning 4 \
  -gravity north -annotate +0+302 'TW · AGENT MISSION CONTROL' \
  -font "$FONT" -fill '#FFFFFF' -pointsize 76 \
  -gravity center -annotate +0-42 '你的 Agent。你的机器。' \
  -annotate +0+64 '一张控制台。' \
  -font "$MONO_FONT" -fill '#A2A6B0' -pointsize 24 -kerning 1 \
  -gravity south -annotate +0+154 'github.com/Sskift/tmux-worktree' \
  -fill '#F3F4F7' -pointsize 28 -kerning 2 \
  -annotate +0+93 'npm run demo' \
  "$BUILD_DIR/scene-08.png"

cp "$BUILD_DIR/scene-07.png" "$ASSET_DIR/tw-dashboard-film-poster.png"

ffmpeg -y -hide_banner -loglevel warning \
  -loop 1 -framerate 30 -t 6.0 -i "$BUILD_DIR/scene-01.png" \
  -loop 1 -framerate 30 -t 7.0 -i "$BUILD_DIR/scene-02.png" \
  -loop 1 -framerate 30 -t 7.0 -i "$BUILD_DIR/scene-03.png" \
  -loop 1 -framerate 30 -t 7.0 -i "$BUILD_DIR/scene-04.png" \
  -loop 1 -framerate 30 -t 7.0 -i "$BUILD_DIR/scene-05.png" \
  -loop 1 -framerate 30 -t 7.0 -i "$BUILD_DIR/scene-06.png" \
  -loop 1 -framerate 30 -t 7.0 -i "$BUILD_DIR/scene-07.png" \
  -loop 1 -framerate 30 -t 7.5 -i "$BUILD_DIR/scene-08.png" \
  -filter_complex "
    [0:v]zoompan=z='min(zoom+0.00010,1.018)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=30,trim=duration=6,setpts=PTS-STARTPTS[v0];
    [1:v]zoompan=z='min(zoom+0.00010,1.020)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=30,trim=duration=7,setpts=PTS-STARTPTS[v1];
    [2:v]zoompan=z='if(eq(on,0),1.020,max(zoom-0.00010,1.0))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=30,trim=duration=7,setpts=PTS-STARTPTS[v2];
    [3:v]zoompan=z='min(zoom+0.00012,1.022)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=30,trim=duration=7,setpts=PTS-STARTPTS[v3];
    [4:v]zoompan=z='min(zoom+0.00011,1.021)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=30,trim=duration=7,setpts=PTS-STARTPTS[v4];
    [5:v]zoompan=z='min(zoom+0.00014,1.024)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=30,trim=duration=7,setpts=PTS-STARTPTS[v5];
    [6:v]zoompan=z='min(zoom+0.00009,1.017)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=30,trim=duration=7,setpts=PTS-STARTPTS[v6];
    [7:v]zoompan=z='if(eq(on,0),1.016,max(zoom-0.00008,1.0))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=30,trim=duration=7.5,setpts=PTS-STARTPTS[v7];
    [v0][v1]xfade=transition=fade:duration=0.5:offset=5.5[x1];
    [x1][v2]xfade=transition=fade:duration=0.5:offset=12.0[x2];
    [x2][v3]xfade=transition=fade:duration=0.5:offset=18.5[x3];
    [x3][v4]xfade=transition=fade:duration=0.5:offset=25.0[x4];
    [x4][v5]xfade=transition=fade:duration=0.5:offset=31.5[x5];
    [x5][v6]xfade=transition=fade:duration=0.5:offset=38.0[x6];
    [x6][v7]xfade=transition=fade:duration=0.5:offset=44.5,format=yuv420p[vout]
  " \
  -map '[vout]' \
  -an -c:v libx264 -preset slow -crf 17 -pix_fmt yuv420p \
  "$BUILD_DIR/tw-dashboard-film-silent.mp4"

ffmpeg -y -hide_banner -loglevel warning \
  -f lavfi -i 'anullsrc=r=48000:cl=mono:d=52' \
  -f lavfi -i 'sine=frequency=523.25:sample_rate=48000:duration=1.2' \
  -f lavfi -i 'sine=frequency=659.25:sample_rate=48000:duration=1.2' \
  -f lavfi -i 'sine=frequency=783.99:sample_rate=48000:duration=1.2' \
  -filter_complex "
    [0:a]atrim=duration=52[silence];
    [1:a]volume=0.190,afade=t=in:st=0:d=0.06,afade=t=out:st=0.18:d=1.02,adelay=5500[c0];
    [2:a]volume=0.165,afade=t=in:st=0:d=0.06,afade=t=out:st=0.18:d=1.02,adelay=25000[c1];
    [3:a]volume=0.165,afade=t=in:st=0:d=0.06,afade=t=out:st=0.18:d=1.02,adelay=44500[c2];
    [silence][c0][c1][c2]amix=inputs=4:duration=first:normalize=0,
      pan=stereo|c0=c0|c1=c0[aout]
  " \
  -map '[aout]' -t 52 -c:a pcm_s16le "$BUILD_DIR/tw-dashboard-film-audio.wav"

ffmpeg -y -hide_banner -loglevel warning \
  -i "$BUILD_DIR/tw-dashboard-film-silent.mp4" \
  -i "$BUILD_DIR/tw-dashboard-film-audio.wav" \
  -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 192k \
  -t 52 -movflags +faststart \
  "$ASSET_DIR/tw-dashboard-film.mp4"

echo "Rendered: $ASSET_DIR/tw-dashboard-film.mp4"
echo "Poster:   $ASSET_DIR/tw-dashboard-film-poster.png"
