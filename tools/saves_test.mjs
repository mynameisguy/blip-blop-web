// Checks that settings (data/bb.cfg) and hi-scores (data/bb.scr) survive a
// page reload in the browser build, as they survive a restart natively.
//   1. settings: with real key presses, turn VSYNC off and bind P1 UP to W
//      in the options menu, reload, and check the game came back with both
//      (the file, and the keys menu drawn the same as before the reload).
//   2. hi-scores: put a hi-score table in the browser's save storage,
//      reload, and check the game loaded it (it saves the same table back
//      when the page is hidden) and that a fresh page does not have it.
//
//   node tools/saves_test.mjs <url> [outDir]
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

const SDLK_UP = 0x40000052;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--autoplay-policy=no-user-gesture-required'],
});

function hooks() {
  window.bbFrames = 0;
  window.bbSaves = 0;
  window.bbHooks = {
    onFrame() { window.bbFrames++; },
    onSaved() { window.bbSaves++; },
  };
}

async function open(page) {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(() => window.bbFrames > 20, null, { timeout: 60000 });
  return errors;
}

async function hold(page, key, ms = 150) {
  await page.keyboard.down(key);
  await sleep(ms);
  await page.keyboard.up(key);
}

// vsync flag and P1 UP key from the game's config file.
const readConfig = page => page.evaluate(() => {
  const d = Module.FS.readFile('/data/bb.cfg');
  const v = new DataView(d.buffer, d.byteOffset, d.length);
  return { size: d.length, vsync: d[0], p1up: v.getUint32(6, true) };
});

async function openKeysMenu(page) {
  await hold(page, 'Escape');           // skip the intro
  await sleep(1000);
  await hold(page, 'ArrowDown');        // OPTIONS
  await sleep(300);
  await hold(page, 'Enter');
  await sleep(500);
}

async function canvasShot(page, name) {
  const png = await page.locator('canvas').screenshot();
  if (outDir) fs.writeFileSync(`${outDir}/${name}.png`, png);
  return png;
}

// --- 1. settings -------------------------------------------------------------
let fresh;
{
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(hooks);
  const errors = await open(page);
  const before = await readConfig(page);
  check(before.vsync === 1 && before.p1up === SDLK_UP, 'first visit uses the shipped config',
    JSON.stringify(before));

  await openKeysMenu(page);
  await hold(page, 'ArrowRight');       // VSYNC ON -> OFF
  await sleep(300);
  await hold(page, 'ArrowDown');        // FULLSCREEN
  await sleep(300);
  await hold(page, 'ArrowDown');        // P1 KEYS
  await sleep(300);
  await hold(page, 'Enter');
  await sleep(500);
  fresh = await canvasShot(page, 'saves-1-keys-default');
  await hold(page, 'Enter');            // edit UP
  await sleep(500);
  await hold(page, 'w');
  await sleep(500);
  await page.waitForFunction(() => window.bbSaves >= 2, null, { timeout: 10000 }).catch(() => {});
  const edited = await canvasShot(page, 'saves-2-keys-edited');
  const after = await readConfig(page);
  check(after.vsync === 0 && after.p1up === 'w'.charCodeAt(0), 'menu changes are written to data/bb.cfg',
    JSON.stringify(after));
  check(await page.evaluate(() => window.bbSaves) >= 2, 'changes were flushed to IndexedDB',
    `${await page.evaluate(() => window.bbSaves)} syncs`);

  await page.reload();
  await page.waitForFunction(() => window.bbFrames > 20, null, { timeout: 60000 });
  const reloaded = await readConfig(page);
  check(reloaded.vsync === 0 && reloaded.p1up === 'w'.charCodeAt(0), 'settings survive a reload',
    JSON.stringify(reloaded));
  await openKeysMenu(page);
  await hold(page, 'ArrowDown');
  await sleep(300);
  await hold(page, 'ArrowDown');
  await sleep(300);
  await hold(page, 'Enter');            // P1 KEYS
  await sleep(500);
  const shown = await canvasShot(page, 'saves-3-keys-after-reload');
  check(shown.equals(edited), 'after the reload the keys menu shows UP = W, as before it');
  check(!shown.equals(fresh), 'and differs from the default keys menu');
  check(errors.length === 0, 'no page errors', errors.join(' | '));
  await context.close();
}

