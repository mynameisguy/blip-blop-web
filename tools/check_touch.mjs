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
//   - no control covers the HUD, lying down or upright.
// Screenshots of a menu and a level, lying down and upright, go to outdir.
//
//   node tools/check_touch.mjs <url> [outdir] [--device WxH@R]
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
const { page, errors } = await D.newGamePage({ context, initScripts: [keyLog] });
const cdp = await context.newCDPSession(page);
const shot = async name => { if (out) await page.screenshot({ path: `${out}/${name}.png` }); };

// ---- Touch helpers (CDP touch events, several fingers) ----
const fingers = new Map();
async function sendTouches(type) {
  const touchPoints = [...fingers].map(([id, [x, y]]) => ({ x, y, id, radiusX: 6, radiusY: 6 }));
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : touchPoints });
}
async function fdown(id, x, y) { fingers.set(id, [x, y]); await sendTouches('touchStart'); }
async function fmove(id, x, y) { fingers.set(id, [x, y]); await sendTouches('touchMove'); }
async function fup(id) {
  fingers.delete(id);
  await sendTouches(fingers.size ? 'touchMove' : 'touchEnd');
}
async function fcancel() { fingers.clear(); await sendTouches('touchCancel'); }
async function box(sel) {
  return page.$eval(sel, e => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, cx: b.x + b.width / 2, cy: b.y + b.height / 2 }; });
}
async function tapAt(x, y, ms = 150) { await fdown(1, x, y); await sleep(ms); await fup(1); await sleep(100); }
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

try {
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
  await fmove(1, sx + R * 3, sy);
  const far = await held();
  await fmove(1, sx + R * 1.5, sy);
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
check(errors.length === 0, 'no page errors', errors.slice(0, 3).join(' | '));
await D.finish();
