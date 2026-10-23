// Plays the game with the touch controls alone on an emulated phone (touch
// only, mobile), following what the game shows through the harness frames
// (tools/game_driver.mjs):
//   - the first tap enters fullscreen;
//   - the intro shows a Skip button, and Skip skips it;
//   - the menus show arrows and OK, and taps and swipes on the picture move
//     through them: from the title to level 1 with no key pressed, and the
//     briefing's "press a key" is passed with Skip;
//   - in the level the floating stick moves Blip left and right and aims in
//     all 8 directions, each sending the player 1 keys for its direction
//     (dead zone, no flicker on a boundary, the stick follows the thumb),
//     and Blip stops when the thumb lifts; Jump jumps;
//   - auto-fire holds Fire and bullets keep coming for seconds, it is let
//     go in the pause menu, and the setting survives a reload;
//   - pause opens the game menu, whose controls are the menu ones;
//   - after chaos (several fingers, slides off the controls, cancelled
//     touches, window blur, a hidden page, random multi-touch) no key stays
//     down and Blip stands still;
//   - no control covers the HUD, lying down or upright;
//   - a drag beside the picture while holding Fire does not scroll or zoom,
//     and the browser never refuses to cancel a touch event;
//   - with the game's default keys (BB_DEFAULT_CONFIG), Jump, bound to
//     SDLK_MENU, which no browser key produces, still jumps;
//   - a touch does not stall the game (frame gaps around it), and 30 ms
//     taps on Jump, pause and OK work;
//   - a hi-score name can be typed with the soft keyboard (a hidden text
//     field) at a normal speed, from keyboards that report only text and
//     ones that send key codes, with a mistake deleted and OK tapped right
//     after the last key, and is saved whole (the first letters typed while
//     the prompt still slides in); nothing typed after OK reaches the game;
//   - with two players, both names are typed by touch, back to back, and
//     saved, and a hardware key held into the first name entry lets go;
//   - a window blur or a hidden page while a name (and its Return) is
//     still going out, before or after OK, even right as a letter is
//     pressed, loses nothing; composed text (IME) is typed once.
// Screenshots of a menu and a level, lying down and upright, go to outdir.
//
//   node tools/check_touch.mjs <url> [outdir] [--device WxH@R] [--only main|defaults|name|twop]
// (default device 844x390@3; the upright shots use the same phone turned.)
// Needs Playwright (npm i playwright); CHROMIUM_PATH picks the browser.
import * as D from './game_driver.mjs';
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : null; };
const pos = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const url = pos[0] || 'http://localhost:8000/';
const out = pos[1] || null;
const [W, H, DPR] = (opt('device') || '844x390@3').split(/[x@]/).map(Number);
const { check, sleep, state, waitState, describe, StepError } = D;

await D.setup(url, out);
const context = await D.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: DPR,
                                     isMobile: true, hasTouch: true });
// Every key the page sends the game: held keys, and a log.
// The time of every game frame (window.__ft), to see whether a touch
// stalls the game.
const frameTimes = () => {
  const f = window.bbHooks.onFrame;
  window.__ft = [];
  window.bbHooks.onFrame = function (...a) {
    window.__ft.push(performance.now());
    if (window.__ft.length > 600) window.__ft.splice(0, 300);
    return f.apply(this, a);
  };
};
// A stand-in for window.visualViewport whose height drops by window.__kb
// px, as when a soft keyboard comes up (the emulator has none).
const fakeKeyboard = () => {
  const real = window.visualViewport;
  if (!real) return;
  const fake = new EventTarget();
  for (const k of ['offsetLeft', 'offsetTop', 'pageLeft', 'pageTop', 'width', 'scale'])
    Object.defineProperty(fake, k, { get: () => real[k] });
  Object.defineProperty(fake, 'height', { get: () => real.height - (window.__kb || 0) });
  Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => fake });
};
const keyLog = () => {
  window.__down = {};
  window.__log = [];
  for (const type of ['keydown', 'keyup'])
    window.addEventListener(type, e => {
      if (e.isTrusted) return;
      window.__log.push(`${type} ${e.code}`);
      if (type === 'keydown') window.__down[e.code] = 1; else delete window.__down[e.code];
    }, true);
};
let { page, errors } = await D.newGamePage({ context, initScripts: [keyLog, frameTimes] });
let cdp = await context.newCDPSession(page);
// The browser's warning when a page cancels a touch event it may no longer
// cancel (because it started scrolling or zooming).
let interventions = [];
function watchConsole(p) {
  p.on('console', m => { if (/Ignored attempt to cancel/.test(m.text())) interventions.push(m.text()); });
}
watchConsole(page);
const shot = async name => { if (out) await page.screenshot({ path: `${out}/${name}.png` }); };

