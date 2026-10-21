// Runs the browser build headless with the deterministic harness and saves
// frames as raw RGBA files: node tools/web_dump.mjs <url> <outdir> <every> <maxFrames> [inputScript]
// <every> 0 saves no pictures. Other BB_* harness options (e.g.
// BB_START_LEVEL, BB_HASH_EVERY) are passed on from the environment, as for
// the native build; frame hashes go to <outdir>/hashes.txt.
// Exits 1 if the page failed or never reached maxFrames.
import { chromium } from 'playwright';
import fs from 'node:fs';

const [,, url, outDir, every, maxFrames, scriptPath] = process.argv;
fs.mkdirSync(outDir, { recursive: true });
const inputScript = scriptPath ? fs.readFileSync(scriptPath, 'utf8') : '';
const extraEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
  k.startsWith('BB_') && !['BB_DUMP_DIR', 'BB_INPUT_SCRIPT', 'BB_HASH_FILE'].includes(k)));
const saveImages = +every > 0;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
let done;
let failed = false;
const finished = new Promise(r => (done = r));
await page.exposeFunction('bbSaveFrame', (n, w, h, pitch, b64) => {
  const name = String(n).padStart(6, '0');
  try {
    fs.writeFileSync(`${outDir}/frame_${name}.rgba`, Buffer.from(b64, 'base64'));
    fs.writeFileSync(`${outDir}/frame_${name}.json`, JSON.stringify({ w, h, pitch }));
  } catch (e) {
    console.error('WRITE FAILED', e.message);
    failed = true;
  }
});
await page.exposeFunction('bbDone', () => done(true));
page.on('pageerror', e => { console.error('PAGEERROR', e.message); failed = true; });
page.on('crash', () => { console.error('PAGE CRASHED'); failed = true; done(false); });
await page.addInitScript(([every, maxFrames, inputScript, extraEnv, saveImages]) => {
  window.bbHashes = [];
  window.bbHooks = {
    bbEnv: { BB_FIXED_STEP_MS: 11, ...extraEnv, BB_DUMP_EVERY: saveImages ? every : 1,
             BB_MAX_FRAMES: maxFrames },
    bbInputScript: inputScript || undefined,
    onFrame: saveImages ? function (n, bytes, pitch, h) {
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000)
        s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      window.bbSaveFrame(n, pitch / 4, h, pitch, btoa(s));
    } : undefined,
    onFrameHash(n, hi, lo) {
      window.bbHashes.push(String(n).padStart(6, '0') + ' ' +
        hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0'));
    },
    onMaxFrames() { window.bbDone(); },
  };
}, [every, maxFrames, inputScript, extraEnv, saveImages]);
await page.goto(url);
const ok = await Promise.race([finished, new Promise(r =>
  setTimeout(() => r(false), +(process.env.DUMP_TIMEOUT_MS || 600000)))]);
if (!ok) console.error('did not reach BB_MAX_FRAMES');
try {
  const hashes = await Promise.race([page.evaluate(() => window.bbHashes),
    new Promise((_, j) => setTimeout(() => j(new Error('timeout')), 20000))]);
  if (hashes.length) fs.writeFileSync(`${outDir}/hashes.txt`, hashes.join('\n') + '\n');
} catch (e) {
  console.error('could not read hashes:', e.message);
  failed = true;
}
// The game keeps running after the last frame, and close() can stall on it.
await Promise.race([browser.close(), new Promise(r => setTimeout(r, 5000))]);
process.exit(ok && !failed ? 0 : 1);
