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

## The page

`web/index.html` scales the 640x480 canvas by the largest whole factor that
fits the window, in device pixels, with nearest-neighbour filtering, so each
game pixel is an exact NxN block (also in fullscreen: the Fullscreen button
or Alt+Return). Only when even 1x does not fit (a small window or phone) is
the picture scaled down to fit, smoothly, instead of being cropped.
On a touch device held upright the picture instead fills the screen width
(4:3), usually at a non-integer scale. It is drawn "sharp-bilinear": each
frame is copied with nearest-neighbour onto a canvas k times the game size
(k = the smallest whole factor at or above the target), which the browser
then scales down smoothly, so every game pixel row and column gets the same
width and only edges blend. Held sideways, and on desktops, the exact whole
factor applies.
The game data (about 115 MB) downloads with a progress bar and is kept in
the browser's Cache API, so later visits load it from disk. Because browsers
mute audio until the first click, tap or key press, the game starts on that
gesture, so the music plays from the first frame.

On touch devices the page shows on-screen controls (pad, Fire, Jump,
Special, Menu, Start), sized to fit the margins beside the picture (held
sideways) or the space below it (held upright, with the picture at the top).
They send the player 1 keys the game is set to (read from the game; the menus
read those too), with the arrows as a fallback, and Return/Escape.

`web/build.sh` names `blipblop.js`, the `.wasm` and the data manifest by
content hash, so after a deploy a browser never mixes cached old and new files.

- `tools/check_scaling.mjs <url> --fullscreen` compares whole screenshots at
  800x600, 1366x768 and 1920x1080 with the harness framebuffer (frame 400,
  whose picture reaches all four edges): the frame scaled NxN, centred,
  uncropped, every other pixel black (`--dpr 1,2,3`
  adds device pixel ratios, `--css` injects CSS to see it fail). `--touch`
  runs as a phone: upright, the picture must fill the width at the top.
- `tools/check_shell.mjs <url>` checks loading, the start gesture, audio,
  keyboard and focus handling, error messages (including a crash during
  play) and the cache.
- `tools/check_touch_layout.mjs <url>` checks the touch controls stay off the
  picture on common phones (and only overlap it, faintly, on a tablet), and
  that upright the picture fills the width, drawn sharp-bilinear.
- `tools/check_touch.mjs <url> [outdir] --cfg` plays to the first level on an
  emulated phone with the touch controls (`--cfg` serves a bb.cfg with valid
  default keys).

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