// ---- Touch helpers (CDP touch events, several fingers) ----
const fingers = new Map();
async function sendTouches(type) {
  const touchPoints = [...fingers].map(([id, [x, y]]) => ({ x, y, id, radiusX: 6, radiusY: 6 }));
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : touchPoints });
}
async function fdown(id, x, y) { fingers.set(id, [x, y]); await sendTouches('touchStart'); }
async function fmove(id, x, y) { fingers.set(id, [x, y]); await sendTouches('touchMove'); }
// Lifts one finger; the others stay down. (CDP: a touchEnd lists the
// points that end; an empty one ends them all.)
async function fup(id) {
  const at = fingers.get(id);
  fingers.delete(id);
  if (!at) return;
  if (!fingers.size) return sendTouches('touchEnd');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ x: at[0], y: at[1], id, radiusX: 6, radiusY: 6 }] });
}
async function fcancel() { fingers.clear(); await sendTouches('touchCancel'); }
async function box(sel) {
  return page.$eval(sel, e => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, cx: b.x + b.width / 2, cy: b.y + b.height / 2 }; });
}
// A quick tap, as a thumb makes one.
async function tapAt(x, y, ms = 40) { await fdown(1, x, y); await sleep(ms); await fup(1); await sleep(100); }
async function tap(sel, ms) { const b = await box(sel); await tapAt(b.cx, b.cy, ms); }
// A swipe on the picture, starting at its centre.
async function swipe(dy, dx = 0) {
  const p = await box('#view:not([hidden]), #canvas');
  const x = p.cx, y = p.cy;
  await fdown(1, x, y);
  for (let i = 1; i <= 5; i++) { await fmove(1, x + dx * i / 5, y + dy * i / 5); await sleep(16); }
  await sleep(120);
  await fup(1);
  await sleep(100);
}
const held = () => page.evaluate(() => Object.keys(window.__down).sort().join());
const uiMode = () => page.evaluate(() => Module._bb_ui_mode());
const touchMode = () => page.evaluate(() => document.getElementById('touch').dataset.mode);
const visible = sel => page.$eval(sel, e => getComputedStyle(e).display !== 'none' && !e.closest('[hidden]'));
async function waitMode(m, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await uiMode() === m) return true; await sleep(50); }
  return false;
}
// Taps until the game shows what pred describes (a tap during a transition
// is dropped by the game, as a key press would be).
async function tapUntil(act, goal, pred, { tries = 6, wait = 2000 } = {}) {
  for (let i = 0; i < tries; i++) {
    await act();
    if (await waitState(page, pred, wait)) return;
  }
  throw new StepError(`tapped ${tries} times but never reached ${goal}; the game shows ${describe(await state(page))}`);
}
// No control over the HUD band (the picture's top 100 of 480 rows).
async function hudClear(label) {
  const r = await page.evaluate(() => {
    const view = document.getElementById('view');
    const pic = (view && !view.hidden ? view : document.getElementById('canvas')).getBoundingClientRect();
    const hud = [pic.left, pic.top, pic.right, pic.top + pic.height * 100 / 480];
    const over = Array.from(document.querySelectorAll('#touch > *'))
      .filter(el => el.id !== 'gesture' && el.id !== 'stick' && getComputedStyle(el).display !== 'none')
      .filter(el => { const b = el.getBoundingClientRect(); return b.left < hud[2] - 0.5 && b.right > hud[0] + 0.5 && b.top < hud[3] - 0.5 && b.bottom > hud[1] + 0.5; })
      .map(el => el.id);
    return { over, hud: hud.map(Math.round) };
  });
  check(r.over.length === 0, `${label}: no control over the HUD`, `HUD ${r.hud}; over it: ${r.over.join(' ') || 'none'}`);
}
// Turns the phone upright for a screenshot, then back.
async function bothWays(name) {
  await shot(`${name}-landscape`);
  await hudClear(`${name}, lying down`);
  await page.setViewportSize({ width: H, height: W });
  await sleep(600);
  await shot(`${name}-portrait`);
  await hudClear(`${name}, upright`);
  await page.setViewportSize({ width: W, height: H });
  await sleep(600);
}

// Blip's aim: where his gun's dark grey pixels sit relative to his blue
// body, and his body's position.
async function aim() {
  return page.evaluate(() => new Promise(resolve => {
    window.bbGrab = ({ pixels, pitch }) => {
      let n = 0, sx = 0, sy = 0;
      for (let y = 100; y < 480; y++) for (let x = 0; x < 640; x++) {
        const i = y * pitch + x * 4, r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
        if (b > 150 && b > r + 100 && b > g + 70) { n++; sx += x; sy += y; }
      }
      if (n < 30) return resolve(null);
      const bx = sx / n, by = sy / n;
      const pts = [];
      for (let y = Math.max(100, Math.round(by - 50)); y < Math.min(480, by + 50); y++)
        for (let x = Math.max(0, Math.round(bx - 50)); x < Math.min(640, bx + 50); x++) {
          const i = y * pitch + x * 4, r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
          if (r > 50 && r < 150 && Math.abs(r - g) < 14 && Math.abs(g - b) < 14) pts.push([x, y]);
        }
      const m = pts.length || 1;
      const gx = pts.reduce((s, p) => s + p[0], 0) / m, gy = pts.reduce((s, p) => s + p[1], 0) / m;
      let cxx = 0, cyy = 0, cxy = 0;
      for (const [x, y] of pts) { cxx += (x - gx) ** 2; cyy += (y - gy) ** 2; cxy += (x - gx) * (y - gy); }
      // The gun's axis, in degrees: 0 level, -45 "/" (up-right), 45 "\", +-90 upright.
      const ang = 0.5 * Math.atan2(2 * cxy, cxx - cyy) * 180 / Math.PI;
      resolve({ x: bx, y: by, dx: gx - bx, dy: gy - by, ang, gun: pts.length });
    };
  }));
}
// Orange bullet pixels at Blip's height (not beside him), that were not
// there in the reference frame (taken with `reset`, Blip standing still, so
// the scenery is the same).
async function bullets(reset = false) {
  return page.evaluate(reset => new Promise(resolve => {
    window.bbGrab = ({ pixels, pitch }) => {
      if (reset) window.__bbRef = pixels.slice();
      const ref = window.__bbRef;
      let n = 0, bx = 0, by = 0, nb = 0;
      for (let y = 100; y < 480; y++) for (let x = 0; x < 640; x++) {
        const i = y * pitch + x * 4, r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
        if (b > 150 && b > r + 100 && b > g + 70) { bx += x; by += y; nb++; }
      }
      const px = nb ? bx / nb : 0, py = nb ? by / nb : 0;
      for (let y = Math.max(100, Math.round(py - 40)); y < Math.min(480, py + 40); y++) for (let x = 0; x < 640; x++) {
        if (Math.abs(x - px) < 40) continue;
        const i = y * pitch + x * 4, r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
        if (r > 180 && g > 80 && g < 190 && b < 120 && r - g > 50 &&
            Math.abs(r - ref[i]) + Math.abs(g - ref[i + 1]) + Math.abs(b - ref[i + 2]) > 60) n++;
      }
      resolve(n);
    };
  }), reset);
}

