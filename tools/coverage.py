#!/usr/bin/env python3
"""Full-game pixel coverage: native build vs browser build.

Plays every part of the game (menus, character selection, each level of
data/bb.lst with its briefing, RPG dialogue scenes, the pause menu, game over,
hi-scores and the end sequence) in both builds with the fixed-step harness and
the same input script, and compares every frame by a hash of its pixels
(BB_HASH_EVERY, computed by the same harness code in both builds). Pictures
and diff images are saved only for frames that differ.

usage: python3 tools/coverage.py [--native BIN] [--dist DIR] [--out DIR]
                                 [--jobs N] [--every N] [--repeat N]
                                 [--list] [segment ...]

  --native  native binary built from game/ with CMake (default: build/blipblop)
  --dist    browser build output (default: web/dist); served on a free port
  --out     work directory (default: /tmp/bb-coverage): hashes, logs, diffs
  --every   compare every Nth frame (default 1: every frame)
  --repeat  run the native build N times per segment and require identical
            hashes, to catch nondeterminism such as uninitialised memory
  segment   names to run (default: all); --list prints them

Needs Playwright for Node (tools/web_dump.mjs) and CHROMIUM_PATH if Chromium
is not where Playwright looks by default. Exits 1 if any frame differs, a run
crashed, exited non-zero or missed frames, or native repeats disagree; exits
with a "disk full" message if frames could not be written.
"""
import argparse
import errno
import functools
import http.server
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STEP_MS = 11

class Script:
    """Input script for BB_INPUT_SCRIPT: '<step> <down|up> <SDL key name>'."""

    def __init__(self):
        self.events = []

    def press(self, t, key, hold=1):
        self.events.append((t, 'down', key))
        self.events.append((t + hold, 'up', key))
        return self

    def hold(self, t0, t1, key):
        self.events.append((t0, 'down', key))
        self.events.append((t1, 'up', key))
        return self

    def text(self):
        return ''.join(f'{t} {a} {k}\n' for t, a, k in sorted(self.events))


# Harness steps (frames, plus one step per turn of a blocking key wait) at
# which the menus are ready, measured on the native build. The intro is
# skipped with Escape.
SKIP_INTRO = 20
BRIEFING_KEY = 160  # the briefing "press a key" screen is up by step ~134
PLAY_START = 170


def start_game(s, character='blip'):
    """Main menu -> START GAME -> 1 PLAYER -> character -> briefing key."""
    s.press(SKIP_INTRO, 'Escape', 2)
    s.press(60, 'Return')    # START GAME
    s.press(80, 'Return')    # START 1 PLAYER GAME
    if character == 'blop':
        s.press(115, 'Right')
        s.press(175, 'Return')
        return 205, 215      # briefing key, play start
    s.press(130, 'Return')   # Blip
    return BRIEFING_KEY, PLAY_START


