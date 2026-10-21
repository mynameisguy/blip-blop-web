// Checks where the touch controls go on common phones and tablets, with
// the game running:
//   - landscape phones: every control is outside the game picture (in the
//     margins), the pad is at least 88 px and the buttons at least 48 px;
//   - portrait phones and tablets: the picture fills the screen width at
//     the top (4:3, even at a non-integer scale, drawn sharp-bilinear on
//     #view), and every control is below it;
//   - only when even the smallest controls do not fit (a tablet in
//     landscape) may they cover the picture, and then they are faint;
//   - every control is fully on screen;
//   - the pad sends ONE key per direction: the player 1 key (so player 2,
//     bound to the arrows here, does not move too).
//
//   node tools/check_touch_layout.mjs <url> [outdir]
// Needs Playwright (npm i playwright); CHROMIUM_PATH picks the browser.
import { chromium } from 'playwright';
import fs from 'node:fs';

const url = process.argv[2] || 'http://localhost:8000/';
const out = process.argv[3] || null;
if (out) fs.mkdirSync(out, { recursive: true });

const DEVICES = [
  // [width, height, devicePixelRatio, may overlap]
  [844, 390, 3, false],     // iPhone 12-14 landscape
  [640, 360, 3, false],     // 16:9 phone
  [740, 360, 4, false],     // Galaxy S8/S9
  [732, 412, 2.625, false], // Pixel
  [915, 412, 2.625, false], // Pixel 7
  [568, 320, 2, false],     // iPhone SE (1st gen)
  [667, 375, 2, false],     // iPhone 8
  [390, 844, 3, false],     // portrait
  [360, 740, 4, false],
  [412, 915, 2.625, false],
  [375, 667, 2, false],
  [1024, 768, 2, true],     // iPad landscape: margins are 32 px
  [768, 1024, 2, false],    // iPad portrait
];