const only = opt('only');  // main, defaults or name: run just that part
if (!only || only === 'main') try {
  // ---- First tap: fullscreen ----
  await page.waitForFunction(() => !document.getElementById('touch').hidden, null, { timeout: 30000 });
  const vp = await box('#stage');
  await tapAt(vp.cx, vp.cy);
  await sleep(500);
  check(await page.evaluate(() => !!(document.fullscreenElement || document.webkitFullscreenElement)),
        'the first tap enters fullscreen');

  // ---- Intro: Skip ----
  check(await waitMode(2, 5000) && await touchMode() === 'scene' && await visible('#t-skip') && !await visible('#stick'),
        'the intro shows the Skip button (and no level controls)', `mode ${await uiMode()}/${await touchMode()}`);
  await shot('intro-landscape');
  await tapUntil(() => tap('#t-skip'), 'the main menu', s => s.title);
  check(true, 'Skip skips the intro to the main menu');

  // ---- Menus by taps and swipes ----
  check(await waitMode(0, 3000) && await touchMode() === 'menu' && await visible('#t-ok') &&
        await visible('#t-up') && await visible('#t-down') && !await visible('#t-skip'),
        'menus show the arrows and OK');
  await sleep(500);
  const h0 = (await state(page)).hash;
  await tapUntil(() => swipe(80), 'OPTIONS (swipe down)', s => s.title && s.hash !== h0);
  const h1 = (await state(page)).hash;
  await tapUntil(() => swipe(-80), 'START GAME (swipe up)', s => s.title && s.hash === h0);
  check(true, 'swiping down and up moves through the main menu');
  await tapUntil(() => tap('#t-down'), 'OPTIONS (down arrow)', s => s.title && s.hash === h1);
  await tapUntil(() => tap('#t-up'), 'START GAME (up arrow)', s => s.title && s.hash === h0);
  check(true, 'the down and up arrow buttons move through the main menu');
  await bothWays('menu');
  // A tap on the picture is Return: START GAME, then OK: 1 player.
  const pic = await box('#view:not([hidden]), #canvas');
  await tapUntil(() => tapAt(pic.cx, pic.y + pic.h * 0.3), 'the START GAME menu (tap)', s => s.title && s.hash !== h0);
  await tapUntil(() => tap('#t-ok'), 'character select (OK)', s => s.charsel);
  let last = null;
  await waitState(page, s => {
    const ok = s.charsel && s.blue && last && Math.abs(s.blue.x - last.x) < 1 && s.frame > last.frame;
    if (s.blue) last = { x: s.blue.x, frame: s.frame };
    return ok;
  }, 5000);
  await tapUntil(() => tapAt(pic.cx, pic.y + pic.h * 0.3), 'the briefing (tap)', s => !s.charsel);
  check(true, 'taps on the picture and OK choose menu items, up to character select and the briefing');
  check(await waitMode(3, 30000) && await sleep(200) === undefined && await visible('#t-skip'),
        'the briefing\'s "press a key" shows Skip', `mode ${await uiMode()}`);
  await tapUntil(() => tap('#t-skip'), 'level 1 (Skip)', s => s.level && Date.now() - s.time < 300, { tries: 10, wait: 1500 });
  check(await waitMode(1, 5000) && await touchMode() === 'level' && await visible('#t-fire') &&
        await visible('#stick-zone') && !await visible('#t-ok'),
        'reached level 1 with taps and swipes only; the level shows the stick and Fire / Jump / Special');
  // Wait for Blip to land.
  let prev = null;
  await waitState(page, s => {
    const ok = prev && s.level && s.frame > prev.frame + 20 && s.blue && prev.x !== undefined &&
      Math.abs(s.blue.x - prev.x) < 1 && Math.abs(s.blue.y - prev.y) < 1;
    if (!prev || s.frame > prev.frame + 20) prev = { x: s.blue?.x, y: s.blue?.y, frame: s.frame };
    return ok;
  }, 8000);
  await bothWays('level');

  // ---- The stick ----
  const zone = await box('#stick-zone');
  const R = await page.evaluate(() => document.getElementById('stick').getBoundingClientRect().width / 2);
  const sx = zone.x + zone.w * 0.5, sy = zone.y + zone.h * 0.6;
  // Dead zone.
  await fdown(1, sx, sy);
  await fmove(1, sx + R * 0.15, sy);
  const dead = await held();
  check(dead === '', 'a small move inside the dead zone sends nothing', dead || 'nothing');
  // 8 directions: keys and aim.
  const DIRS = [['right', 0, 'ArrowRight'], ['down-right', 45, 'ArrowDown,ArrowRight'], ['down', 90, 'ArrowDown'],
                ['down-left', 135, 'ArrowDown,ArrowLeft'], ['left', 180, 'ArrowLeft'], ['up-left', 225, 'ArrowLeft,ArrowUp'],
                ['up', 270, 'ArrowUp'], ['up-right', 315, 'ArrowRight,ArrowUp']];
  const aims = {};
  for (const [name, deg, keys] of DIRS) {
    const a = deg * Math.PI / 180;
    await fmove(1, sx + Math.cos(a) * R * 0.7, sy + Math.sin(a) * R * 0.7);
    const k = await held();
    check(k === keys, `stick ${name} holds ${keys}`, k || 'nothing');
    await sleep(250);
    aims[name] = await aim();
  }
  await fup(1);
  await sleep(100);
  check(await held() === '', 'lifting the thumb releases every key');
  // Aim: the gun points the stick's way. Up and down: its axis is upright
  // and it sits higher or lower on Blip; level and diagonal: its axis is
  // level, "/" or "\"
  // (the gun's stock sticks out behind, so only the axis is measured).
  const want = { right: a => Math.abs(a.ang) < 25, left: a => Math.abs(a.ang) < 25,
                 up: a => Math.abs(a.ang) > 70 && a.dy < -4, down: a => Math.abs(a.ang) > 70 && a.dy > 0,
                 'up-right': a => a.ang < -20 && a.ang > -70, 'down-left': a => a.ang < -20 && a.ang > -70,
                 'up-left': a => a.ang > 20 && a.ang < 70, 'down-right': a => a.ang > 20 && a.ang < 70 };
  for (const [name, ok] of Object.entries(want)) {
    const a = aims[name];
    check(a && ok(a), `stick ${name}: Blip aims ${name}`,
          a ? `gun axis ${a.ang.toFixed(0)} deg, gun centre ${a.dx.toFixed(1)},${a.dy.toFixed(1)} from his` : 'Blip not found');
  }
  // Walk right and left, and stop on release.
  for (const [name, dx] of [['right', 1], ['left', -1]]) {
    await fdown(1, sx, sy);
    await fmove(1, sx + dx * R * 0.8, sy);
    const t = await D.track(page, 1200);
    await fup(1);
    const drift = await D.still(page);
    check(dx * t.moved > 40, `stick ${name} walks Blip ${name}`, `moved ${D.fmt(t.moved)} px in 1.2 s`);
    check(Math.abs(drift) < 10, `Blip stops when the thumb lifts (after ${name})`, `drift ${D.fmt(drift)} px`);
  }
  // Hysteresis: once right is held, wobbling across the right/down-right
  // boundary (22.5 degrees) by 4 degrees does not flicker.
  await page.evaluate(() => { window.__log = []; });
  await fdown(1, sx, sy);
  await fmove(1, sx + R * 0.7, sy);
  for (let i = 0; i < 12; i++) {
    const a = (22.5 + (i % 2 ? 4 : -4)) * Math.PI / 180;
    await fmove(1, sx + Math.cos(a) * R * 0.7, sy + Math.sin(a) * R * 0.7);
  }
  const wobble = await page.evaluate(() => window.__log.length);
  // Clearly into down-right (40 degrees): it switches.
  await fmove(1, sx + Math.cos(0.7) * R * 0.7, sy + Math.sin(0.7) * R * 0.7);
  const into = await held();
  check(wobble === 1 && into === 'ArrowDown,ArrowRight',
        'no flicker on a direction boundary, and a clear move still switches',
        `${wobble} key event(s) while wobbling, then ${into}`);
  // Follow: drag far right, then back by 1.5 radii: the stick followed, so
  // that is already left of its centre.
  // (A key let go less than 50 ms after its press is held to 50 ms.)
  await fmove(1, sx + R * 3, sy);
  await sleep(80);
  const far = await held();
  await fmove(1, sx + R * 1.5, sy);
  await sleep(80);
  const back = await held();
  const sc = await page.evaluate(() => { const b = document.getElementById('stick').getBoundingClientRect(); return b.left + b.width / 2; });
  await fup(1);
  check(far === 'ArrowRight' && back === 'ArrowLeft' && Math.abs(sc - (sx + 2 * R)) < 2,
        'the stick follows the thumb when dragged far', `far: ${far}, back 1.5 R: ${back}, stick centre ${Math.round(sc - sx)} px right`);
  await sleep(300);

  // ---- Jump ----
  const j = await D.track(page, 1200, async () => { await tap('#t-jump', 300); });
  check(j.rise > 20, 'Jump makes Blip jump', `rose ${D.fmt(j.rise)} px`);
  await D.still(page);

  // ---- Touches do not stall the game; quick taps count ----
  // The longest time between two game frames around a 30 ms touch, on the
  // stick zone, a button and the picture, against the longest without one.
  const gap = async (from, to) => page.evaluate(([a, b]) => {
    const t = window.__ft.filter(x => x >= a && x <= b);
    let g = 0;
    for (let i = 1; i < t.length; i++) g = Math.max(g, t[i] - t[i - 1]);
    return Math.round(g);
  }, [from, to]);
  const now = () => page.evaluate(() => performance.now());
  let t1 = await now();
  await sleep(400);
  const idleGap = await gap(t1, await now());
  const pv = await box('#view:not([hidden]), #canvas'), sz = await box('#stick-zone'), sp = await box('#t-special');
  const gaps = [];
  for (const [name, x, y] of [['stick zone', sz.cx, sz.cy], ['Special', sp.cx, sp.cy], ['picture', pv.cx, pv.y + pv.h * 0.3]]) {
    await sleep(300);
    t1 = await now();
    await fdown(1, x, y); await sleep(30); await fup(1);
    await sleep(300);
    gaps.push(`${name} ${await gap(t1, await now())} ms`);
  }
  const worst = Math.max(...gaps.map(g => parseInt(g.split(' ').at(-2))));
  check(worst < 50 && worst < idleGap + 25, 'a touch does not stall the game (longest frame gap around a 30 ms touch)',
        `${gaps.join(', ')}; ${idleGap} ms without a touch`);
  await D.still(page);
  const jq = await D.track(page, 1200, async () => { await tap('#t-jump', 30); });
  check(jq.rise > 10, 'a 30 ms tap on Jump still jumps', `rose ${D.fmt(jq.rise)} px`);
  await D.still(page);
  await tap('#t-pause', 30);
  check(await waitMode(0, 3000), 'a 30 ms tap on pause opens the game menu', `mode ${await uiMode()}`);
  await sleep(500);
  await tap('#t-ok', 30);
  check(await waitMode(1, 3000), 'a 30 ms tap on OK resumes', `mode ${await uiMode()}`);
  await sleep(500);
  await D.still(page);

  // ---- Auto-fire ----
  const base = [await bullets(true)];
  for (let i = 0; i < 8; i++) { base.push(await bullets()); await sleep(60); }
  const baseline = Math.max(...base);
  await page.evaluate(() => { window.__log = []; });
  await tap('#t-auto');
  const storedOn = await page.evaluate(() => localStorage.getItem('bb-autofire'));
  const samples = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 3000) { samples.push(await bullets()); await sleep(60); }
  const fireLog = await page.evaluate(() => window.__log.filter(l => l.endsWith('KeyX')));
  const firing = samples.filter(n => n > baseline + 25).length;
  check(fireLog.join() === 'keydown KeyX' && storedOn === '1' &&
        await page.$eval('#t-auto', e => e.getAttribute('aria-checked')) === 'true',
        'auto-fire on: Fire held down for the whole time (one keydown, no keyup), setting saved', fireLog.join(' | '));
  check(firing >= samples.length * 0.8, 'auto-fire on: bullets keep coming for 3 s',
        `${firing}/${samples.length} frames with bullets (orange px above ${baseline + 25}); max ${Math.max(...samples)}`);
  // Pause with auto-fire on: the menu controls, Fire let go.
  await tap('#t-pause');
  check(await waitMode(0, 5000) && await touchMode() === 'menu' && await visible('#t-ok') && !await visible('#t-fire'),
        'pause opens the game menu, with the menu controls');
  await sleep(300);
  check(await held() === '', 'nothing held in the pause menu (auto-fire let go)', await held());
  await tap('#t-ok');
  check(await waitMode(1, 5000), 'OK on RESUME goes back to the level');
  await sleep(300);
  check(await held() === 'KeyX', 'back in the level, auto-fire holds Fire again', await held());
  await tap('#t-auto');
  await sleep(200);
  check(await held() === '' && await page.evaluate(() => localStorage.getItem('bb-autofire')) === '0',
        'auto-fire off: Fire let go, setting saved');
  await sleep(1500);
  const after = [];
  for (let i = 0; i < 8; i++) { after.push(await bullets()); await sleep(60); }
  check(Math.max(...after) <= baseline + 25, 'auto-fire off: the bullets stop', `max ${Math.max(...after)} orange px`);

  // ---- Chaos ----
  const fb = await box('#t-fire');
  // Hold Fire and drag another finger down the right side (the margin
  // beside the picture on a phone), then touch the picture: nothing may
  // scroll, and the game keeps getting every touch.
  await fdown(2, fb.cx, fb.cy);
  const mx = W - 30, my = H * 0.4;
  await fdown(1, mx, my);
  for (let i = 1; i <= 8; i++) { await fmove(1, mx, my + i * 12); await sleep(16); }
  await fup(1);
  const pc = await box('#view:not([hidden]), #canvas');
  await fdown(3, pc.cx, pc.cy);
  await sleep(100);
  await fup(3);
  await fup(2);
  await sleep(200);
  const scrolled = await page.evaluate(() => [scrollX, scrollY, document.scrollingElement.scrollTop, visualViewport ? visualViewport.scale : 1]);
  check(await held() === '' && scrolled.join() === '0,0,0,1',
        'a drag beside the picture while holding Fire neither scrolls nor zooms the page, and lets go',
        `scroll/zoom ${scrolled.join()}, held ${await held() || 'nothing'}`);
  const jb = await box('#t-jump');
  // Stick + Fire + Jump together; the stick finger slides over Fire, the
  // Fire finger slides off its button; then the touches are cancelled.
  await fdown(1, sx, sy);
  await fmove(1, sx + R * 0.7, sy);
  await fdown(2, fb.cx, fb.cy);
  await fdown(3, jb.cx, jb.cy);
  const three = await held();
  await fmove(1, fb.cx, fb.cy - 10);
  await fmove(2, fb.cx - 300, fb.cy - 120);
  const slid = await held();
  await fcancel();
  await sleep(100);
  const c1 = await held();
  check(three === 'ArrowRight,KeyX,Space' && slid === 'ArrowRight,Space' && c1 === '',
        'three fingers, slides off, then touchcancel: everything released',
        `held ${three} | after slides ${slid} | after cancel ${c1 || 'nothing'}`);
  // Window blur while holding.
  await fdown(1, sx, sy);
  await fmove(1, sx - R * 0.7, sy);
  await fdown(2, jb.cx, jb.cy);
  await page.evaluate(() => window.dispatchEvent(new FocusEvent('blur')));
  const c2 = await held();
  await fup(2); await fup(1);
  await page.evaluate(() => window.dispatchEvent(new FocusEvent('focus')));
  check(c2 === '', 'window blur releases everything held', c2 || 'nothing');
  // Page hidden while holding.
  await fdown(1, sx, sy);
  await fmove(1, sx + R * 0.7, sy);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const c3 = await held();
  await page.evaluate(() => {
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await fup(1);
  check(c3 === '', 'a hidden page releases everything held', c3 || 'nothing');
  // Random multi-touch over the lower part of the screen (where the stick
  // and buttons are), then every finger lifts.
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 120; i++) {
    const id = 1 + Math.floor(rnd() * 3);
    const x = rnd() * W, y = H * 0.5 + rnd() * H * 0.5;
    if (!fingers.has(id)) await fdown(id, x, y);
    else if (rnd() < 0.25) await fup(id);
    else await fmove(id, x, y);
    await sleep(10);
  }
  for (const id of [...fingers.keys()]) await fup(id);
  await sleep(200);
  const c4 = await held();
  check(c4 === '' && await uiMode() === 1, 'after 120 random multi-touch events and lifting: nothing held, still in the level',
        `${c4 || 'nothing'} held, mode ${await uiMode()}`);
  const drift = await D.still(page);
  check(Math.abs(drift) < 10, 'after the chaos Blip stands still', `drift ${D.fmt(drift)} px`);
  // And the stick still works.
  await fdown(1, sx, sy);
  await fmove(1, sx + R * 0.8, sy);
  const t = await D.track(page, 1000);
  await fup(1);
  check(t.moved > 30, 'after the chaos the stick still walks Blip', `moved ${D.fmt(t.moved)} px`);
  check(await held() === '', 'and lets go');

  // ---- Auto-fire setting survives a reload ----
  await tap('#t-auto');
  await sleep(200);
  const page2 = await context.newPage();
  await page2.addInitScript(() => { window.bbHooks = { bbEnv: { BB_NO_PERSIST: 1 } }; });
  await page2.goto(url);
  await page2.waitForFunction(() => !document.getElementById('touch').hidden, null, { timeout: 60000 });
  await sleep(300);
  check(await page2.$eval('#t-auto', e => e.getAttribute('aria-checked')) === 'true',
        'auto-fire stays on after a reload (remembered on this device)');
  await page2.evaluate(() => localStorage.removeItem('bb-autofire'));
  await page2.close();
} catch (e) {
  check(false, e instanceof StepError ? e.message : e.stack);
}
check(errors.length === 0 && interventions.length === 0,
      'no page errors, and no touch event the browser refused to cancel (no scrolling or zooming)',
      errors.concat(interventions).slice(0, 3).join(' | '));
