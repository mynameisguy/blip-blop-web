// Shared helpers for the browser tests (input_test.mjs, saves_test.mjs):
// they start the game in Playwright, read its state from every frame and
// drive it with real key presses, waiting on the game instead of the clock.
import { chromium } from 'playwright';
import fs from 'node:fs';

export const sleep = ms => new Promise(r => setTimeout(r, ms));

// Set by setup(): the browser, the game's URL and where to save screenshots.
const driver = { browser: null, url: null, outDir: null };

export async function setup(url, outDir) {
  if (outDir) fs.mkdirSync(outDir, { recursive: true });
  driver.url = url;
  driver.outDir = outDir;
  driver.browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
}

let failures = 0;
export function check(ok, what, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${detail ? ' - ' + detail : ''}`);
  if (!ok) failures++;
}

export async function finish() {
  await Promise.race([driver.browser.close(), sleep(5000)]);
  console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
  process.exit(failures ? 1 : 0);
}

export async function screenshot(page, name) {
  const png = await page.locator('canvas').screenshot();
  if (driver.outDir && name) fs.writeFileSync(`${driver.outDir}/${name}.png`, png);
  return png;
}

// Every frame goes through Module.onFrame (game/harness.cpp). The page keeps
// a summary of the latest frame in window.bbState, and hands the next frame's
// pixels (RGBA, 640x480) to window.bbGrab when one is requested.
function hooks({ persist }) {
  window.bbFrames = 0;
  window.bbSaves = 0;
  window.bbGrab = null;
  window.bbState = null;
  function summarize(px, pitch) {
    const at = (x, y) => y * pitch + x * 4;
    // Mean colour of a 32x32 block.
    const block = (x0, y0) => {
      const s = [0, 0, 0];
      for (let y = y0; y < y0 + 32; y++) {
        for (let x = x0; x < x0 + 32; x++) {
          const i = at(x, y);
          s[0] += px[i]; s[1] += px[i + 1]; s[2] += px[i + 2];
        }
      }
      return s.map(v => Math.round(v / 1024));
    };
    // The title screen behind every menu: two logo blocks and one by the gun.
    const ref = [[170, 8, [85, 46, 73]], [410, 8, [13, 7, 11]], [560, 300, [45, 36, 34]]];
    const title = ref.every(([x, y, c]) => block(x, y).every((v, k) => Math.abs(v - c[k]) <= 4));
    // Hash of the menu text area, which only changes when the menu does.
    let hash = 2166136261;
    for (let y = 60; y < 420; y += 2) {
      for (let x = 140; x < 500; x += 2) {
        const i = at(x, y);
        hash = Math.imul(hash ^ (px[i] | (px[i + 1] << 8) | (px[i + 2] << 16)), 16777619);
      }
    }
    // Character select: white title text on black at the top.
    let white = 0, dark = 0;
    for (let y = 6; y < 46; y += 2) {
      for (let x = 0; x < 640; x += 2) {
        const i = at(x, y), r = px[i], g = px[i + 1], b = px[i + 2];
        if (r > 200 && g > 200 && b > 200) white++;
        else if (r + g + b < 90) dark++;
      }
    }
    // Blip's saturated blue (sampled every other pixel).
    let n = 0, sx = 0, sy = 0;
    for (let y = 80; y < 480; y += 2) {
      for (let x = 0; x < 640; x += 2) {
        const i = at(x, y), r = px[i], g = px[i + 1], b = px[i + 2];
        if (b > 150 && b > r + 100 && b > g + 70) { n++; sx += x; sy += y; }
      }
    }
    const charsel = !title && white > 200 && dark > 3000;
    const blue = n ? { n, x: sx / n, y: sy / n } : null;
    const level = !title && !charsel && !!blue && n < 600 && blue.y > 300;
    return { title, hash, charsel, level, blue };
  }
  window.bbHooks = {
    bbEnv: persist ? {} : { BB_NO_PERSIST: 1 },
    onSaved() { window.bbSaves = (window.bbSaves || 0) + 1; },
    onFrame(n, bytes, pitch) {
      window.bbFrames++;
      window.bbState = Object.assign(summarize(bytes, pitch), { frame: window.bbFrames, time: Date.now() });
      if (window.bbGrab) {
        const g = window.bbGrab;
        window.bbGrab = null;
        g({ pixels: bytes.slice(), pitch });
      }
    },
  };
}

// Opens the game in a new browser profile (or the given context) and waits
// until it runs. Saves stay off unless persist is set.
export async function newGamePage({ initScripts = [], persist = false, context } = {}) {
  context = context || await driver.browser.newContext({ viewport: { width: 800, height: 600 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => {
    // A missing favicon is reported as a console error; failed game
    // requests are caught below with their URL.
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text());
  });
  page.on('response', r => {
    if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) errors.push(`${r.status()} ${r.url()}`);
  });
  await page.addInitScript(hooks, { persist });
  for (const s of initScripts) await page.addInitScript(s);
  await page.goto(driver.url);
  await waitStarted(page, errors);
  return { context, page, errors };
}

// Waits until the game draws frames (after a load or reload).
export async function waitStarted(page, errors = []) {
  try {
    await page.waitForFunction(() => window.bbFrames > 20, null, { timeout: 60000 });
  } catch (e) {
    const info = await page.evaluate(() => ({ frames: window.bbFrames, status: document.getElementById('status')?.textContent }));
    throw new StepError(`the game did not start within 60 s: ${JSON.stringify(info)}; ${errors.join(' | ')}`);
  }
}

export const state = page => page.evaluate(() => window.bbState);

export function describe(s) {
  if (!s) return 'no frame yet';
  const what = s.title ? 'a menu' : s.charsel ? 'character select' : s.level ? 'a level' : 'another screen';
  return `${what} (frame ${s.frame}, ${Date.now() - s.time} ms ago)`;
}

// Polls the latest frame summary until pred holds; false on timeout.
export async function waitState(page, pred, timeout) {
  const end = Date.now() + timeout;
  for (;;) {
    const s = await state(page);
    if (s && pred(s)) return s;
    if (Date.now() > end) return false;
    await sleep(100);
  }
}

export class StepError extends Error {}

// Presses key until the game shows what pred describes, pressing again when
// the game missed the press (e.g. it arrived during loading or animation).
export async function pressUntil(page, key, goal, pred, { tries = 5, wait = 2000, ms = 150 } = {}) {
  for (let i = 0; i < tries; i++) {
    await hold(page, key, ms);
    if (await waitState(page, pred, wait)) return;
  }
  throw new StepError(`pressed ${key} ${tries} times but never reached ${goal}; the game shows ${describe(await state(page))}`);
}

// Menus are static, so a menu key took effect once the menu text changes.
export async function menuKey(page, key, what) {
  const s0 = await waitState(page, s => s.title, 5000);
  if (!s0) throw new StepError(`expected a menu before ${what}; the game shows ${describe(await state(page))}`);
  await pressUntil(page, key, what, s => s.title && s.hash !== s0.hash, { wait: 1500 });
  await sleep(100);
}

export async function hold(page, key, ms = 150) {
  await page.keyboard.down(key);
  await sleep(ms);
  await page.keyboard.up(key);
}

// Holds a key while sending auto-repeat keydowns, as a real keyboard does.
export async function holdRepeating(page, key, ms) {
  await page.keyboard.down(key);
  const end = Date.now() + ms;
  await sleep(Math.min(250, ms));
  while (Date.now() < end) {
    await page.keyboard.down(key); // repeat: true
    await sleep(33);
  }
  await page.keyboard.up(key);
}

// Skips the intro to the main menu.
export async function toMainMenu(page) {
  await pressUntil(page, 'Escape', 'the main menu', s => s.title);
}

// From the main menu with START GAME focused: starts a game with Blip as
// player 1 and waits until the level runs and the player has landed.
export async function startGame(page, players = 1) {
  await menuKey(page, 'Enter', 'START GAME');
  if (players === 2) await menuKey(page, 'ArrowDown', 'START 2 PLAYERS GAME');
  await pressUntil(page, 'Enter', 'character select', s => s.charsel);
  // Enter only counts once Blip has slid in: wait until he stops moving.
  let last = null;
  const settled = await waitState(page, s => {
    const ok = s.charsel && s.blue && last && Math.abs(s.blue.x - last.x) < 1 && s.frame > last.frame;
    if (s.blue) last = { x: s.blue.x, frame: s.frame };
    return ok;
  }, 5000);
  if (!settled) throw new StepError(`Blip never settled in character select; the game shows ${describe(await state(page))}`);
  await pressUntil(page, 'Enter', 'the mission briefing', s => !s.charsel);
  // "PRESS A KEY TO START" appears once the level has loaded; a press during
  // loading is dropped, so press until the level runs.
  await pressUntil(page, 'Enter', 'level 1', s => s.level && Date.now() - s.time < 300, { tries: 10, wait: 1500 });
  // Wait for the player to land: same position over half a second.
  let prev = null;
  await waitState(page, s => {
    const ok = prev && s.level && s.frame > prev.frame + 20 &&
      Math.abs(s.blue.x - prev.x) < 1 && Math.abs(s.blue.y - prev.y) < 1;
    if (!prev || s.frame > prev.frame + 20) prev = { x: s.blue?.x, y: s.blue?.y, frame: s.frame };
    return ok;
  }, 8000);
}

// Grabs the next frame and reduces it in the page:
//  - ground: mean brightness of each column over the playfield rows, used to
//    measure how far the level scrolled;
//  - player: centroid of Blip's saturated blue pixels;
//  - blop: centroid of Blop's salmon red pixels near the ground, away from
//    Blip (whose bandana is red too).
export async function grab(page, name) {
  const r = await page.evaluate(() => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no frame within 10 s')), 10000);
    window.bbGrab = ({ pixels, pitch }) => {
      clearTimeout(timer);
      const px = (x, y) => { const i = y * pitch + x * 4; return [pixels[i], pixels[i + 1], pixels[i + 2]]; };
      const ground = new Array(640).fill(0);
      let n = 0, sx = 0, sy = 0;
      for (let y = 0; y < 480; y++) {
        for (let x = 0; x < 640; x++) {
          const [r, g, b] = px(x, y);
          if (y >= 300 && y < 470) ground[x] += (r + g + b) / 3;
          // Blip's body; the HUD (y < 80) also has blue digits.
          if (y >= 80 && b > 150 && b > r + 100 && b > g + 70) { n++; sx += x; sy += y; }
        }
      }
      const blipX = n ? sx / n : -1000;
      let rn = 0, rx = 0;
      for (let y = 300; y < 480; y++) {
        for (let x = 0; x < 640; x++) {
          if (Math.abs(x - blipX) < 35) continue;
          const [r, g, b] = px(x, y);
          if (r > 190 && g >= 40 && g < 130 && b >= 30 && b < 120 && r - g > 90) { rn++; rx += x; }
        }
      }
      resolve({ ground: ground.map(v => v / 170), player: n ? { n, x: blipX, y: sy / n } : null,
                blop: rn ? { n: rn, x: rx / rn } : null });
    };
  }));
  if (driver.outDir && name) await screenshot(page, name);
  return r;
}

// Horizontal scroll from frame a to frame b, in pixels (positive: the view
// moved right, so the scenery moved left on screen).
export function scroll(a, b) {
  let best = 0, bestErr = Infinity;
  for (let s = -160; s <= 160; s++) {
    let err = 0, n = 0;
    for (let x = 160; x < 480; x++) { err += Math.abs(a.ground[x] - b.ground[x - s]); n++; }
    err /= n;
    if (err < bestErr) { bestErr = err; best = s; }
  }
  return best;
}

// How far the player walked from a to b: the view follows once the player
// passes the middle of the screen, so count the scroll and the move on screen.
export const walked = (a, b) => scroll(a, b) + (a.player && b.player ? b.player.x - a.player.x : NaN);
export const fmt = v => (Number.isFinite(v) ? v.toFixed(1) : String(v));

// Sends a window blur, as when the player switches tab or window, then
// gives focus back.
export async function blurWindow(page) {
  await page.evaluate(() => window.dispatchEvent(new FocusEvent('blur')));
  await sleep(100);
  await page.evaluate(() => window.dispatchEvent(new FocusEvent('focus')));
}

// Binds the focused keys-menu entry: Enter, then the given input, then waits
// until data/bb.cfg holds the expected code at the entry's offset.
export async function cfgAlias(page, offset) {
  return page.evaluate(o => {
    const d = Module.FS.readFile('/data/bb.cfg');
    return new DataView(d.buffer, d.byteOffset, d.length).getUint32(o, true);
  }, offset);
}
export async function bind(page, offset, press, expected, what) {
  await menuKey(page, 'Enter', `editing ${what}`);
  for (let i = 0; i < 4; i++) {
    await press();
    const end = Date.now() + 1500;
    while (Date.now() < end) {
      if (await cfgAlias(page, offset) === expected) return expected;
      await sleep(100);
    }
  }
  return cfgAlias(page, offset);
}
// data/bb.cfg: vsync, fullscreen (1 byte each), language (int), then the
// keys as ints: P1 UP, DOWN, LEFT, RIGHT, FIRE, JUMP, SPECIAL, then P2.
export const P1_UP = 6, P1_RIGHT = 18;

// Main menu -> OPTIONS -> PLAYER 1 CONTROL, with UP focused.
export async function toKeysMenu(page) {
  await menuKey(page, 'ArrowDown', 'OPTIONS');
  await menuKey(page, 'Enter', 'the options menu');
  await menuKey(page, 'ArrowDown', 'TOGGLE FULLSCREEN');
  await menuKey(page, 'ArrowDown', 'PLAYER 1 CONTROL');
  await menuKey(page, 'Enter', 'the P1 keys menu');
}
// Keys menu with entry `from` focused -> RETURN -> main menu (OPTIONS
// focused) -> START GAME focused.
export async function keysMenuToStart(page, from) {
  for (let i = from; i < 7; i++) await menuKey(page, 'ArrowDown', 'RETURN');
  await menuKey(page, 'Enter', 'the main menu');
  await menuKey(page, 'ArrowUp', 'START GAME');
}

const only = process.env.ONLY;
export async function scenario(name, fn) {
  if (only && !only.split(',').includes(name)) return;
  try {
    await fn();
  } catch (e) {
    check(false, `${name}: ${e instanceof StepError ? e.message : e.stack}`);
  }
}