// P1 on WASD-like keys, P2 on the arrows.
function cfg() {
  const keys = [119, 115, 97, 100, 120, 32, 99,
                0x40000052, 0x40000051, 0x40000050, 0x4000004F, 9, 103, 104];
  const b = Buffer.alloc(62);
  b[0] = 1; b.writeInt32LE(1, 2);
  keys.forEach((k, i) => b.writeUInt32LE(k, 6 + 4 * i));
  return b;
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let failures = 0;
function check(ok, what, detail = '') {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${what}${detail ? ' (' + detail + ')' : ''}`);
  if (!ok) failures++;
}

for (const [w, h, dpr, mayOverlap] of DEVICES) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr,
                                         isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.route(/\/data\/bb\.cfg/, r => r.fulfill({ status: 200, body: cfg() }));
  await page.addInitScript(() => {
    window.__down = {};
    for (const type of ['keydown', 'keyup'])
      window.addEventListener(type, e => {
        if (e.isTrusted) return;
        if (type === 'keydown') window.__down[e.code] = 1; else delete window.__down[e.code];
      }, true);
  });
  await page.goto(url);
  await page.waitForSelector('#start.ready', { timeout: 600000 });
  await page.tap('#overlay');
  await page.waitForFunction(() => document.getElementById('overlay').hidden);
  await page.waitForTimeout(800);
  const m = await page.evaluate(() => {
    const r = el => { const b = el.getBoundingClientRect(); return [b.left, b.top, b.right, b.bottom]; };
    const parts = ['#dpad', '#t-fire', '#t-jump', '#t-special', '#t-menu', '#t-start', '#t-fs', '#rotate']
      .map(s => document.querySelector(s))
      .filter(el => el && !el.hidden && getComputedStyle(el).display !== 'none')
      .map(el => [el.id, r(el)]);
    const view = document.getElementById('view');
    const shownPic = view && !view.hidden ? view : document.getElementById('canvas');
    return { pic: r(shownPic), parts, picId: shownPic.id, k: view ? view.dataset.k : null,
             bw: view ? view.width : 0, bh: view ? view.height : 0, W: innerWidth, H: innerHeight,
             overlap: document.getElementById('touch').classList.contains('overlap'),
             scale: document.getElementById('canvas').dataset.scale,
             shown: !document.getElementById('touch').hidden };
  });
  const label = `${w}x${h}@${dpr}`;
  const [pl, pt, pr, pb] = m.pic;
  const over = m.parts.filter(([id, [l, t, r, b]]) => l < pr - 0.5 && r > pl + 0.5 && t < pb - 0.5 && b > pt + 0.5)
    .map(p => p[0]);
  const off = m.parts.filter(([, [l, t, r, b]]) => l < -0.5 || t < -0.5 || r > m.W + 0.5 || b > m.H + 0.5).map(p => p[0]);
  const size = id => { const p = m.parts.find(q => q[0] === id); return p ? p[1][2] - p[1][0] : 0; };
  const pad = size('dpad'), btn = Math.min(size('t-fire'), size('t-jump'));
  const desc = `picture ${m.pic.map(Math.round)} scale ${m.scale}, pad ${Math.round(pad)}, buttons ${Math.round(btn)}`;
  check(m.shown, `${label}: touch controls shown`);
  if (mayOverlap) {
    check(!over.length || m.overlap, `${label}: controls over the picture only when they cannot fit, and faint`,
          `${desc}; over picture: ${over.join(' ') || 'none'}; faint: ${m.overlap}`);
  } else {
    check(over.length === 0 && !m.overlap && pad >= 88 && btn >= 48,
          `${label}: controls fit outside the picture`, `${desc}; over picture: ${over.join(' ') || 'none'}`);
  }
  check(off.length === 0, `${label}: controls fully on screen`, off.join(' '));
  if (h > w) {
    // Fill the width (4:3) at the top, unless 62% of the height is shorter.
    const dw = Math.round(w * dpr), room = Math.floor(Math.round(h * dpr) * 0.62);
    const ew = Math.min(dw, Math.floor(room * 4 / 3)), eh = Math.round(ew * 3 / 4);
    const pw = (pr - pl) * dpr, ph = (pb - pt) * dpr;
    check(pt <= 1 && Math.abs(pw - ew) < 1.01 && Math.abs(ph - eh) < 1.01,
          `${label}: portrait picture at the top, filling the width (4:3)`,
          `top ${pt}, ${pw.toFixed(1)}x${ph.toFixed(1)} device px, expected ${ew}x${eh}`);
    if (ew % 640 !== 0) {
      const k = Math.ceil(ew / 640);
      check(m.picId === 'view' && +m.k === k && m.bw === 640 * k && m.bh === 480 * k,
            `${label}: non-integer scale shown sharp-bilinear (nearest x${k}, then smooth down)`,
            `shown on #${m.picId}, k ${m.k}, buffer ${m.bw}x${m.bh}`);
    }
  } else {
    check(m.picId === 'canvas', `${label}: landscape keeps the integer-scaled game canvas`, `shown on #${m.picId}`);
  }
  if (out) await page.screenshot({ path: `${out}/layout-${w}x${h}.png` });

  if (w === 844) {
    // One key per direction: P1's 'd', not also the arrow P2 is bound to.
    const r = await page.$eval('#dpad', e => { const b = e.getBoundingClientRect(); return [b.x, b.y, b.width]; });
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart',
      touchPoints: [{ x: r[0] + r[2] * 0.85, y: r[1] + r[2] / 2, id: 1 }] });
    const held = await page.evaluate(() => Object.keys(window.__down).sort());
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    check(held.join() === 'KeyD', 'pad right sends only the player 1 key when player 2 has the arrows',
          held.join() || 'none');
  }
  await Promise.race([ctx.close(), new Promise(r => setTimeout(r, 5000))]);
}

await Promise.race([browser.close(), new Promise(r => setTimeout(r, 5000))]);
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