await page.close();

// Opens another game page in a fresh profile on the same phone, with
// harness settings, and makes it the page the helpers act on.
async function scenarioPage(env, routes = [], extra = []) {
  const ctx = await D.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: DPR,
                                   isMobile: true, hasTouch: true });
  for (const [re, body] of routes) await ctx.route(re, r => r.fulfill({ status: 200, body }));
  const setEnv = `window.bbHooks.bbEnv = Object.assign(window.bbHooks.bbEnv, ${JSON.stringify(env)});`;
  const r = await D.newGamePage({ context: ctx, initScripts: [keyLog, frameTimes, setEnv, ...extra] });
  page = r.page;
  errors = r.errors;
  interventions = [];
  watchConsole(page);
  cdp = await ctx.newCDPSession(page);
  fingers.clear();
  await page.waitForFunction(() => !document.getElementById('touch').hidden, null, { timeout: 30000 });
  return ctx;
}
// From the intro to the level (BB_START_LEVEL picks it), by taps: Skip,
// OK (START GAME), OK (1 player), OK (Blip), then Skip at the briefing.
async function briefingToLevel() {
  await tapUntil(() => tap('#t-skip'), 'the main menu', s => s.title);
  await sleep(500);
  const h0 = (await state(page)).hash;
  await tapUntil(() => tap('#t-ok'), 'the START GAME menu', s => s.title && s.hash !== h0);
  await tapUntil(() => tap('#t-ok'), 'character select', s => s.charsel);
  let last = null;
  await waitState(page, s => {
    const ok = s.charsel && s.blue && last && Math.abs(s.blue.x - last.x) < 1 && s.frame > last.frame;
    if (s.blue) last = { x: s.blue.x, frame: s.frame };
    return ok;
  }, 5000);
  await tapUntil(() => tap('#t-ok'), 'the briefing', s => !s.charsel);
  if (!await waitMode(3, 60000)) throw new StepError(`no briefing; mode ${await uiMode()}`);
  await sleep(200);
  // (The level only counts the press once it has loaded: press again.)
  for (let i = 0; i < 10 && await uiMode() !== 1; i++) { await tap('#t-skip'); await waitMode(1, 1500); }
  if (await uiMode() !== 1) throw new StepError(`Skip at the briefing never started the level; mode ${await uiMode()}`);
  await sleep(2500);  // Blip drops in
}

