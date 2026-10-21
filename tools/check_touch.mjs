// Plays the game with the on-screen touch controls on an emulated phone
// (844x390 landscape, devicePixelRatio 3, touch only):
//   - checks the controls appear in the margins, outside the game picture;
//   - taps through the menus to the first level with Menu, Start and the pad;
//   - holds the pad's right arrow and Fire together (two fingers) and checks
//     the game picture changes (the player walks and shoots);
//   - slides a finger across the pad and off a button, cancels touches, and
//     checks every key the controls pressed is released again.
//
//   node tools/check_touch.mjs <url> [outdir]
//
// The page reads the player 1 keys from the game. Until data/bb.cfg holds
// valid keys, pass --cfg to serve a test bb.cfg with the game's intended
// defaults (arrows, X fire, Space jump, C special).
// Needs Playwright (npm i playwright); CHROMIUM_PATH picks the browser.
import { chromium } from 'playwright';
import fs from 'node:fs';

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const url = args[0] || 'http://localhost:8000/';
const out = args[1] || null;
if (out) fs.mkdirSync(out, { recursive: true });
const serveCfg = process.argv.includes('--cfg');

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext({
  viewport: { width: 844, height: 390 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

if (serveCfg) {
  // vsync, fullscreen (1 byte each), language (int), then 14 SDL keycodes.
  const keys = [0x40000052, 0x40000051, 0x40000050, 0x4000004F, 120, 32, 99,
                113, 115, 100, 102, 9, 103, 104];
  const b = Buffer.alloc(62);
  b[0] = 1; b[1] = 0; b.writeInt32LE(1, 2);
  keys.forEach((k, i) => b.writeUInt32LE(k, 6 + 4 * i));
  await page.route(/\/data\/bb\.cfg/, r => r.fulfill({ status: 200, body: b, contentType: 'application/octet-stream' }));
}

// Records every key event the page sends to the game.
await page.addInitScript(() => {
  window.__keyLog = [];
  window.__down = {};
  for (const type of ['keydown', 'keyup'])
    window.addEventListener(type, e => {
      if (e.isTrusted) return;
      window.__keyLog.push(`${type} ${e.code}/${e.keyCode}`);
      if (type === 'keydown') window.__down[e.code] = 1; else delete window.__down[e.code];
    }, true);
});

const cdp = await context.newCDPSession(page);
async function touch(type, points) {
  await cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: points.map(([x, y], i) => ({ x, y, id: i + 1, radiusX: 8, radiusY: 8 })),
  });
}
async function center(sel) {
  const r = await page.$eval(sel, e => { const b = e.getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; });
  return [r[0] + r[2] / 2, r[1] + r[3] / 2, r];
}
async function tap(sel, hold = 150) {
  const [x, y] = await center(sel);
  await touch('touchStart', [[x, y]]);
  await page.waitForTimeout(hold);
  await touch('touchEnd', []);
  await page.waitForTimeout(350);
}
async function canvasShot(name) {
  const r = await page.$eval('#canvas', e => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; });
  const buf = await page.screenshot({ clip: r });
  if (out) fs.writeFileSync(`${out}/${name}.png`, buf);
  return buf;
}
async function fullShot(name) { if (out) await page.screenshot({ path: `${out}/${name}.png` }); }

