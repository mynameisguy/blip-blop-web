#!/usr/bin/env bash
# Builds the original game to WebAssembly with Emscripten.
# Requires emsdk activated (source emsdk_env.sh). Output goes to web/dist/.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/web/dist"
mkdir -p "$OUT/data"
cd "$ROOT/game"
em++ -O2 -std=c++14 -w -DPLATFORM_LINUX -fexceptions -include rand_compat.h \
  -sUSE_SDL=2 -sUSE_SDL_MIXER=2 -sSDL2_MIXER_FORMATS='["ogg"]' \
  -sASYNCIFY -sASYNCIFY_STACK_SIZE=65536 \
  -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=256MB \
  -sFORCE_FILESYSTEM -lidbfs.js -sEXPORTED_RUNTIME_METHODS=FS,ENV,addRunDependency,removeRunDependency \
  --pre-js "$ROOT/web/pre.js" \
  ${EXTRA_FLAGS:-} \
  -o "$OUT/blipblop.js" \
  *.cpp menus/*.cpp

# Game data is copied as individual files (the .mp3 files are unused by the game).
cd data
find . -maxdepth 1 -type f ! -name '*.mp3' -printf '%f\n' | sort > "$OUT/data/files.txt"
xargs -a "$OUT/data/files.txt" -d '\n' cp -t "$OUT/data"
# A few .zik music files are MP3 (behind a zero-padded header) and the browser
# mixer only decodes OGG, so re-encode just those at top Vorbis quality.
for f in *.zik; do
  if ! head -c 4 "$f" | grep -q OggS; then
    ffmpeg -loglevel error -y -f mp3 -i "$f" -c:a libvorbis -q:a 10 -f ogg "$OUT/data/$f"
  fi
done
python3 -c 'import json,sys; print(json.dumps([l.strip() for l in open(sys.argv[1]) if l.strip()]))' \
  "$OUT/data/files.txt" > "$OUT/data/manifest.json"
rm "$OUT/data/files.txt"
cp "$ROOT/web/index.html" "$OUT/index.html"