// ---- The game's default keys: Jump is SDLK_MENU, which no browser key
// event produces; the page hands it to the game as an SDL key event. ----
if (!only || only === 'defaults') try {
  const ctx = await scenarioPage({ BB_DEFAULT_CONFIG: 1, BB_START_LEVEL: 1 });
  const codes = await page.evaluate(() => Module.UTF8ToString(Module._bb_key_codes()).split(',').map(Number));
  check(codes[5] === 0x40000076, 'BB_DEFAULT_CONFIG: player 1 Jump is SDLK_MENU', '0x' + codes[5].toString(16));
  await briefingToLevel();
  await D.still(page);
  const jb = await box('#t-jump');
  await page.evaluate(() => { window.__log = []; });
  const j = await D.track(page, 1200, async () => { await fdown(1, jb.cx, jb.cy); await sleep(400); await fup(1); });
  const dom = await page.evaluate(() => window.__log.join(' '));
  check(j.rise > 20, 'default keys: holding Jump (SDLK_MENU) makes Blip jump', `rose ${D.fmt(j.rise)} px; DOM key events: ${dom || 'none'}`);
  // Fire is Left Ctrl, a DOM key; the stick sends the arrows.
  const zone = await box('#stick-zone');
  const R = await page.evaluate(() => document.getElementById('stick').getBoundingClientRect().width / 2);
  await fdown(1, zone.x + zone.w / 2, zone.y + zone.h * 0.6);
  await fmove(1, zone.x + zone.w / 2 + R * 0.8, zone.y + zone.h * 0.6);
  const fbx = await box('#t-fire');
  await fdown(2, fbx.cx, fbx.cy);
  const both = await held();
  const t = await D.track(page, 1000);
  await fup(2); await fup(1);
  await sleep(200);
  check(both === 'ArrowRight,ControlLeft' && t.moved > 30 && await held() === '',
        'default keys: stick right and Fire send ArrowRight and Left Ctrl, Blip walks, all released',
        `held ${both}, moved ${D.fmt(t.moved)} px`);
  check(errors.length === 0 && interventions.length === 0, 'default keys: no page errors', errors.concat(interventions).slice(0, 3).join(' | '));
  await Promise.race([ctx.close(), sleep(5000)]);
} catch (e) {
  check(false, 'default keys: ' + (e instanceof StepError ? e.message : e.stack));
}