let failures = 0;
function check(ok, what, detail = '') {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${what}${detail ? ' (' + detail + ')' : ''}`);
  if (!ok) failures++;
}

await page.goto(url);
await page.waitForSelector('#start.ready', { timeout: 600000 });
check((await page.$eval('#start', e => e.textContent)) === 'Tap to play', 'start screen says "Tap to play"');
await fullShot('touch-0-start');
await touch('touchStart', [[422, 195]]);
await touch('touchEnd', []);
await page.waitForFunction(() => document.getElementById('overlay').hidden, null, { timeout: 30000 });
await page.waitForTimeout(1500);

const layout = await page.evaluate(() => {
  const r = e => { const b = document.querySelector(e).getBoundingClientRect(); return [b.left, b.top, b.right, b.bottom]; };
  return { canvas: r('#canvas'), shown: !document.getElementById('touch').hidden,
           parts: ['#dpad', '#t-fire', '#t-jump', '#t-special', '#t-menu', '#t-start'].map(s => [s, r(s)]) };
});
check(layout.shown, 'touch controls shown on a touch device');
const [cl, ct, cr, cb] = layout.canvas;
const overlapping = layout.parts.filter(([, [l, t, r, b]]) => l < cr && r > cl && t < cb && b > ct).map(p => p[0]);
check(overlapping.length === 0, 'touch controls stay outside the game picture',
      `picture ${layout.canvas.map(Math.round)}, overlapping: ${overlapping.join(' ') || 'none'}`);
await fullShot('touch-1-playing');

// Skip the intro, then press Start every 2 s: it opens the menu, picks
// START GAME, START 1 PLAYER GAME and Blip, and starts the mission. (A press
// that lands while a screen is still sliding in is ignored by the game, so
// a few spare presses are included; Return does nothing in a level.)
await tap('#t-menu');
await page.waitForTimeout(2000);
for (let i = 0; i < 8; i++) {
  await tap('#t-start');
  await page.waitForTimeout(2000);
  await canvasShot(`touch-2-step${i}`);
}
await page.waitForTimeout(2000);
const before = await canvasShot('touch-5-before');

// Two fingers: right on the pad, and Fire.
const [dx, dy, dr] = await center('#dpad');
const [fx, fy] = await center('#t-fire');
const right = [dx + dr[2] * 0.38, dy];
await page.evaluate(() => { window.__keyLog = []; });
await touch('touchStart', [right]);
await touch('touchStart', [right, [fx, fy]]);
await page.waitForTimeout(400);
const heldNow = await page.evaluate(() => Object.keys(window.__down).sort());
await canvasShot('touch-6-holding');
await page.waitForTimeout(1200);
const after = await canvasShot('touch-7-held');
await touch('touchEnd', []);
await page.waitForTimeout(300);
check(heldNow.includes('ArrowRight') && heldNow.includes('KeyX'),
      'right and Fire held together send ArrowRight and the player 1 Fire key', heldNow.join(' '));
check(!before.equals(after), 'the game picture changes while moving and firing');
check(Object.keys(await page.evaluate(() => window.__down)).length === 0, 'all keys released after lifting both fingers');

// Slide a finger around the pad: right -> down-right -> down -> left.
await page.evaluate(() => { window.__keyLog = []; });
const R = dr[2] * 0.38;
await touch('touchStart', [[dx + R, dy]]);
await touch('touchMove', [[dx + R * 0.7, dy + R * 0.7]]);
const diag = await page.evaluate(() => Object.keys(window.__down).sort());
await touch('touchMove', [[dx, dy + R]]);
const down = await page.evaluate(() => Object.keys(window.__down).sort());
await touch('touchMove', [[dx - R, dy]]);
const left = await page.evaluate(() => Object.keys(window.__down).sort());
await touch('touchEnd', []);
check(diag.join() === 'ArrowDown,ArrowRight' && down.join() === 'ArrowDown' && left.join() === 'ArrowLeft',
      'sliding on the pad changes direction', `${diag} | ${down} | ${left}`);

// Slide off a button: Jump is released as the finger leaves it.
const [jx, jy, jr] = await center('#t-jump');
await touch('touchStart', [[jx, jy]]);
const onJump = await page.evaluate(() => Object.keys(window.__down).sort());
await touch('touchMove', [[jr[0] - 60, jy]]);
const offJump = await page.evaluate(() => Object.keys(window.__down).sort());
await touch('touchEnd', []);
check(onJump.join() === 'Space' && offJump.length === 0, 'sliding off a button releases it',
      `on: ${onJump} off: ${offJump.join() || 'none'}`);

// A cancelled touch releases too.
await touch('touchStart', [[fx, fy]]);
const firing = await page.evaluate(() => Object.keys(window.__down).sort());
await touch('touchCancel', []);
await page.waitForTimeout(100);
const cancelled = await page.evaluate(() => Object.keys(window.__down).sort());
check(firing.join() === 'KeyX' && cancelled.length === 0, 'touchcancel releases the key',
      `held ${firing}, after cancel: ${cancelled.join() || 'none'}`);

check(errors.length === 0, 'no page errors', errors.slice(0, 3).join(' | '));
await Promise.race([browser.close(), new Promise(r => setTimeout(r, 5000))]);
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
