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
width and only edges blend. Held sideways, the picture fills the screen
height (4:3, centred), drawn the same way. On desktops and other devices
without touch, the exact whole factor applies.
The game data (about 115 MB) downloads with a progress bar and is kept in
the browser's Cache API, so later visits load it from disk. Because browsers
mute audio until the first click, tap or key press, the game starts on that
gesture, so the music plays from the first frame.

On touch devices the first tap also enters fullscreen and, where the browser
allows it (Android), locks the screen sideways. An iPhone has no fullscreen
for pages: there the start screen suggests Add to Home Screen, and the web
app manifest (`web/manifest.webmanifest`) opens the game from the home screen
fullscreen and sideways.

On touch devices the page also shows on-screen controls that change with
what the game shows (the game reports it through `bb_ui_mode()`,
`game/web_ui.h`; browser build only, nothing drawn changes):

- in menus: big up/down/left/right arrows and OK; a swipe on the picture is
  an arrow key and a tap is Return;
- in the intro, cutscenes, dialogue and the mission briefing: Skip (Escape,
  or Return for the briefing's "press a key"); a tap is Return;
- in a level: a floating stick (it appears where the left thumb lands, has a
  dead zone, gives 8 directions with hysteresis and follows the thumb), Fire,
  Jump and Special (64 px or more), a pause button and an auto-fire toggle.
  Auto-fire holds Fire down, which the game turns into continuous shooting;
  it is let go outside levels, and remembered in `localStorage`;
- typing a name for the hi-score table: a Keyboard button (or a tap on the
  picture) focuses a hidden text field, which brings up the soft keyboard;
  letters, digits, spaces and deletions typed there go to the game as key
  presses, and OK (Return) ends the name, dropping letters typed ahead
  that have not reached the game yet. While the soft keyboard is up, the
  picture moves up so the name and OK stay in view (`visualViewport`).

Held sideways the controls sit over the picture's lower corners and in the
margins beside it; held upright, below the picture. They never cover the HUD
along the top of the picture. They send the player 1 keys the game is set to
(read from the game; the menus read those too), with the arrows (directions)
or the default keys (buttons) as a fallback; the menu arrows send the arrow
keys. A bound key no browser key event can produce (such as the default
Jump key, SDLK_MENU) is handed to the game as an SDL key event
(`bb_web_key()` in `game/web_api.cpp`). On touch devices the page never
scrolls, zooms or bounces (`touch-action: none`, `overscroll-behavior: none`),
and a touch on the controls is cancelled in its `touchstart` (otherwise
the browser holds back timers after a touch, and the game, whose main loop
runs on them, would freeze for about 120 ms). Every press is held for at
least 50 ms, so a quick tap is never missed. The controls have a dark fill
and outline, to stay visible over bright scenery. A touch on the spot
between Fire and Jump presses both. Every key they
hold is let go when a finger lifts or slides off, a touch is cancelled, the
window loses focus, the page is hidden or the set of controls changes.
Presses vibrate briefly where the browser supports it.

`web/build.sh` names `blipblop.js`, the `.wasm` and the data manifest by
content hash, so after a deploy a browser never mixes cached old and new files.
A copy of the page itself still in the browser's cache names files the
deploy removed; when loading then fails, the page fetches itself fresh and,
if that names a different program, reloads once into the new version
(only an error that remains after that is shown).

- `tools/check_scaling.mjs <url> --fullscreen` compares whole screenshots at
  800x600, 1366x768 and 1920x1080 with the harness framebuffer (frame 400,
  whose picture reaches all four edges): the frame scaled NxN, centred,
  uncropped, every other pixel black (`--dpr 1,2,3`
  adds device pixel ratios, `--css` injects CSS to see it fail). `--touch`
  runs as phones and a tablet: upright, the picture must fill the width at
  the top; sideways, the height, centred.
- `tools/check_shell.mjs <url>` checks loading, the start gesture, audio,
  keyboard and focus handling, error messages (including a crash during
  play) and the cache.
- `tools/check_touch_layout.mjs <url> [outdir]` checks, on common phones and
  tablets and for each set of controls, that no control covers the HUD,
  overlaps another or leaves the screen, the button sizes, the picture's
  size and sharp-bilinear drawing, and the stick's keys.
- `tools/check_touch.mjs <url> [outdir] [--device WxH@R]` plays on an
  emulated phone with the touch controls alone, tracking Blip in the
  harness frames: fullscreen on the first tap, Skip, menus by taps and
  swipes from the title to level 1, the stick in all 8 directions (dead
  zone, hysteresis, following the thumb, stopping on release), Jump,
  auto-fire (continuous bullets, let go in the pause menu, remembered),
  pause, and that nothing stays held after multi-touch chaos, cancelled
  touches, blur and a hidden page. It saves screenshots of a menu and a
  level, lying down and upright.

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
table, attract mode) and compares every frame. The harness hashes each
frame's pixels (`BB_HASH_EVERY`, same code in both builds), so nothing big is
written; pictures and diff images are saved only for frames that differ.

```sh
cmake game -B build && make -C build -j8
web/build.sh
CHROMIUM_PATH=/path/to/chromium python3 tools/coverage.py --jobs 3 --repeat 2
python3 tools/coverage.py --list          # segments
python3 tools/coverage.py level05-bisous2 # one segment
```

`--repeat N` runs the native build N times per segment and fails if the runs
disagree (uninitialised memory and the like). A run that crashes, exits
non-zero or misses frames also fails. It serves `web/dist` itself and writes
hashes, logs, diffs and a `summary.json` under `--out` (default
`/tmp/bb-coverage`).

## Saves and input

The settings (`data/bb.cfg`: keys, options) and hi-scores (`data/bb.scr`)
persist in the browser's IndexedDB (database `/blip-n-blop-saves`). A
browser tab closes without reaching the save code at the end of `main()`, so
the browser build saves each file as soon as it changes (options menu, keys
menu, hi-score entry) and again when the page is hidden. Add `BB_NO_PERSIST=1` to run with the shipped files only.

Both tests drive the game with real browser key events, waiting on what the
game shows rather than on fixed delays (helpers in `tools/game_driver.mjs`):

```sh
node tools/input_test.mjs http://localhost:8000/   # both players, focus loss, keys the page must not act on, AZERTY, gamepad
node tools/saves_test.mjs http://localhost:8000/   # settings and hi-scores survive a reload; damaged storage
```
