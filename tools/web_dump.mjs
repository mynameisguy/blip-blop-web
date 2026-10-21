// Runs the browser build headless with the deterministic harness and saves
// frames as raw RGBA files: node tools/web_dump.mjs <url> <outdir> <every> <maxFrames> [inputScript]
import { chromium } from 'playwright';
import fs from 'node:fs';

const [,, url, outDir, every, maxFrames, scriptPath] = process.argv;
fs.mkdirSync(outDir, { recursive: true });
const inputScript = scriptPath ? fs.readFileSync(scriptPath, 'utf8') : '';

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
let done;
const finished = new Promise(r => (done = r));
await page.exposeFunction('bbSaveFrame', (n, w, h, pitch, b64) => {
  const name = String(n).padStart(6, '0');
  fs.writeFileSync(`${outDir}/frame_${name}.rgba`, Buffer.from(b64, 'base64'));
  fs.writeFileSync(`${outDir}/frame_${name}.json`, JSON.stringify({ w, h, pitch }));
});
await page.exposeFunction('bbDone', () => done());
page.on('pageerror', e => console.error('PAGEERROR', e.message));
await page.addInitScript(([every, maxFrames, inputScript]) => {
  window.bbHooks = {
    bbEnv: { BB_FIXED_STEP_MS: 11, BB_DUMP_EVERY: every, BB_MAX_FRAMES: maxFrames },
    bbInputScript: inputScript || undefined,
    onFrame(n, bytes, pitch, h) {
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000)
        s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      window.bbSaveFrame(n, pitch / 4, h, pitch, btoa(s));
    },
    onMaxFrames() { window.bbDone(); },
  };
}, [every, maxFrames, inputScript]);
await page.goto(url);
await Promise.race([finished, new Promise(r => setTimeout(r, +(process.env.DUMP_TIMEOUT_MS || 600000)))]);
// The game keeps running after the last frame, and close() can stall on it.
await Promise.race([browser.close(), new Promise(r => setTimeout(r, 5000))]);
process.exit(0);
