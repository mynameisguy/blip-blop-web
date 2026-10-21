#!/usr/bin/env python3
"""Full-game pixel coverage: native build vs browser build.

Plays every part of the game (menus, character selection, each level of
data/bb.lst with its briefing, RPG dialogue scenes, the pause menu, game over,
hi-scores and the end sequence) in both builds with the fixed-step harness and
the same input script, dumps sampled frames and compares them pixel for pixel
with tools/compare_frames.py.

usage: python3 tools/coverage.py [--native BIN] [--dist DIR] [--out DIR]
                                 [--jobs N] [--every N] [segment ...]

  --native  native binary built from game/ with CMake (default: build/blipblop)
  --dist    browser build output (default: web/dist); served on a free port
  --out     work directory (default: /tmp/bb-coverage); frames, diffs, logs
  segment   names to run (default: all); --list prints them

Needs Playwright for Node (tools/web_dump.mjs) and CHROMIUM_PATH if Chromium
is not where Playwright looks by default. Exits non-zero if any compared frame
differs, a run produced no frames, or the browser missed a frame.
"""
import argparse
import functools
import http.server
import json
import os
import re
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

    # The intro cinematic untouched, as in the README (the regression bar).
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
                     script=s, frames=end, every=5))

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
                         script=s, frames=end, every=10))

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
                     script=s, frames=2300, every=20))

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
                     script=s, frames=14200, every=25))

    # Attract mode: idle on the main menu -> title screen -> menu -> hi-score
    # table.
    s = Script()
    s.press(SKIP_INTRO, 'Escape', 2)
    segs.append(dict(name='attract', env=dict(base), script=s, frames=3300,
                     every=50))
    return segs


def serve(directory):
    handler = functools.partial(QuietHandler, directory=directory)
    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def run_native(binary, seg, out, script_path):
    run_dir = os.path.join(out, 'native-run')
    frames = os.path.join(out, 'native')
    shutil.rmtree(run_dir, ignore_errors=True)
    shutil.rmtree(frames, ignore_errors=True)
    os.makedirs(frames)
    # The game writes data/bb.cfg and data/bb.scr: run it on a copy.
    shutil.copytree(os.path.join(ROOT, 'game', 'data'),
                    os.path.join(run_dir, 'data'))
    env = dict(os.environ, SDL_VIDEODRIVER='offscreen',
               SDL_RENDER_DRIVER='software', SDL_AUDIODRIVER='dummy',
               BB_FIXED_STEP_MS=str(STEP_MS), BB_DUMP_DIR=frames,
               BB_DUMP_EVERY=str(seg['every']), BB_MAX_FRAMES=str(seg['frames']),
               BB_INPUT_SCRIPT=script_path, **seg['env'])
    with open(os.path.join(out, 'native.log'), 'w') as log:
        subprocess.run([os.path.abspath(binary)], cwd=run_dir, env=env,
                       stdout=log, stderr=subprocess.STDOUT, timeout=1800)
    shutil.rmtree(run_dir, ignore_errors=True)
    return frames


def run_web(url, seg, out, script_path):
    frames = os.path.join(out, 'web')
    shutil.rmtree(frames, ignore_errors=True)
    env = dict(os.environ, BB_FIXED_STEP_MS=str(STEP_MS),
               DUMP_TIMEOUT_MS=str(1800 * 1000), **seg['env'])
    with open(os.path.join(out, 'web.log'), 'w') as log:
        subprocess.run(['node', os.path.join(ROOT, 'tools', 'web_dump.mjs'),
                        url, frames, str(seg['every']), str(seg['frames']),
                        script_path],
                       env=env, stdout=log, stderr=subprocess.STDOUT,
                       timeout=2000)
    return frames


