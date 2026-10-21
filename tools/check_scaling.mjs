// Checks that the page shows the game's 640x480 framebuffer pixel-exact at
// several window sizes: the canvas sits on whole device pixels, is scaled by
// an integer factor N, and every NxN block of the screenshot equals the
// matching framebuffer pixel.
//
//   node tools/check_scaling.mjs <url> [options]
//     --frame N          frame to compare (default 600)
//     --sizes WxH,...    window sizes (default 800x600,1366x768,1920x1080)
//     --dpr a,b          device pixel ratios (default 1)
//     --fullscreen       also check in fullscreen (Fullscreen button), on a
//                        1920x1080 screen so the scale changes when it can
//     --css RULES        extra CSS for the page (to see that the check fails)
//     --out DIR          save screenshots and failing crops here
//
// It runs the game with the harness (BB_FIXED_STEP_MS=11), so frame N is
// the same every run. The frame comes from the harness onFrame hook; when it
// arrives the game is frozen (timers are held), so the canvas keeps showing
// exactly that frame while the screenshots are taken.
// Needs Playwright (npm i playwright); CHROMIUM_PATH picks the browser.
import { chromium } from 'playwright';
import fs from 'node:fs';
import zlib from 'node:zlib';

const args = process.argv.slice(2);
const url = args[0] && !args[0].startsWith('--') ? args[0] : 'http://localhost:8000/';
function opt(name, def) {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : def;
}
const frame = +opt('frame', 600);
const sizes = opt('sizes', '800x600,1366x768,1920x1080').split(',').map(s => s.split('x').map(Number));
const dprs = opt('dpr', '1').split(',').map(Number);
const checkFullscreen = args.includes('--fullscreen');
const outDir = opt('out', null);
const extraCss = opt('css', '');
if (outDir) fs.mkdirSync(outDir, { recursive: true });

// Minimal PNG decoder (8-bit RGB/RGBA, not interlaced), as Chromium writes.
function decodePng(buf) {
  let pos = 8, w = 0, h = 0, type = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const kind = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (kind === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported PNG');
      type = data[9];
    } else if (kind === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const bpp = type === 6 ? 4 : type === 2 ? 3 : 0;
  if (!bpp) throw new Error('unsupported PNG colour type ' + type);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(w * h * 3);
  let prev = Buffer.alloc(stride), cur = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 255;
    }
    for (let x = 0; x < w; x++)
      for (let k = 0; k < 3; k++) out[(y * w + x) * 3 + k] = cur[x * bpp + k];
    [prev, cur] = [cur, prev];
  }
  return { w, h, rgb: out };
}

// Writes an RGB image as a binary PPM (for looking at failures).
function savePpm(path, w, h, rgb) {
  fs.writeFileSync(path, Buffer.concat([Buffer.from(`P6\n${w} ${h}\n255\n`), rgb]));
}

