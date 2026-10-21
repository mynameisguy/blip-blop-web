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
  -sFORCE_FILESYSTEM -sEXPORTED_RUNTIME_METHODS=FS,ENV,addRunDependency,removeRunDependency,UTF8ToString \
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
# The manifest lists each file with its size (for the progress bar) and a
# content hash (the page caches files by hash, so a changed file is refetched).
python3 - "$OUT/data" <<'PY'
import hashlib, json, os, sys
d = sys.argv[1]
names = [l.strip() for l in open(os.path.join(d, 'files.txt')) if l.strip()]
out = []
for n in names:
    b = open(os.path.join(d, n), 'rb').read()
    out.append({'name': n, 'size': len(b), 'hash': hashlib.sha256(b).hexdigest()[:16]})
json.dump(out, open(os.path.join(d, 'manifest.json'), 'w'), separators=(',', ':'))
PY
rm "$OUT/data/files.txt"

# Versioned names, so a browser never pairs a cached older blipblop.js or
# .wasm (or manifest) with newer files after a deploy: the .wasm and the
# manifest are named by content hash inside blipblop.js, and blipblop.js by
# its own hash inside index.html.
cd "$OUT"
rm -f blipblop.*.js blipblop.*.wasm data/manifest.*.json
hash() { sha256sum "$1" | cut -c1-12; }
WASM="blipblop.$(hash blipblop.wasm).wasm"
MANIFEST="manifest.$(hash data/manifest.json).json"
mv blipblop.wasm "$WASM"
cp data/manifest.json "data/$MANIFEST"
sed -i -e "s|\"blipblop\.wasm\"|\"$WASM\"|g" -e "s|data/manifest\.json|data/$MANIFEST|g" blipblop.js
grep -q "\"$WASM\"" blipblop.js && grep -q "data/$MANIFEST" blipblop.js
JS="blipblop.$(hash blipblop.js).js"
mv blipblop.js "$JS"
sed "s|'blipblop\.js'|'$JS'|" "$ROOT/web/index.html" > index.html
grep -q "'$JS'" index.html
