# Blip & Blop for the browser

The original Blip'n Blop PC game (Loaded Studio), compiled to WebAssembly with
Emscripten so it runs in a browser and looks the same as the original, pixel
for pixel.

- `game/` holds the original C++ source and data, imported from
  [benkaraban/blip-blop](https://github.com/benkaraban/blip-blop)
  (`vc-projects/Blip_n_Blop_3`). Browser-only changes sit behind
  `#ifdef __EMSCRIPTEN__`.
- `web/` holds the browser shell, the data loader and the build script.
- `tools/` holds the pixel comparison tools.

Both builds use the MSVC `rand()` sequence (`game/rand_compat.h`), so random
behaviour matches the original Windows release on every platform.

## Build

```sh
source /path/to/emsdk/emsdk_env.sh
web/build.sh            # output in web/dist/
python3 -m http.server -d web/dist 8000
```

`ffmpeg` is needed at build time: two music tracks (`gameover.zik`, `tambour.zik`)
are MP3 files, and the browser mixer only decodes OGG, so the build re-encodes them.

Every push to `main` builds the game and deploys it to GitHub Pages
(`.github/workflows/pages.yml`).

## Pixel comparison

`game/harness.cpp` adds an opt-in test mode, driven by environment variables
(native) or `BB_*` URL parameters (browser): a fixed-step virtual clock,
scripted key presses and frame dumps. With it, the native and browser builds
produce frame-for-frame comparable output.

```sh
# native reference (built with CMake from game/)
SDL_VIDEODRIVER=offscreen SDL_AUDIODRIVER=dummy BB_FIXED_STEP_MS=11 \
  BB_DUMP_DIR=/tmp/native BB_DUMP_EVERY=50 BB_MAX_FRAMES=1500 ./blipblop
# browser build, served on localhost:8000
npm i playwright
node tools/web_dump.mjs http://localhost:8000/ /tmp/web 50 1500
python3 tools/compare_frames.py /tmp/native /tmp/web /tmp/diff
```

More harness options (all off by default): `BB_START_LEVEL=n` starts a new
game at level n of `data/bb.lst` with its briefing (13 goes straight to the
end sequence), `BB_LIVES=n` sets the starting lives, `BB_DEFAULT_CONFIG=1`
ignores `data/bb.cfg` and uses the default keys (arrows, Left Ctrl fire, Menu
jump, Space cow bomb). Input script step numbers count frames plus one step
per turn of a blocking "press a key" wait, so scripts can get past those.

### Full-game coverage

`tools/coverage.py` plays every part of the game in both builds with the same
input script (menus and options, character selection, each level with its
briefing while running, jumping and shooting, the pause menu, RPG dialogue
scenes, game over, the end cinematic and credits, hi-score name entry and
table, attract mode), dumps sampled frames and compares them.

```sh
cmake game -B build && make -C build -j8
web/build.sh
CHROMIUM_PATH=/path/to/chromium python3 tools/coverage.py --jobs 3
python3 tools/coverage.py --list          # segments
python3 tools/coverage.py level05-bisous2 # one segment
```

It serves `web/dist` itself and writes frames, diffs and a `summary.json`
under `--out` (default `/tmp/bb-coverage`).
