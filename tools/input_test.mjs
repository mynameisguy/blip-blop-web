// Drives the browser build with real keyboard events (page.keyboard, not the
// harness input script) and checks that input behaves like the native game:
//   1. keyboard: through the menus into level 1, the player walks right
//      (the level scrolls), stops when the key is released (no stuck keys
//      after auto-repeat), walks left and jumps; the page does not act on
//      game keys (scrolling, Backspace, quick find).
//   2. player 2: in a two player game, the default P2 keys move Blop only.
//   3. gamepad: with a simulated Gamepad API pad, the keys menu binds a pad
//      button to "P1 UP", the same code native SDL gives (JOY1 BUTTON0);
//      an AZERTY key binds by its layout letter, as native SDL does.
//
//   node tools/input_test.mjs <url> [outDir]
// Exits 0 when every check passes. Needs playwright (CHROMIUM_PATH optional).
import { chromium } from 'playwright';
import fs from 'node:fs';

const [,, url = 'http://localhost:8000/', outDir] = process.argv;
if (outDir) fs.mkdirSync(outDir, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(ok, what, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${detail ? ' - ' + detail : ''}`);
  if (!ok) failures++;
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--autoplay-policy=no-user-gesture-required'],
});

// Every frame goes through Module.onFrame (game/harness.cpp). The page keeps
// a frame count and, on request, the next frame's pixels (RGBA, 640x480).
function hooks() {
  window.bbFrames = 0;
  window.bbGrab = null;
  window.bbHooks = {
    bbEnv: { BB_NO_PERSIST: 1 },
    onFrame(n, bytes, pitch, h) {
      window.bbFrames++;
      if (window.bbGrab) {
        const g = window.bbGrab;
        window.bbGrab = null;
        g({ pixels: bytes.slice(), pitch, h });
      }
    },
  };
}

async function newGamePage(initScripts = []) {
  const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
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
  await page.addInitScript(hooks);
  for (const s of initScripts) await page.addInitScript(s);
  await page.goto(url);
  await page.waitForFunction(() => window.bbFrames > 20, null, { timeout: 60000 });
  return { context, page, errors };
}

async function hold(page, key, ms = 150) {
  await page.keyboard.down(key);
  await sleep(ms);
  await page.keyboard.up(key);
}

// Holds a key while sending auto-repeat keydowns, as a real keyboard does.
async function holdRepeating(page, key, ms) {
  await page.keyboard.down(key);
  const end = Date.now() + ms;
  await sleep(Math.min(250, ms));
  while (Date.now() < end) {
    await page.keyboard.down(key); // repeat: true
    await sleep(33);
  }
  await page.keyboard.up(key);
}

// Grabs the next frame and reduces it in the page:
//  - ground: mean brightness of each column over the playfield rows, used to
//    measure how far the level scrolled;
//  - player: centroid of Blip's saturated blue pixels;
//  - blop: centroid of Blop's salmon red pixels near the ground, away from
//    Blip (whose bandana is red too).
async function grab(page, name) {
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
  if (outDir && name) await page.locator('canvas').screenshot({ path: `${outDir}/${name}.png` });
  return r;
}

// Horizontal scroll from frame a to frame b, in pixels (positive: the view
// moved right, so the scenery moved left on screen).
function scroll(a, b) {
  let best = 0, bestErr = Infinity;
  for (let s = -160; s <= 160; s++) {
    let err = 0, n = 0;
    for (let x = 160; x < 480; x++) { err += Math.abs(a.ground[x] - b.ground[x - s]); n++; }
    err /= n;
    if (err < bestErr) { bestErr = err; best = s; }
  }
  return best;
}

// Skips the intro and starts a one player game with Blip, up to "press a key".
async function startGame(page) {
  await hold(page, 'Escape');           // skip the intro cinematic
  await sleep(1000);
  await hold(page, 'Enter');            // START GAME
  await sleep(600);
  await hold(page, 'Enter');            // START 1 PLAYER GAME
  await sleep(600);
  await hold(page, 'Enter');            // select BLIP
  await sleep(3000);                    // mission briefing, loading
  await hold(page, 'Enter');            // PRESS A KEY TO START
  await sleep(3000);
}

// --- 1. keyboard -----------------------------------------------------------
{
  const { context, page, errors } = await newGamePage();
  await startGame(page);

  const a = await grab(page, 'kb-1-start');
  await sleep(800);
  const a2 = await grab(page);
  check(scroll(a, a2) === 0, 'no movement without input', `scroll ${scroll(a, a2)}`);
  check(!!a2.player, 'player found on screen', JSON.stringify(a2.player));

  await holdRepeating(page, 'ArrowRight', 1500);
  const b = await grab(page, 'kb-2-after-right');
  // The view follows once the player passes the middle of the screen, so
  // count both the scroll and the player's move on screen.
  const sr = scroll(a2, b);
  const walked = sr + (b.player && a2.player ? b.player.x - a2.player.x : NaN);
  check(walked >= 60, 'holding Right (with auto-repeat) walks right',
    `scroll ${sr}px, player x ${a2.player?.x.toFixed(1)} -> ${b.player?.x.toFixed(1)}`);

  await sleep(800);
  const b2 = await grab(page);
  check(scroll(b, b2) === 0 && Math.abs(b2.player.x - b.player.x) < 3,
    'player stops when Right is released (no stuck key)',
    `scroll ${scroll(b, b2)}, player x ${b.player.x.toFixed(1)} -> ${b2.player.x.toFixed(1)}`);

  await hold(page, 'ArrowLeft', 500);
  await sleep(300);
  const c = await grab(page, 'kb-3-after-left');
  const dx = c.player && b2.player ? c.player.x - b2.player.x : NaN;
  check(dx <= -10, 'holding Left walks left', `player x ${b2.player?.x.toFixed(1)} -> ${c.player?.x.toFixed(1)}`);

  await sleep(500);
  const d0 = await grab(page);
  await page.keyboard.down('Space');    // P1 jump (data/bb.cfg)
  await sleep(250);
  const d1 = await grab(page, 'kb-4-jump');
  await page.keyboard.up('Space');
  const dy = d1.player && d0.player ? d1.player.y - d0.player.y : NaN;
  check(dy <= -10, 'Space jumps', `player y ${d0.player?.y.toFixed(1)} -> ${d1.player?.y.toFixed(1)}`);

  // The page must not act on game keys.
  await page.evaluate(() => {
    document.body.style.height = '3000px'; // make the page scrollable
    window.scrollTo(0, 0);
    window.bbPrevented = [];
    addEventListener('keydown', e => window.bbPrevented.push([e.key, e.defaultPrevented]));
  });
  for (const k of ['Space', 'ArrowDown', 'PageDown', 'End', 'Backspace', 'Tab', 'Quote', 'Slash', 'x', 'Alt']) {
    await hold(page, k, 60);
  }
  await sleep(300);
  const prevented = await page.evaluate(() => window.bbPrevented);
  const notPrevented = prevented.filter(p => !p[1]).map(p => p[0]);
  check(prevented.length >= 10 && notPrevented.length === 0, 'browser default prevented for game keys',
    notPrevented.length ? 'not prevented: ' + notPrevented.join(' ') : `${prevented.length} keys`);
  const scrollY = await page.evaluate(() => window.scrollY);
  check(scrollY === 0, 'page did not scroll', `scrollY ${scrollY}`);
  check(page.url() === url || page.url().startsWith(url), 'page did not navigate', page.url());

  check(errors.length === 0, 'no page errors without a gamepad', errors.join(' | '));
  await context.close();
}

// --- 2. player 2 default keys ----------------------------------------------
{
  const { context, page, errors } = await newGamePage();
  await hold(page, 'Escape');
  await sleep(1000);
  await hold(page, 'Enter');            // START GAME
  await sleep(600);
  await hold(page, 'ArrowDown');        // START 2 PLAYERS GAME
  await sleep(300);
  await hold(page, 'Enter');
  await sleep(600);
  await hold(page, 'Enter');            // player 1 is BLIP, so player 2 is Blop
  await sleep(3000);
  await hold(page, 'Enter');            // PRESS A KEY TO START
  await sleep(3000);

  const a = await grab(page, 'p2-1-start');
  check(!!a.player && !!a.blop, 'both players found on screen', JSON.stringify({ blip: a.player, blop: a.blop }));
  await hold(page, 'f', 800);           // P2 right (data/bb.cfg: Q S D F, Tab, G, H)
  await sleep(300);
  const b = await grab(page, 'p2-2-after-f');
  const blopDx = b.blop && a.blop ? b.blop.x - a.blop.x + scroll(a, b) : NaN;
  const blipDx = b.player && a.player ? b.player.x - a.player.x + scroll(a, b) : NaN;
  check(blopDx >= 30, 'F walks player 2 right', `Blop moved ${blopDx.toFixed(1)}px`);
  check(Math.abs(blipDx) < 5, 'F does not move player 1', `Blip moved ${blipDx.toFixed(1)}px`);
  await hold(page, 'd', 500);           // P2 left
  await sleep(300);
  const c = await grab(page, 'p2-3-after-d');
  const blopDx2 = c.blop && b.blop ? c.blop.x - b.blop.x + scroll(b, c) : NaN;
  check(blopDx2 <= -15, 'D walks player 2 left', `Blop moved ${blopDx2.toFixed(1)}px`);
  check(errors.length === 0, 'no page errors in a two player game', errors.join(' | '));
  await context.close();
}

// --- 3. gamepad ------------------------------------------------------------
{
  // A standard-mapping pad present before load, so SDL opens it at start
  // like a pad plugged in before launching the native game.
  const fakePad = () => {
    const pad = {
      id: 'Simulated pad (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard',
      timestamp: 1, axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
    };
    navigator.getGamepads = () => [pad, null, null, null];
    window.bbPad = pad;
    window.bbPadButton = (i, down) => {
      pad.buttons[i] = { pressed: down, touched: down, value: down ? 1 : 0 };
      pad.timestamp++;
    };
  };
  const { context, page, errors } = await newGamePage([fakePad]);
  await hold(page, 'Escape');
  await sleep(1000);
  await hold(page, 'ArrowDown');         // OPTIONS
  await sleep(300);
  await hold(page, 'Enter');
  await sleep(500);
  await hold(page, 'ArrowDown');         // FULLSCREEN
  await sleep(300);
  await hold(page, 'ArrowDown');         // P1 KEYS
  await sleep(300);
  await hold(page, 'Enter');
  await sleep(500);
  await hold(page, 'Enter');             // edit UP: "UP = ..."
  await sleep(500);
  await page.evaluate(() => window.bbPadButton(0, true));
  await sleep(200);
  await page.evaluate(() => window.bbPadButton(0, false));
  await sleep(500);
  if (outDir) await page.locator('canvas').screenshot({ path: `${outDir}/pad-keys-menu.png` });
  // The keys menu writes data/bb.cfg on every change (browser build).
  const alias = await page.evaluate(() => {
    const d = Module.FS.readFile('/data/bb.cfg');
    return new DataView(d.buffer, d.byteOffset).getUint32(6, true); // P1 UP
  });
  check(alias === (1 << 10) + 0, 'pad button binds as JOY1 BUTTON0 (native code 0x400)', '0x' + alias.toString(16));

  // AZERTY: the key in the QWERTY "Q" position types "a". Native SDL gives
  // the layout's key (SDLK_a) and so must the browser; Playwright's keyboard
  // is QWERTY only, so send the event through CDP.
  await hold(page, 'ArrowDown');         // DOWN
  await sleep(300);
  await hold(page, 'Enter');             // edit DOWN
  await sleep(500);
  const cdp = await page.context().newCDPSession(page);
  const azertyA = { code: 'KeyQ', key: 'a', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 };
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: 'a', ...azertyA });
  await sleep(150);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...azertyA });
  await sleep(500);
  if (outDir) await page.locator('canvas').screenshot({ path: `${outDir}/pad-azerty-keys-menu.png` });
  const down = await page.evaluate(() => {
    const d = Module.FS.readFile('/data/bb.cfg');
    return new DataView(d.buffer, d.byteOffset).getUint32(10, true); // P1 DOWN
  });
  check(down === 'a'.charCodeAt(0), 'AZERTY: physical Q key binds as "a" (layout key, like native SDL)', '0x' + down.toString(16));
  check(errors.length === 0, 'no page errors with a gamepad', errors.join(' | '));
  await context.close();
}

await Promise.race([browser.close(), sleep(5000)]);
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