def play(s, t0, length):
    """Runs right through the level shooting and jumping, turns back once."""
    turn = t0 + int(length * 0.6)
    back = t0 + int(length * 0.75)
    s.hold(t0, turn, 'Right')
    s.hold(turn, back, 'Left')
    s.hold(back, t0 + length, 'Right')
    for t in range(t0 + 4, t0 + length, 8):
        s.press(t, 'Left Ctrl', 4)
    for t in range(t0 + 30, t0 + length, 60):
        s.press(t, 'Menu', 10)
    s.hold(t0 + int(length * 0.4), t0 + int(length * 0.4) + 20, 'Up')
    s.press(t0 + length // 2, 'Space', 3)
    return t0 + length


# Levels of data/bb.lst and how many steps to play each. Longer runs reach
# the RPG dialogue scenes that start early in a level (snuf1, bisous2, lem,
# videoboss); finalboss opens with one.
LEVELS = [('snuf1', 1100), ('snuf2', 400), ('dork', 400), ('bisous1', 400),
          ('bisous2', 900), ('bisous3', 400), ('snorkniv', 400),
          ('snorkniv2', 400), ('lem', 900), ('video', 400),
          ('videoboss', 900), ('finalboss', 600)]


def segments():
    segs = []
    base = {'BB_DEFAULT_CONFIG': '1'}

    # The intro cinematic untouched, every 50th frame as in the README (the
    # regression bar).
    segs.append(dict(name='intro', env={}, script=Script(), frames=1500,
                     every=50))

    # Menus: options (vsync toggle, P1 keys list), start menu, character
    # selection back and forth, then the first briefing and a bit of level 1
    # with Blop.
    s = Script()
    s.press(SKIP_INTRO, 'Escape', 2)
    s.press(40, 'Down')        # OPTIONS
    s.press(50, 'Return')
    s.press(65, 'Right')       # VSYNC toggle
    s.press(75, 'Down')
    s.press(85, 'Down')        # P1 KEYS
    s.press(95, 'Return')
    for t in range(110, 180, 10):
        s.press(t, 'Down')     # down to RETURN
    s.press(185, 'Return')     # back to the main menu
    s.press(200, 'Up')         # START GAME
    s.press(210, 'Return')
    s.press(220, 'Down')       # START 2 PLAYERS GAME
    s.press(230, 'Up')
    s.press(240, 'Return')     # START 1 PLAYER GAME
    s.press(290, 'Right')      # Blip -> Blop
    s.press(360, 'Left')       # Blop -> Blip
    s.press(430, 'Right')      # Blip -> Blop
    s.press(500, 'Return')     # Blop
    s.press(530, 'Return')     # briefing
    end = play(s, 540, 160)
    segs.append(dict(name='menus', env=dict(base, BB_START_LEVEL='1'),
                     script=s, frames=end))

    # Each level, from the briefing before it. Level 1 also opens the pause
    # menu and resumes.
    for i, (lvl, length) in enumerate(LEVELS, 1):
        s = Script()
        brief, t0 = start_game(s)
        s.press(brief, 'Return')
        if i == 1:
            s.press(t0 + 100, 'Escape', 2)
            s.press(t0 + 130, 'Down')
            s.press(t0 + 140, 'Up')
            s.press(t0 + 150, 'Return')
            t0 += 160
        end = play(s, t0, length)
        segs.append(dict(name=f'level{i:02d}-{lvl}',
                         env=dict(base, BB_START_LEVEL=str(i)),
                         script=s, frames=end))

    # Game over: one life in level 2, walk right into the smurfs without
    # shooting until killed (~step 1450), then the game over screen until a
    # key, which also skips the hi-score table, and back to the menu.
    s = Script()
    brief, t0 = start_game(s)
    s.press(brief, 'Return')
    for t in range(t0, 1450, 100):
        s.hold(t, t + 95, 'Right')
    s.press(2100, 'Return')
    segs.append(dict(name='gameover', env=dict(base, BB_START_LEVEL='2',
                                               BB_LIVES='1'),
                     script=s, frames=2300))

    # End sequence: the whole end cinematic (~3000 steps), the end picture,
    # the end credits (~9000 steps), THE END / level complete, entering a
    # name for the hi-score table, the table, and back to the menu.
    s = Script()
    start_game(s)
    s.press(3100, 'Return')    # end picture -> credits
    s.press(12200, 'Return')   # THE END picture -> level complete
    s.press(12500, 'Return')   # level complete -> hi-score name entry
    for i, key in enumerate('CLAUDE'):
        s.press(12900 + 50 * i, key)
    s.press(13250, 'Return')   # name done -> hi-score table
    segs.append(dict(name='ending', env=dict(base, BB_START_LEVEL='13'),
                     script=s, frames=14200))

    # Attract mode: idle on the main menu -> title screen -> menu -> hi-score
    # table.
    s = Script()
    s.press(SKIP_INTRO, 'Escape', 2)
    segs.append(dict(name='attract', env=dict(base), script=s, frames=3300))
    return segs


def serve(directory):
    handler = functools.partial(QuietHandler, directory=directory)
    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class DiskFull(Exception):
    pass


def read_hashes(path):
    """'<frame> <hash>' lines -> {frame: hash}."""
    if not os.path.exists(path):
        return {}
    with open(path) as f:
        return dict(line.split() for line in f if line.strip())


def describe_exit(code):
    if code is None:
        return 'timed out'
    if code < 0:
        return f'crashed (signal {-code})'
    return f'exit status {code}'


def run_native(args, seg, out, script_path, every, tag, dump_frames=None):
    """One native run. Returns (problem or None, {frame: hash})."""
    run_dir = os.path.join(out, f'native-run-{tag}')
    hashes = os.path.join(out, f'native-{tag}.hashes')
    shutil.rmtree(run_dir, ignore_errors=True)
    # The game writes data/bb.cfg and data/bb.scr: run it on a copy.
    shutil.copytree(os.path.join(ROOT, 'game', 'data'),
                    os.path.join(run_dir, 'data'))
    env = dict(os.environ, SDL_VIDEODRIVER='offscreen',
               SDL_RENDER_DRIVER='software', SDL_AUDIODRIVER='dummy',
               BB_FIXED_STEP_MS=str(STEP_MS), BB_HASH_EVERY=str(every),
               BB_HASH_FILE=hashes, BB_MAX_FRAMES=str(seg['frames']),
               BB_INPUT_SCRIPT=script_path, **seg['env'])
    if dump_frames:
        frames = os.path.join(out, 'native')
        os.makedirs(frames, exist_ok=True)
        env.update(BB_DUMP_DIR=frames,
                   BB_DUMP_FRAMES=','.join(str(n) for n in dump_frames))
    code = None
    with open(os.path.join(out, f'native-{tag}.log'), 'w') as log:
        try:
            code = subprocess.run([os.path.abspath(args.native)], cwd=run_dir,
                                  env=env, stdout=log,
                                  stderr=subprocess.STDOUT,
                                  timeout=3600).returncode
        except subprocess.TimeoutExpired:
            pass
    shutil.rmtree(run_dir, ignore_errors=True)
    if code == 3:  # the harness could not write a dump or a hash
        raise DiskFull(f'native run could not write its output in {out}')
    return (None if code == 0 else describe_exit(code)), read_hashes(hashes)


def run_web(url, seg, out, script_path, every, dump_frames=None):
    """One browser run. Returns (problem or None, {frame: hash})."""
    frames = os.path.join(out, 'web')
    env = dict(os.environ, BB_FIXED_STEP_MS=str(STEP_MS),
               BB_HASH_EVERY=str(every), DUMP_TIMEOUT_MS=str(3600 * 1000),
               **seg['env'])
    image_every = '0'
    if dump_frames:
        env['BB_DUMP_FRAMES'] = ','.join(str(n) for n in dump_frames)
        image_every = '1'
    log_path = os.path.join(out, 'web-images.log' if dump_frames
                            else 'web.log')
    code = None
    with open(log_path, 'w') as log:
        try:
            code = subprocess.run(
                ['node', os.path.join(ROOT, 'tools', 'web_dump.mjs'), url,
                 frames, image_every, str(seg['frames']), script_path],
                env=env, stdout=log, stderr=subprocess.STDOUT,
                timeout=3700).returncode
        except subprocess.TimeoutExpired:
            pass
    with open(log_path) as f:
        if 'ENOSPC' in f.read():
            raise DiskFull(f'browser run could not write its output in {out}')
    path = os.path.join(frames, 'hashes.txt')
    hashes = read_hashes(path)
    if os.path.exists(path):
        os.remove(path)
    return (None if code == 0 else describe_exit(code)), hashes


def save_diffs(seg, args, url, out, script_path, frames):
    """Re-runs both builds saving only the first differing frames; keeps the
    diff images (native | browser | changed pixels) in <out>/diff."""
    frames = sorted(frames)[:12]
    run_native(args, seg, out, script_path, args.every, 'images',
               dump_frames=frames)
    run_web(url, seg, out, script_path, args.every, dump_frames=frames)
    subprocess.run([sys.executable,
                    os.path.join(ROOT, 'tools', 'compare_frames.py'),
                    os.path.join(out, 'native'), os.path.join(out, 'web'),
                    os.path.join(out, 'diff')], capture_output=True)
    shutil.rmtree(os.path.join(out, 'native'), ignore_errors=True)
    shutil.rmtree(os.path.join(out, 'web'), ignore_errors=True)


def run_segment(seg, args, url):
    out = os.path.join(args.out, seg['name'])
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out)
    every = seg.get('every', args.every)
    script_path = os.path.join(out, 'input.txt')
    with open(script_path, 'w') as f:
        f.write(seg['script'].text())
    with open(os.path.join(out, 'env.json'), 'w') as f:
        json.dump(dict(seg['env'], BB_HASH_EVERY=every,
                       BB_MAX_FRAMES=seg['frames']), f, indent=1)
    t = time.time()
    problems = []

    runs = []
    for i in range(args.repeat):
        err, hashes = run_native(args, seg, out, script_path, every, i + 1)
        if err:
            problems.append(f'native run {i + 1}: {err}')
        runs.append(hashes)
    native = runs[0]
    unstable = sorted({n for h in runs[1:] for n in set(h) | set(native)
                       if h.get(n) != native.get(n)})
    if unstable:
        problems.append(f'native runs disagree on {len(unstable)} frames '
                        f'(first {unstable[0]})')

    err, web = run_web(url, seg, out, script_path, every)
    if err:
        problems.append(f'browser: {err}')
    for name, h in (('native', native), ('browser', web)):
        if not h:
            problems.append(f'{name}: no frames')
    lonely = sorted(set(native) ^ set(web))
    if lonely:
        problems.append(f'{len(lonely)} frames in one build only '
                        f'(first {lonely[0]})')
    common = sorted(set(native) & set(web))
    differ = [n for n in common if native[n] != web[n]]
    with open(os.path.join(out, 'compare.txt'), 'w') as f:
        for n in common:
            same = native[n] == web[n]
            f.write(f"frame_{n}: {'identical' if same else 'different'}\n")
        f.write(f'{len(common) - len(differ)}/{len(common)} frames identical\n')
    if differ:
        problems.append(f'{len(differ)} frames differ (first {differ[0]}); '
                        f'diff images in {out}/diff')
        save_diffs(seg, args, url, out, script_path, [int(n) for n in differ])

    res = dict(name=seg['name'], steps=seg['frames'], every=every,
               native_frames=len(native), web_frames=len(web),
               compared=len(common), identical=len(common) - len(differ),
               native_runs=args.repeat, problems=problems,
               seconds=round(time.time() - t))
    print(f"{seg['name']:20s} {res['compared']:6d} compared "
          f"{res['identical']:6d} identical (native {len(native)} x"
          f"{args.repeat}, browser {len(web)}) "
          f"{'FAIL' if problems else 'OK'}  {res['seconds']}s", flush=True)
    for p in problems:
        print('    ' + p, flush=True)
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--native', default=os.path.join(ROOT, 'build', 'blipblop'))
    ap.add_argument('--dist', default=os.path.join(ROOT, 'web', 'dist'))
    ap.add_argument('--out', default='/tmp/bb-coverage')
    ap.add_argument('--jobs', type=int, default=2)
    ap.add_argument('--every', type=int, default=1)
    ap.add_argument('--repeat', type=int, default=1)
    ap.add_argument('--list', action='store_true')
    ap.add_argument('segments', nargs='*')
    args = ap.parse_args()

    segs = segments()
    if args.list:
        for s in segs:
            print(f"{s['name']:20s} {s['frames']:5d} steps  {s['env']}")
        return
    if args.segments:
        unknown = set(args.segments) - {s['name'] for s in segs}
        if unknown:
            sys.exit(f'unknown segments: {sorted(unknown)}')
        segs = [s for s in segs if s['name'] in args.segments]
    if args.every < 1 or args.repeat < 1:
        sys.exit('--every and --repeat must be at least 1')
    if not os.path.exists(args.native):
        sys.exit(f'native binary not found: {args.native}')

    try:
        os.makedirs(args.out, exist_ok=True)
        free = shutil.disk_usage(args.out).free
        if free < 1 << 30:
            raise DiskFull(f'only {free >> 20} MB free under {args.out}')
        httpd = serve(args.dist)
        url = f'http://127.0.0.1:{httpd.server_address[1]}/'
        with ThreadPoolExecutor(args.jobs) as pool:
            results = list(pool.map(lambda s: run_segment(s, args, url),
                                    segs))
        httpd.shutdown()
        with open(os.path.join(args.out, 'summary.json'), 'w') as f:
            json.dump(results, f, indent=1)
    except DiskFull as e:
        sys.exit(f'disk full: {e}')
    except OSError as e:
        if e.errno == errno.ENOSPC:
            sys.exit(f'disk full: {e}')
        raise

    print()
    print(f"{'segment':20s} {'compared':>8s} {'identical':>9s}  result")
    for r in results:
        print(f"{r['name']:20s} {r['compared']:8d} {r['identical']:9d}  "
              f"{'FAIL' if r['problems'] else 'OK'}")
    total = sum(r['compared'] for r in results)
    same = sum(r['identical'] for r in results)
    print(f"{'total':20s} {total:8d} {same:9d}")
    sys.exit(1 if any(r['problems'] for r in results) else 0)


if __name__ == '__main__':
    main()