// --- 2. hi-scores ------------------------------------------------------------
// data/bb.scr: 10 x (int score, char name[20]), each XORed with
// 0x35674a1f << i, then the sum of the plain scores and name bytes.
function encodeScores(table) {
  const buf = new ArrayBuffer(10 * 24 + 4);
  const v = new DataView(buf);
  let sum = 0;
  table.forEach(([score, name], i) => {
    const key = (0x35674a1f << i) | 0;
    const bytes = new Uint8Array(20);
    for (let j = 0; j < name.length; j++) bytes[j] = name.charCodeAt(j);
    sum = (sum + score) | 0;
    bytes.forEach(b => { sum = (sum + b) | 0; });
    v.setInt32(i * 24, score ^ key, true);
    const nv = new DataView(bytes.buffer);
    for (let j = 0; j < 20; j += 4) v.setInt32(i * 24 + 4 + j, nv.getInt32(j, true) ^ key, true);
  });
  v.setInt32(240, sum, true);
  return Array.from(new Uint8Array(buf));
}
{
  const table = Array.from({ length: 10 }, (_, i) => [900000 - i * 1000, 'SAVES TEST ' + i]);
  const crafted = encodeScores(table);
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(hooks);
  const errors = await open(page);
  const shipped = await page.evaluate(() => Array.from(Module.FS.readFile('/data/bb.scr')));
  check(JSON.stringify(shipped) !== JSON.stringify(crafted), 'test table differs from the shipped one');
  // Store the table the way the page stores saves (IDBFS at /persist).
  await page.evaluate(bytes => new Promise((resolve, reject) => {
    Module.FS.writeFile('/persist/bb.scr', new Uint8Array(bytes));
    Module.FS.syncfs(false, e => (e ? reject(e) : resolve()));
  }), crafted);
  await page.reload();
  await page.waitForFunction(() => window.bbFrames > 20, null, { timeout: 60000 });
  const loaded = await page.evaluate(() => Array.from(Module.FS.readFile('/data/bb.scr')));
  check(JSON.stringify(loaded) === JSON.stringify(crafted), 'saved hi-scores replace the shipped file before main()');
  // Hiding the page makes the game save its in-memory table: the same bytes
  // only if it accepted the stored file (a bad checksum resets it).
  await page.evaluate(() => Module.FS.writeFile('/data/bb.scr', new Uint8Array(244)));
  const saves = await page.evaluate(() => window.bbSaves);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForFunction(n => window.bbSaves > n, saves, { timeout: 10000 }).catch(() => {});
  const resaved = await page.evaluate(() => Array.from(Module.FS.readFile('/data/bb.scr')));
  check(JSON.stringify(resaved) === JSON.stringify(crafted), 'the game loaded that table (saved back on hide)');
  check(await page.evaluate(() => window.bbSaves) > saves, 'hiding the page flushes saves to IndexedDB');
  check(errors.length === 0, 'no page errors', errors.join(' | '));
  await context.close();

  // A different profile (new context) starts from the shipped files.
  const other = await browser.newContext();
  const page2 = await other.newPage();
  await page2.addInitScript(hooks);
  await open(page2);
  const cfg = await readConfig(page2);
  const scr = await page2.evaluate(() => Array.from(Module.FS.readFile('/data/bb.scr')));
  check(cfg.p1up === SDLK_UP && JSON.stringify(scr) === JSON.stringify(shipped),
    'a new browser profile starts from the shipped files');
  await other.close();
}

await Promise.race([browser.close(), sleep(5000)]);
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