// The window losing focus, or the page being hidden, for a moment.
const blurFor = async ms => {
  await page.evaluate(() => window.dispatchEvent(new FocusEvent('blur')));
  await sleep(ms);
  await page.evaluate(() => window.dispatchEvent(new FocusEvent('focus')));
};
const hideFor = async ms => {
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await sleep(ms);
  await page.evaluate(() => {
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
};

// ---- Typing a hi-score name by touch ----
// Every score in the table is -1, so any score gets in. One life in level
// 2, walking right into the enemies until Blip dies, then game over, then
// the name: typed on the soft keyboard (the hidden text field), with a
// mistake deleted, then OK.
function scoreTable(entries) {
  const buf = Buffer.alloc(244);
  let sum = 0;
  entries.forEach(([score, name], i) => {
    const key = (0x35674a1f << i) | 0;
    const bytes = Buffer.alloc(20);
    bytes.write(name, 'latin1');
    sum = (sum + score) | 0;
    for (const b of bytes) sum = (sum + b) | 0;
    buf.writeInt32LE((score ^ key) | 0, i * 24);
    for (let j = 0; j < 20; j += 4) buf.writeInt32LE((bytes.readInt32LE(j) ^ key) | 0, i * 24 + 4 + j);
  });
  buf.writeInt32LE(sum, 240);
  return buf;
}
function readNames(bytes) {
  const buf = Buffer.from(bytes), names = [];
  for (let i = 0; i < 10; i++) {
    const key = (0x35674a1f << i) | 0, nb = Buffer.alloc(20);
    for (let j = 0; j < 20; j += 4) nb.writeInt32LE((buf.readInt32LE(i * 24 + 4 + j) ^ key) | 0, j);
    names.push([(buf.readInt32LE(i * 24) ^ key) | 0, nb.toString('latin1').replace(/\0.*$/s, '')]);
  }
  return names;
}
if (!only || only === 'name') try {
  const table = scoreTable(Array.from({ length: 10 }, () => [-1, 'NOBODY']));
  const ctx = await scenarioPage({ BB_START_LEVEL: 2, BB_LIVES: 1 }, [[/\/data\/bb\.scr/, table]], [fakeKeyboard]);
  await briefingToLevel();
  const zone = await box('#stick-zone');
  const R = await page.evaluate(() => document.getElementById('stick').getBoundingClientRect().width / 2);
  await fdown(1, zone.x + zone.w / 2, zone.y + zone.h * 0.6);
  await fmove(1, zone.x + zone.w / 2 + R * 0.8, zone.y + zone.h * 0.6);
  let dead = false;
  for (let i = 0; i < 18 && !dead; i++) {
    // The level is over once the game shows anything else: game over, or
    // straight the name entry (the held stick skips the game over screen).
    const end = Date.now() + 10000;
    while (!dead && Date.now() < end) { dead = await uiMode() !== 1; if (!dead) await sleep(100); }
    if (out) await shot(`dying-${i}`);
    // Jump now and then, in case something blocks the way.
    if (!dead && i % 2 === 1 && await uiMode() === 1) {
      const jb = await box('#t-jump');
      await fdown(2, jb.cx, jb.cy); await sleep(300); await fup(2);
    }
  }
  await fup(1);
  check(dead, 'one life, walking into the enemies: Blip dies and the level ends');
  const pic = await box('#view:not([hidden]), #canvas');
  for (let i = 0; i < 12 && await uiMode() !== 4; i++) { await tapAt(pic.cx, pic.cy); await waitMode(4, 1000); }
  // The first letters are typed straight away (the page focuses the text
  // field when the entry starts), while the name prompt still slides in,
  // before the game reads keys: they wait for it.
  const earlyReady = await page.evaluate(() => Module._bb_ui_text_ready());
  for (const c of 'To') { await page.keyboard.insertText(c); await sleep(80); }
  await tap('#t-kbd');
  await sleep(200);
  check(await uiMode() === 4 && await touchMode() === 'text' && await visible('#t-kbd') && await visible('#t-ok'),
        'game over, then the hi-score name entry shows the keyboard button and OK', `mode ${await uiMode()}`);
  check(await page.evaluate(() => document.activeElement && document.activeElement.id === 't-text'),
        'the keyboard button focuses the text field (which brings up the soft keyboard)');
  await sleep(1000);
  // The soft keyboard covering the lower 55% of the screen: the picture
  // moves up so the name's row (260 of 480) shows, and OK sits above it.
  const kbH = Math.round(H * 0.55);
  await page.evaluate(kb => { window.__kb = kb; visualViewport.dispatchEvent(new Event('resize')); }, kbH);
  await sleep(300);
  const kbPic = await box('#view:not([hidden]), #canvas'), kbOk = await box('#t-ok'), kbKbd = await box('#t-kbd');
  const rowY = kbPic.y + kbPic.h * 260 / 480;
  if (out) await shot('name-keyboard');
  check(rowY > 4 && rowY < H - kbH - 4 && kbOk.y >= 0 && kbOk.y + kbOk.h <= H - kbH && kbKbd.y + kbKbd.h <= H - kbH,
        'with the soft keyboard up, the name row and OK stay in view above it',
        `keyboard from y ${H - kbH}; name row at ${Math.round(rowY)}, OK ${Math.round(kbOk.y)}-${Math.round(kbOk.y + kbOk.h)}`);
  await page.evaluate(() => { window.__kb = 0; visualViewport.dispatchEvent(new Event('resize')); });
  await sleep(300);
  await tap('#t-kbd');
  // Typed at a normal speed (about 6 keys a second), mixing the two kinds
  // of soft keyboard: one that only reports text (Android: input events,
  // no key codes) and one that sends real key codes with keydown and keyup
  // almost together (iOS), and keyboards that type through composition
  // (Gboard, Samsung: a letter, or a word shown and changed, then
  // committed; CDP Input.imeSetComposition / insertText). A mistake is
  // deleted with Backspace, and OK is
  // tapped right after the last key, before the game has caught up: the
  // whole name still goes in, then Return. Letters typed after OK are
  // ignored and nothing reaches the menus that follow.
  const t0 = Date.now();
  // One letter composed, then committed.
  await cdp.send('Input.imeSetComposition', { text: 'u', selectionStart: 1, selectionEnd: 1 });
  await sleep(60);
  await cdp.send('Input.insertText', { text: 'u' });
  await sleep(100);
  for (const c of 'CH') { await page.keyboard.press('Key' + c); await sleep(150); }
  // The window loses focus for a moment mid-name (a notification).
  await blurFor(300);
  await page.keyboard.insertText(' ');
  await sleep(150);
  // A "word" composed letter by letter, then committed.
  for (const w of ['1', '1x']) {
    await cdp.send('Input.imeSetComposition', { text: w, selectionStart: w.length, selectionEnd: w.length });
    await sleep(150);
  }
  await cdp.send('Input.insertText', { text: '1x' });
  await sleep(150);
  await page.keyboard.press('Backspace');
  const typedMs = Date.now() - t0;
  await shot('name-entry');
  await page.evaluate(() => { window.__log = []; });
  await tap('#t-ok');
  await page.keyboard.insertText('zz');
  check(await waitMode(0, 10000), 'OK ends the name entry');
  await sleep(3000);
  // (Keys after OK's Return: none at all.)
  const leaked = await page.evaluate(() => {
    const i = window.__log.indexOf('keydown Enter');
    return i < 0 ? ['no Return'] : window.__log.slice(i + 1).filter(l => l.startsWith('keydown'));
  });
  check(leaked.length === 0, 'no key reaches the game after OK\'s Return (letters typed after OK are ignored)', leaked.slice(0, 5).join(' ') || 'none');
  const names = readNames(await page.evaluate(() => Array.from(Module.FS.readFile('/data/bb.scr'))));
  const entry = names.find(([, n]) => n !== 'NOBODY');
  check(entry && entry[1] === 'TOUCH 1',
        'the whole name typed at normal speed (text-only, composing and key-code keyboards, Backspace; the first letters while the prompt slid in; a blur midway), OK right after: saved',
        (entry ? `"${entry[1]}" with ${entry[0]} points` : 'no new entry') + `; typed in ${typedMs} ms; game reading keys when "To" was typed: ${earlyReady ? 'already' : 'not yet'}`);
  check(errors.length === 0 && interventions.length === 0, 'name entry: no page errors', errors.concat(interventions).slice(0, 3).join(' | '));
  await Promise.race([ctx.close(), sleep(5000)]);
} catch (e) {
  check(false, 'name entry: ' + (e instanceof StepError ? e.message : e.stack));
}
// ---- Two players: both names, back to back ----
// Player 2 (keyboard: 'f' walks right, Tab jumps) and player 1 (the stick)
// walk into the enemies with one life each; both get a hi-score. The game
// asks for the two names one right after the other, faster than the page
// polls what it shows. Player 2's 'f' is still held down when the first
// name entry starts and let go during it: the game waits for every key to
// be up, so that release must reach it.
if (!only || only === 'twop') try {
  const table = scoreTable(Array.from({ length: 10 }, () => [-1, 'NOBODY']));
  const ctx = await scenarioPage({ BB_START_LEVEL: 2, BB_LIVES: 1 }, [[/\/data\/bb\.scr/, table]]);
  await tapUntil(() => tap('#t-skip'), 'the main menu', s => s.title);
  await sleep(500);
  const h0 = (await state(page)).hash;
  await tapUntil(() => tap('#t-ok'), 'the START GAME menu', s => s.title && s.hash !== h0);
  const h1 = (await state(page)).hash;
  await tapUntil(() => tap('#t-down'), '2 PLAYERS', s => s.title && s.hash !== h1);
  await tapUntil(() => tap('#t-ok'), 'character select', s => s.charsel);
  // Character select: OK while it shows (once the characters have
  // settled), and no more taps once the briefing loads.
  for (let i = 0; i < 40 && await uiMode() !== 3; i++) {
    let last = null;
    await waitState(page, st => {
      const ok = !st.charsel || (st.blue && last && Math.abs(st.blue.x - last.x) < 1 && st.frame > last.frame);
      if (st.blue) last = { x: st.blue.x, frame: st.frame };
      return ok;
    }, 5000);
    if ((await state(page)).charsel) { await tap('#t-ok'); await sleep(1500); } else await sleep(500);
  }
  if (!await waitMode(3, 60000)) { await shot('twop-no-briefing'); throw new StepError(`no briefing; mode ${await uiMode()}; the game shows ${describe(await state(page))}`); }
  for (let i = 0; i < 10 && await uiMode() !== 1; i++) { await tap('#t-skip'); await waitMode(1, 1500); }
  if (await uiMode() !== 1) throw new StepError(`no level; mode ${await uiMode()}`);
  await sleep(2500);
  const zone = await box('#stick-zone');
  const R = await page.evaluate(() => document.getElementById('stick').getBoundingClientRect().width / 2);
  await fdown(1, zone.x + zone.w / 2, zone.y + zone.h * 0.6);
  await fmove(1, zone.x + zone.w / 2 + R * 0.8, zone.y + zone.h * 0.6);
  await page.keyboard.down('f');
  const end = Date.now() + 200000;
  for (let i = 1; Date.now() < end && await uiMode() === 1; i++) {
    await sleep(1000);
    if (i % 3 === 0) {
      const jb = await box('#t-jump');
      await fdown(2, jb.cx, jb.cy); await sleep(300); await fup(2);
      await page.keyboard.down('Tab'); await sleep(300); await page.keyboard.up('Tab');
    }
  }
  await fup(1);
  const pc = await box('#view:not([hidden]), #canvas');
  for (let i = 0; i < 15 && await uiMode() !== 4; i++) { await tapAt(pc.cx, pc.cy); await waitMode(4, 1000); }
  const seq1 = await page.evaluate(() => Module._bb_ui_text_seq());
  check(await uiMode() === 4, '2 players: both die, the first name entry starts with player 2\'s key still held', `mode ${await uiMode()}`);
  await sleep(1000);
  await page.keyboard.up('f');  // let go during the entry
  await tap('#t-kbd');
  // The window loses focus right as the second letter goes to the game
  // (SDL then lets go of every key, maybe before the game saw it).
  await page.evaluate(() => {
    let n = 0;
    window.addEventListener('keydown', e => {
      if (!e.isTrusted && /^Key/.test(e.code) && ++n === 2) setTimeout(() => {
        window.dispatchEvent(new FocusEvent('blur'));
        setTimeout(() => window.dispatchEvent(new FocusEvent('focus')), 300);
      }, 1);
    }, true);
  });
  for (const c of 'One') { await page.keyboard.insertText(c); await sleep(150); }
  await tap('#t-ok');
  // The window loses focus while the name and its Return are still going out.
  await sleep(150);
  await blurFor(300);
  // The second entry: as soon as the game starts it.
  const t0 = Date.now();
  while (Date.now() - t0 < 10000 && await page.evaluate(() => Module._bb_ui_text_seq()) === seq1) await sleep(20);
  const second = await page.evaluate(() => Module._bb_ui_text_seq()) === seq1 + 1;
  await tap('#t-kbd');
  for (const c of 'Two') { await page.keyboard.insertText(c); await sleep(150); }
  await tap('#t-ok');
  // The page is hidden for a moment while the name still goes out.
  await sleep(150);
  await hideFor(500);
  const left = await waitMode(0, 10000);
  await sleep(2000);
  const saved = readNames(await page.evaluate(() => Array.from(Module.FS.readFile('/data/bb.scr')))).filter(([, n]) => n !== 'NOBODY').map(([, n]) => n).sort();
  check(second && left && saved.join() === 'ONE,TWO',
        '2 players: a key held into the first name entry lets go; both names typed by touch, back to back, are saved (a blur as a letter goes out and after the first OK, a hidden page after the second)',
        `second entry ${second ? 'started' : 'never started'}, ${left ? 'left' : 'still in'} name entry, saved ${JSON.stringify(saved)}`);
  check(errors.length === 0 && interventions.length === 0, '2 players: no page errors', errors.concat(interventions).slice(0, 3).join(' | '));
  await Promise.race([ctx.close(), sleep(5000)]);
} catch (e) {
  check(false, '2 players: ' + (e instanceof StepError ? e.message : e.stack));
}
await D.finish();
