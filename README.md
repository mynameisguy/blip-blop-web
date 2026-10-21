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

## Saves and input

The settings (`data/bb.cfg`: keys, options) and hi-scores (`data/bb.scr`)
persist in the browser's IndexedDB. A browser tab closes without reaching
the save code at the end of `main()`, so the browser build saves each file as
soon as it changes (options menu, keys menu, hi-score entry) and again when
the page is hidden. Add `BB_NO_PERSIST=1` to run with the shipped files only.

Both tests drive the game with real browser key events:

```sh
node tools/input_test.mjs http://localhost:8000/   # menus, both players, keys the page must not act on, gamepad, AZERTY
node tools/saves_test.mjs http://localhost:8000/   # settings and hi-scores survive a reload
```