// Compares the screenshot's canvas area with the framebuffer.
function compare(shot, rect, n, fb) {
  let bad = 0, first = null;
  for (let y = 0; y < 480 * n; y++) {
    const sy = rect.y + y;
    for (let x = 0; x < 640 * n; x++) {
      const sx = rect.x + x;
      const fi = ((y / n | 0) * 640 + (x / n | 0)) * 3;
      if (sx < 0 || sy < 0 || sx >= shot.w || sy >= shot.h) continue;  // cropped by a small window
      const si = (sy * shot.w + sx) * 3;
      if (shot.rgb[si] !== fb[fi] || shot.rgb[si + 1] !== fb[fi + 1] || shot.rgb[si + 2] !== fb[fi + 2]) {
        bad++;
        if (!first) first = { x, y, shot: [...shot.rgb.subarray(si, si + 3)], fb: [...fb.subarray(fi, fi + 3)] };
      }
    }
  }
  return { bad, first };
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let failures = 0;
let reference = null;

for (const dpr of dprs) {
  for (const [vw, vh] of sizes) {
    const context = await browser.newContext({
      viewport: { width: vw, height: vh }, deviceScaleFactor: dpr,
      screen: checkFullscreen ? { width: Math.max(vw, 1920), height: Math.max(vh, 1080) } : { width: vw, height: vh },
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(frame => {
      // Holds back timers once the target frame is on screen. The game
      // yields with setTimeout after every present, so it stops right there.
      const realSetTimeout = window.setTimeout.bind(window);
      window.__bbHeld = [];
      window.setTimeout = (fn, ms, ...a) => {
        if (window.__bbFrozen) { window.__bbHeld.push(fn); return 0; }
        return realSetTimeout(fn, ms, ...a);
      };
      window.bbHooks = {
        bbEnv: { BB_FIXED_STEP_MS: 11, BB_DUMP_EVERY: frame },
        onFrame(n, bytes, pitch, h) {
          if (n !== frame) return;
          const rgb = new Uint8Array(640 * 480 * 3);
          for (let y = 0; y < 480; y++)
            for (let x = 0; x < 640; x++)
              for (let k = 0; k < 3; k++) rgb[(y * 640 + x) * 3 + k] = bytes[y * pitch + x * 4 + k];
          let s = '';
          for (let i = 0; i < rgb.length; i += 0x8000) s += String.fromCharCode.apply(null, rgb.subarray(i, i + 0x8000));
          window.__bbFrame = btoa(s);
          window.__bbFrozen = true;
        },
      };
    }, frame);
    await page.goto(url);
    if (extraCss) await page.addStyleTag({ content: extraCss });
    await page.waitForFunction(() => window.__bbFrozen, null, { timeout: 300000, polling: 100 });
    const fb = Buffer.from(await page.evaluate(() => window.__bbFrame), 'base64');
    const colours = new Set();
    for (let i = 0; i < fb.length; i += 3) colours.add(fb[i] << 16 | fb[i + 1] << 8 | fb[i + 2]);
    if (!reference) console.log(`frame ${frame}: ${colours.size} distinct colours`);
    if (!reference) reference = fb;
    else if (!reference.equals(fb)) {
      console.log(`  note: frame ${frame} differs between runs (harness not deterministic?)`);
    }

    const modes = [['windowed', null]];
    if (checkFullscreen) modes.push(['fullscreen', async () => {
      await page.mouse.move(vw / 2, vh / 2);
      await page.click('#fs-btn');
      await page.waitForFunction(() => !!document.fullscreenElement, null, { timeout: 5000 });
      // Headless Chromium enters fullscreen without growing the viewport; do
      // what a real browser does and give the page the whole screen.
      await page.setViewportSize({ width: Math.max(vw, 1920), height: Math.max(vh, 1080) });
    }]);

    for (const [mode, enter] of modes) {
      const label = `${vw}x${vh} dpr ${dpr} ${mode}`;
      if (enter) {
        try { await enter(); } catch (e) { console.log(`${label}: SKIPPED (fullscreen unavailable: ${e.message.split('\n')[0]})`); continue; }
      }
      // Let layout settle and the compositor show the frozen frame.
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      await page.waitForTimeout(300);
      const info = await page.evaluate(() => {
        const c = document.getElementById('canvas');
        const r = c.getBoundingClientRect();
        const d = window.devicePixelRatio;
        return { x: r.left * d, y: r.top * d, w: r.width * d, h: r.height * d, dpr: d,
                 inner: [innerWidth, innerHeight], scale: +c.dataset.scale,
                 overlay: !document.getElementById('overlay').hidden,
                 fullscreen: !!document.fullscreenElement };
      });
      const png = await page.screenshot({ animations: 'disabled', caret: 'initial' });
      const shot = decodePng(png);
      const n = Math.round(info.w / 640);
      const rect = { x: Math.round(info.x), y: Math.round(info.y) };
      const problems = [];
      if (info.overlay) problems.push('start overlay still shown');
      // Layout positions are stored in 1/64 CSS px, so allow that much; the
      // pixel comparison below is what decides.
      const tol = info.dpr / 64 + 1e-6;
      if (Math.abs(info.w - 640 * n) > tol || Math.abs(info.h - 480 * n) > tol)
        problems.push(`canvas is ${info.w}x${info.h} device px, not ${640 * n}x${480 * n}`);
      if (Math.abs(info.x - rect.x) > tol || Math.abs(info.y - rect.y) > tol)
        problems.push(`canvas origin ${info.x},${info.y} is not on a device pixel`);
      const best = Math.max(1, Math.floor(Math.min(shot.w / 640, shot.h / 480)));
      if (n !== best) problems.push(`scale ${n} but ${best} would fit`);
      const { bad, first } = compare(shot, rect, n, fb);
      if (bad) problems.push(`${bad} device pixels differ, first at canvas (${first.x},${first.y}): ` +
                             `screen ${first.shot} vs framebuffer ${first.fb}`);
      if (errors.length) problems.push('page errors: ' + errors.join('; '));
      const where = `canvas ${640 * n}x${480 * n} at (${rect.x},${rect.y}) in ${shot.w}x${shot.h} screenshot`;
      if (problems.length) {
        failures++;
        console.log(`${label}: FAIL scale ${n}, ${where}\n  - ${problems.join('\n  - ')}`);
      } else {
        console.log(`${label}: OK scale ${n}, ${where}, all ${640 * 480} source pixels exact`);
      }
      if (outDir) {
        const base = `${outDir}/${vw}x${vh}_dpr${dpr}_${mode}`;
        fs.writeFileSync(base + '.png', png);
        if (bad || !fs.existsSync(`${outDir}/frame_${frame}.ppm`)) savePpm(`${outDir}/frame_${frame}.ppm`, 640, 480, fb);
      }
    }
    await Promise.race([context.close(), new Promise(r => setTimeout(r, 5000))]);
  }
}
await Promise.race([browser.close(), new Promise(r => setTimeout(r, 5000))]);
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
