// Checks the page around the game in a browser that blocks audio until a
// user gesture (the default): loading progress, the start overlay, audio
// unlocking, keyboard handling and the data cache.
//
//   node tools/check_shell.mjs <url>
//
// Needs Playwright (npm i playwright); CHROMIUM_PATH picks the browser.
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8000/';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
const page = await context.newPage();

const log = [];
const badResponses = [];
let dataRequests = 0;
page.on('console', m => log.push(`${m.type()}: ${m.text()}`));
page.on('pageerror', e => log.push(`pageerror: ${e.message}`));
page.on('requestfailed', r => badResponses.push(`${r.url()} ${r.failure()?.errorText}`));
page.on('response', r => { if (r.status() >= 400) badResponses.push(`${r.url()} HTTP ${r.status()}`); });
page.on('request', r => { if (/\/data\/(?!manifest)/.test(r.url())) dataRequests++; });
await page.addInitScript(() => {
  // Records whether the page or the game blocked the browser's default
  // action for each key, after all listeners ran.
  window.__keys = [];
  window.addEventListener('keydown', e => {
    setTimeout(() => window.__keys.push({ key: e.key, prevented: e.defaultPrevented }), 0);
  }, true);
});

let failures = 0;
function check(ok, what, detail = '') {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${what}${detail ? ' (' + detail + ')' : ''}`);
  if (!ok) failures++;
}

const t0 = Date.now();
await page.goto(url);
const progress = [];
const poll = setInterval(async () => {
  try { progress.push(await page.$eval('#status', e => e.textContent)); } catch {}
}, 250);
await page.waitForSelector('#start.ready', { timeout: 600000 });
clearInterval(poll);
console.log(`data loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s, ${dataRequests} data requests`);
check(progress.some(s => /Downloading game data… [\d.]+ \/ [\d.]+ MB/.test(s)), 'progress shown in MB',
      progress.filter(s => /MB/.test(s)).slice(0, 3).join(' | '));

let state = await page.evaluate(() => ({
  overlay: !document.getElementById('overlay').hidden,
  ctx: window.Module.SDL2 && Module.SDL2.audioContext ? Module.SDL2.audioContext.state : 'none',
}));
check(state.overlay, 'start overlay waits for a gesture', `audio context: ${state.ctx}`);

await page.mouse.click(683, 384);
await page.waitForFunction(() => document.getElementById('overlay').hidden, null, { timeout: 30000 });
await page.waitForFunction(() => Module.SDL2 && Module.SDL2.audioContext &&
  Module.SDL2.audioContext.state === 'running', null, { timeout: 10000 }).catch(() => {});
state = await page.evaluate(() => ({ ctx: Module.SDL2.audioContext.state, rate: Module.SDL2.audioContext.sampleRate }));
check(state.ctx === 'running', 'AudioContext running after the click', `state ${state.ctx}, ${state.rate} Hz`);

// Measure the sound the game sends to the speakers for a few seconds.
const level = await page.evaluate(() => new Promise(resolve => {
  const node = Module.SDL2.audio && Module.SDL2.audio.scriptProcessorNode;
  if (!node) return resolve({ error: 'no SDL audio node' });
  let blocks = 0, loud = 0, peak = 0;
  node.addEventListener('audioprocess', e => {
    const d = e.outputBuffer.getChannelData(0);
    let m = 0;
    for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i]));
    blocks++; if (m > 0.01) loud++; peak = Math.max(peak, m);
  });
  setTimeout(() => resolve({ blocks, loud, peak }), 6000);
}));
check(level.loud > 0, 'game audio is not silent', JSON.stringify(level));

const focus = await page.evaluate(() => document.activeElement && document.activeElement.id);
check(focus === 'canvas', 'canvas has focus', `active element: ${focus}`);

for (const k of ['ArrowDown', 'ArrowUp', 'Space', 'PageDown', 'Slash', 'Quote']) await page.keyboard.press(k);
await page.keyboard.press('F11');
await page.waitForTimeout(200);
const keys = await page.evaluate(() => ({ keys: window.__keys, scroll: [scrollX, scrollY] }));
const prevented = Object.fromEntries(keys.keys.map(k => [k.key, k.prevented]));
check([' ', 'ArrowDown', 'ArrowUp', 'PageDown', '/', "'"].every(k => prevented[k]), 'game keys (and / and \' for quick find) do not reach the page',
      JSON.stringify(prevented));
check(prevented.F11 === false, 'F11 is left to the browser');
check(keys.scroll[0] === 0 && keys.scroll[1] === 0, 'page did not scroll');

// A click anywhere on the page gives the keyboard back to the game.
await page.evaluate(() => document.activeElement.blur());
await page.mouse.click(20, 700);
const refocused = await page.evaluate(() => document.activeElement && document.activeElement.id);
check(refocused === 'canvas', 'a click on the page refocuses the canvas', `active element: ${refocused}`);

const errors = log.filter(l => /^(error|pageerror)/.test(l));
check(errors.length === 0, 'no console errors', errors.slice(0, 5).join(' | '));
check(badResponses.length === 0, 'no failed requests', badResponses.slice(0, 5).join(' | '));
const warnings = log.filter(l => /^warning/.test(l));
if (warnings.length) console.log('console warnings:\n  ' + warnings.slice(0, 10).join('\n  '));

// Second visit: the data should come from the cache.
dataRequests = 0;
const t1 = Date.now();
await page.reload();
await page.waitForSelector('#start.ready', { timeout: 600000 });
const status = await page.$eval('#status', e => e.textContent);
console.log(`reload: data ready in ${((Date.now() - t1) / 1000).toFixed(1)} s`);
check(dataRequests === 0, 'second visit reads the data from the cache', `${dataRequests} data requests`);

// A missing WebAssembly file gives a friendly message, and "Ready." is
// never shown without it.
const ctx2 = await browser.newContext();
const page2 = await ctx2.newPage();
await page2.route(/blipblop\.([0-9a-f]+\.)?wasm/, r => r.fulfill({ status: 404, body: 'missing' }));
const seen = [];
const poll2 = setInterval(async () => { try { seen.push(await page2.$eval('#status', e => e.textContent)); } catch {} }, 100);
await page2.goto(url);
await page2.waitForSelector('#status.error', { timeout: 120000 }).catch(() => {});
clearInterval(poll2);
const msg = await page2.$eval('#status', e => e.textContent);
check(/could not start/.test(msg) && !seen.includes('Ready.'), 'missing blipblop.wasm gives a friendly error', msg);
await ctx2.close();

// A crash while playing shows a message instead of a frozen picture: a
// WebAssembly trap, and a plain exception thrown through the game's code
// (both thrown from the harness frame hook, which the game calls at frame 200).
for (const kind of ['RuntimeError', 'Error']) {
  const ctx3 = await browser.newContext();
  const page3 = await ctx3.newPage();
  await page3.addInitScript(kind => {
    window.bbHooks = {
      bbEnv: { BB_FIXED_STEP_MS: 11, BB_DUMP_EVERY: 200 },
      onFrame(n) {
        if (n !== 200) return;
        throw kind === 'RuntimeError' ? new WebAssembly.RuntimeError('memory access out of bounds')
                                      : new Error('test exception in a game callback');
      },
    };
  }, kind);
  await page3.goto(url);
  const shown = await page3.waitForSelector('#status.error', { timeout: 120000 }).then(() => true, () => false);
  const text = shown ? await page3.$eval('#status', e => e.textContent) : '(nothing shown)';
  check(shown && /stopped because of an error/.test(text), `a ${kind} during play shows an error`, text);
  await ctx3.close();
}

await Promise.race([browser.close(), new Promise(r => setTimeout(r, 5000))]);
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
