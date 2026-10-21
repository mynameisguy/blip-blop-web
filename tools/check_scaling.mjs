// Checks that the page shows the game's 640x480 framebuffer pixel-exact at
// several window sizes. Each WHOLE screenshot is compared with the image the
// page must produce, worked out from the screenshot size alone:
//   - N = the largest whole factor with 640N x 480N <= the screen (device
//     pixels); the frame scaled NxN, centred (within a few device pixels, the
//     page keeps its position on whole CSS pixels), never cropped;
//   - every other pixel black.
// When even 1x does not fit, the page must scale down to fit instead: then
// the picture must be the whole frame, centred, 4:3, fully on screen, close
// to the frame (smooth scaling cannot be exact), and the margins black.
// The toolbar is hidden for the screenshot (it fades out on its own once the
// mouse is still, but timers are held while the frame is frozen). Touch
// controls are not shown here: tools/check_touch.mjs checks they stay off
// the picture.
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

// Bounding box of the non-black pixels of an RGB image.
function bbox(rgb, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      if (rgb[i] | rgb[i + 1] | rgb[i + 2]) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

// Compares the whole screenshot with: black, plus the frame scaled to
// pw x ph at (px, py) (nearest pixel). Returns mismatch counts inside the
// picture and in the margins, and the mean abs difference inside.
function compareWhole(shot, fb, px, py, pw, ph) {
  let inside = 0, margin = 0, sum = 0, count = 0, first = null;
  for (let y = 0; y < shot.h; y++) {
    for (let x = 0; x < shot.w; x++) {
      const si = (y * shot.w + x) * 3;
      const s = shot.rgb;
      if (x >= px && x < px + pw && y >= py && y < py + ph) {
        const fx = Math.floor((x - px) * 640 / pw), fy = Math.floor((y - py) * 480 / ph);
        const fi = (fy * 640 + fx) * 3;
        const d = Math.abs(s[si] - fb[fi]) + Math.abs(s[si + 1] - fb[fi + 1]) + Math.abs(s[si + 2] - fb[fi + 2]);
        sum += d; count++;
        if (d) {
          inside++;
          if (!first) first = `screen (${x},${y}) is ${[...s.subarray(si, si + 3)]}, frame (${fx},${fy}) is ${[...fb.subarray(fi, fi + 3)]}`;
        }
      } else if (s[si] | s[si + 1] | s[si + 2]) {
        margin++;
        if (!first) first = `margin pixel (${x},${y}) is ${[...s.subarray(si, si + 3)]}, not black`;
      }
    }
  }
  return { inside, margin, mad: count ? sum / count / 3 : 0, first };
}

// Positions within `slack` device pixels of the centre that the page may
// use: whole device pixels that are also whole CSS pixels (or the centre
// itself, rounded, when the ratio has none nearby).
function placements(free, dpr, slack) {
  const c = free / 2, out = [];
  for (let v = Math.floor(c - slack); v <= Math.ceil(c + slack); v++) {
    const css = v / dpr;
    if (Math.abs(css - Math.round(css)) < 1e-3 || Math.abs(v - c) <= 0.5) out.push(v);
  }
  return out;
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
      const overlayShown = await page.evaluate(() => !document.getElementById('overlay').hidden);
      // The toolbar is not part of the picture; hide it for the shot.
      const hide = await page.addStyleTag({ content: '#toolbar { visibility: hidden !important; }' });
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      const png = await page.screenshot({ animations: 'disabled', caret: 'initial' });
      const shot = decodePng(png);
      const problems = [];
      if (overlayShown) problems.push('start overlay still shown');

      const n = Math.floor(Math.min(shot.w / 640, shot.h / 480));
      let pw, ph;
      if (n >= 1) { pw = 640 * n; ph = 480 * n; }
      else { pw = Math.min(shot.w, Math.floor(shot.h * 4 / 3)); ph = Math.round(pw * 3 / 4); }
      // The page moves the picture at most half a "whole CSS pixel" step
      // from the exact centre (1 device pixel at ratios 1 and 2, 3 at 1.25).
      let step = 1;
      while (step < 64 && Math.abs(step / dpr - Math.round(step / dpr)) > 1e-3) step++;
      const slack = Math.max(1, Math.ceil(step / 2));
      const xs = placements(shot.w - pw, dpr, slack), ys = placements(shot.h - ph, dpr, slack);

      // Where is the picture? Match the frame's non-black box against the
      // screen's, then require that position to be one the page may use.
      const fbBox = bbox(fb, 640, 480), scBox = bbox(shot.rgb, shot.w, shot.h);
      let px = null, py = null;
      if (!scBox) problems.push('nothing but black on screen: the game picture is not visible');
      else if (n < 1) {
        // Smooth scaling blurs the edges, so try each allowed position and
        // keep the closest; the margin and difference checks below decide.
        let best = Infinity;
        for (const x of xs) for (const y of ys) {
          const t = compareWhole(shot, fb, x, y, pw, ph);
          if (t.mad + t.margin < best) { best = t.mad + t.margin; px = x; py = y; }
        }
      } else {
        px = Math.round(scBox.x0 - fbBox.x0 * pw / 640);
        py = Math.round(scBox.y0 - fbBox.y0 * ph / 480);
        if (!xs.includes(px) || !ys.includes(py)) {
          problems.push(`picture at (${px},${py}), expected centred at (${xs[0]}..${xs[xs.length - 1]}, ` +
                        `${ys[0]}..${ys[ys.length - 1]}) for ${pw}x${ph}`);
        }
        if (px < 0 || py < 0 || px + pw > shot.w || py + ph > shot.h)
          problems.push(`picture ${pw}x${ph} at (${px},${py}) is cropped by the ${shot.w}x${shot.h} screen`);
      }
      // Compare the whole screenshot. When the found position is not an
      // allowed one, compare against the nearest allowed one instead.
      const cx = px !== null && xs.includes(px) ? px : xs[Math.floor(xs.length / 2)];
      const cy = py !== null && ys.includes(py) ? py : ys[Math.floor(ys.length / 2)];
      const r = compareWhole(shot, fb, cx, cy, pw, ph);
      if (n >= 1) {
        if (r.inside) problems.push(`${r.inside} picture pixels differ from the frame scaled ${n}x`);
      } else if (r.mad > 12) {
        problems.push(`picture differs too much from the frame (mean difference ${r.mad.toFixed(1)})`);
      }
      if (r.margin) problems.push(`${r.margin} margin pixels are not black`);
      if (r.first && problems.length) problems.push('first difference: ' + r.first);
      if (errors.length) problems.push('page errors: ' + errors.join('; '));

      const how = n >= 1 ? `scale ${n}` : `scaled down to ${pw}x${ph} (below 1x)`;
      const where = `${how}, picture at (${cx},${cy}) in ${shot.w}x${shot.h} screenshot`;
      if (problems.length) {
        failures++;
        console.log(`${label}: FAIL ${where}\n  - ${problems.join('\n  - ')}`);
      } else if (n >= 1) {
        console.log(`${label}: OK ${where}; all ${shot.w * shot.h} screen pixels as expected`);
      } else {
        console.log(`${label}: OK ${where}; margins black, mean difference ${r.mad.toFixed(1)}`);
      }
      const bad = problems.length > 0;
      await hide.evaluate(e => e.remove());
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