def run_segment(seg, args, url):
    out = os.path.join(args.out, seg['name'])
    os.makedirs(out, exist_ok=True)
    script_path = os.path.join(out, 'input.txt')
    with open(script_path, 'w') as f:
        f.write(seg['script'].text())
    with open(os.path.join(out, 'env.json'), 'w') as f:
        json.dump(dict(seg['env'], BB_DUMP_EVERY=seg['every'],
                       BB_MAX_FRAMES=seg['frames']), f, indent=1)
    t = time.time()
    native = run_native(args.native, seg, out, script_path)
    web = run_web(url, seg, out, script_path)
    diff = os.path.join(out, 'diff')
    shutil.rmtree(diff, ignore_errors=True)
    r = subprocess.run([sys.executable, os.path.join(ROOT, 'tools',
                                                     'compare_frames.py'),
                        native, web, diff], capture_output=True, text=True)
    with open(os.path.join(out, 'compare.txt'), 'w') as f:
        f.write(r.stdout + r.stderr)
    n_native = len([f for f in os.listdir(native) if f.endswith('.bmp')])
    n_web = len([f for f in os.listdir(web) if f.endswith('.rgba')]) \
        if os.path.isdir(web) else 0
    m = re.search(r'(\d+)/(\d+) frames identical', r.stdout)
    same, total = (int(m.group(1)), int(m.group(2))) if m else (0, 0)
    bad = [l for l in r.stdout.splitlines()
           if l.startswith('frame_') and not l.endswith('identical')]
    res = dict(name=seg['name'], steps=seg['frames'], every=seg['every'],
               native_frames=n_native, web_frames=n_web, compared=total,
               identical=same, mismatches=bad, seconds=round(time.time() - t))
    ok = total > 0 and same == total and n_web == n_native
    print(f"{seg['name']:22s} {total:4d} compared {same:4d} identical "
          f"(native {n_native}, browser {n_web}) "
          f"{'OK' if ok else 'FAIL'}  {res['seconds']}s", flush=True)
    for l in bad[:10]:
        print('    ' + l, flush=True)
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--native', default=os.path.join(ROOT, 'build', 'blipblop'))
    ap.add_argument('--dist', default=os.path.join(ROOT, 'web', 'dist'))
    ap.add_argument('--out', default='/tmp/bb-coverage')
    ap.add_argument('--jobs', type=int, default=2)
    ap.add_argument('--every', type=int,
                    help='dump every N frames in all segments (default: per segment)')
    ap.add_argument('--list', action='store_true')
    ap.add_argument('segments', nargs='*')
    args = ap.parse_args()

    segs = segments()
    if args.list:
        for s in segs:
            print(f"{s['name']:22s} {s['frames']:5d} steps, every {s['every']}, "
                  f"{s['env']}")
        return
    if args.segments:
        unknown = set(args.segments) - {s['name'] for s in segs}
        if unknown:
            sys.exit(f'unknown segments: {sorted(unknown)}')
        segs = [s for s in segs if s['name'] in args.segments]

    if args.every:
        for s in segs:
            s['every'] = args.every

    os.makedirs(args.out, exist_ok=True)
    httpd = serve(args.dist)
    url = f'http://127.0.0.1:{httpd.server_address[1]}/'
    with ThreadPoolExecutor(args.jobs) as pool:
        results = list(pool.map(lambda s: run_segment(s, args, url), segs))
    httpd.shutdown()

    print()
    print(f"{'segment':22s} {'compared':>8s} {'identical':>9s}")
    for r in results:
        print(f"{r['name']:22s} {r['compared']:8d} {r['identical']:9d}")
    total = sum(r['compared'] for r in results)
    same = sum(r['identical'] for r in results)
    print(f"{'total':22s} {total:8d} {same:9d}")
    with open(os.path.join(args.out, 'summary.json'), 'w') as f:
        json.dump(results, f, indent=1)
    failed = [r for r in results if not (r['compared'] > 0 and
              r['identical'] == r['compared'] and
              r['web_frames'] == r['native_frames'])]
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
