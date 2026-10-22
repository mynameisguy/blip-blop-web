// Checks where the touch controls go on common phones and tablets, with
// the game running, in each set of controls (a level, menus, cutscenes):
//   - lying down, the picture fills the screen height (4:3, centred), drawn
//     sharp-bilinear on #view at a non-integer scale; upright, it fills the
//     width at the top, as before;
//   - no control covers the HUD band along the top of the picture (score,
//     lives, health, weapon: its top 100 of 480 rows), and lying down the
//     controls only cover the picture's lower corners (its lower 4/5);
//   - every control is fully on screen and no two controls overlap (the
//     spot between Fire and Jump aside, which is meant to touch both);
//   - Fire, Jump, Special, the menu arrows and Skip are at least 64 px,
//     OK at least 72 px, pause / auto-fire / fullscreen at least 44 px;
//   - Fire and Jump are side by side or diagonal (not one column), and one
//     touch between them presses both;
//   - the stick zone is on the left, below the HUD, and the stick sends ONE
//     key per direction: the player 1 key (so player 2, bound to the arrows
//     here, does not move too).
//
//   node tools/check_touch_layout.mjs <url> [outdir]
// Needs Playwright (npm i playwright); CHROMIUM_PATH picks the browser.
import { chromium } from 'playwright';
import fs from 'node:fs';

const url = process.argv[2] || 'http://localhost:8000/';
const out = process.argv[3] || null;
if (out) fs.mkdirSync(out, { recursive: true });

const DEVICES = [
  // [width, height, devicePixelRatio]
  [844, 390, 3],      // iPhone 12-14 landscape
  [640, 360, 3],      // 16:9 phone
  [740, 360, 4],      // Galaxy S8/S9
  [732, 412, 2.625],  // Pixel
  [915, 412, 2.625],  // Pixel 7
  [568, 320, 2],      // iPhone SE (1st gen)
  [667, 375, 2],      // iPhone 8
  [390, 844, 3],      // portrait
  [360, 740, 4],
  [412, 915, 2.625],
  [375, 667, 2],
  [1024, 768, 2],     // iPad landscape: no margins at all
  [768, 1024, 2],     // iPad portrait
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
const MIN = { 't-fire': 64, 't-jump': 64, 't-special': 64, 't-up': 64, 't-down': 64, 't-left': 64,
              't-right': 64, 't-ok': 72, 't-skip': 64, 't-pause': 44, 't-auto': 44, 't-fs': 44 };
// Surfaces under the buttons, not buttons.
const SURFACES = ['gesture', 'stick-zone', 'stick'];

for (const [w, h, dpr] of DEVICES) {
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
  const label = `${w}x${h}@${dpr}`;
  const cdp = await ctx.newCDPSession(page);
  // The intro runs now; each set of controls is shown in turn by setting the
  // mode the page would set (the game keeps the intro's mode meanwhile).
  for (const mode of ['level', 'menu', 'scene']) {
    await page.evaluate(m => { document.getElementById('touch').dataset.mode = m; }, mode);
    const m = await page.evaluate(() => {
      const r = el => { const b = el.getBoundingClientRect(); return [b.left, b.top, b.right, b.bottom]; };
      const parts = Array.from(document.querySelectorAll('#touch > *'))
        .filter(el => getComputedStyle(el).display !== 'none' && !el.hidden)
        .map(el => [el.id, r(el)]);
      const hint = document.getElementById('rotate');
      if (!hint.hidden) parts.push(['rotate', r(hint)]);
      const view = document.getElementById('view');
      const shownPic = view && !view.hidden ? view : document.getElementById('canvas');
      return { pic: r(shownPic), parts, picId: shownPic.id, k: view ? view.dataset.k : null,
               bw: view ? view.width : 0, bh: view ? view.height : 0, W: innerWidth, H: innerHeight,
               shown: !document.getElementById('touch').hidden };
    });
    const tag = `${label} ${mode}`;
    const [pl, pt, pr, pb] = m.pic;
    const hudBottom = pt + (pb - pt) * 100 / 480;
    const box = id => (m.parts.find(q => q[0] === id) || [0, null])[1];
    const buttons = m.parts.filter(([id]) => !SURFACES.includes(id));
    const hits = (a, b) => a[0] < b[2] - 0.5 && a[2] > b[0] + 0.5 && a[1] < b[3] - 0.5 && a[3] > b[1] + 0.5;
    if (mode === 'level') check(m.shown, `${label}: touch controls shown`);

    // HUD band: nothing over it (surfaces included: the stick zone too).
    const onHud = m.parts.filter(([id, b]) => id !== 'gesture' && id !== 'stick' && hits(b, [pl, pt, pr, hudBottom]))
      .map(p => p[0]);
    check(onHud.length === 0, `${tag}: no control over the HUD band`,
          `picture ${m.pic.map(Math.round)}, HUD to y ${Math.round(hudBottom)}; over it: ${onHud.join(' ') || 'none'}`);
    const off = m.parts.filter(([id, [l, t, r, b]]) => id !== 'gesture' && (l < -0.5 || t < -0.5 || r > m.W + 0.5 || b > m.H + 0.5))
      .map(p => p[0]);
    check(off.length === 0, `${tag}: controls fully on screen`, off.join(' '));
    const pairs = [];
    for (let i = 0; i < buttons.length; i++)
      for (let j = i + 1; j < buttons.length; j++) {
        const a = buttons[i], b = buttons[j];
        if (a[0] === 't-both' || b[0] === 't-both') continue;
        if (hits(a[1], b[1])) pairs.push(`${a[0]}/${b[0]}`);
      }
    check(pairs.length === 0, `${tag}: no two controls overlap`, pairs.join(' ') || '');
    const small = buttons.filter(([id, b]) => MIN[id] && Math.min(b[2] - b[0], b[3] - b[1]) < MIN[id] - 0.5)
      .map(([id, b]) => `${id} ${Math.round(Math.min(b[2] - b[0], b[3] - b[1]))}`);
    const sizes = buttons.filter(([id]) => MIN[id]).map(([id, b]) => `${id.slice(2)} ${Math.round(b[2] - b[0])}`).join(', ');
    check(small.length === 0, `${tag}: buttons big enough`, small.length ? 'too small: ' + small.join(', ') : sizes);
    if (h > w) {
      const under = buttons.filter(([, b]) => b[1] < pb - 0.5).map(p => p[0]);
      check(under.length === 0, `${tag}: upright, every control below the picture`, under.join(' '));
    }

    if (mode === 'level') {
      // Picture.
      if (h > w) {
        const dw = Math.round(w * dpr), room = Math.floor(Math.round(h * dpr) * 0.62);
        const ew = Math.min(dw, Math.floor(room * 4 / 3)), eh = Math.round(ew * 3 / 4);
        const pw = (pr - pl) * dpr, ph = (pb - pt) * dpr;
        check(pt <= 1 && Math.abs(pw - ew) < 1.01 && Math.abs(ph - eh) < 1.01,
              `${label}: upright picture at the top, filling the width (4:3)`,
              `top ${pt}, ${pw.toFixed(1)}x${ph.toFixed(1)} device px, expected ${ew}x${eh}`);
      } else {
        const dw = Math.round(w * dpr), dh = Math.round(h * dpr);
        const ew = Math.min(dw, Math.floor(dh * 4 / 3)), eh = Math.round(ew * 3 / 4);
        const pw = (pr - pl) * dpr, ph = (pb - pt) * dpr;
        // The page keeps the picture on whole CSS pixels that are also whole
        // device pixels, so it may sit up to half such a step off centre.
        let step = 1;
        while (step < 64 && Math.abs(step / dpr - Math.round(step / dpr)) > 1e-3) step++;
        const tol = step / dpr / 2 + 1;
        const centred = Math.abs((pl + pr) / 2 - w / 2) <= tol && Math.abs((pt + pb) / 2 - h / 2) <= tol;
        check(centred && Math.abs(pw - ew) < 1.01 && Math.abs(ph - eh) < 1.01,
              `${label}: lying down, the picture fills the height (4:3, centred)`,
              `${pw.toFixed(1)}x${ph.toFixed(1)} device px at ${Math.round(pl)},${Math.round(pt)}, expected ${ew}x${eh}`);
      }
      const ew = (pr - pl) * dpr;
      if (Math.abs(ew - Math.round(ew / 640) * 640) > 1) {
        const k = Math.ceil((ew - 0.5) / 640);
        check(m.picId === 'view' && +m.k === k && m.bw === 640 * k && m.bh === 480 * k,
              `${label}: non-integer scale shown sharp-bilinear (nearest x${k}, then smooth down)`,
              `shown on #${m.picId}, k ${m.k}, buffer ${m.bw}x${m.bh}`);
      }
      // Fire and Jump.
      const fb = box('t-fire'), jb = box('t-jump');
      const fc = [(fb[0] + fb[2]) / 2, (fb[1] + fb[3]) / 2], jc = [(jb[0] + jb[2]) / 2, (jb[1] + jb[3]) / 2];
      const dist = Math.hypot(fc[0] - jc[0], fc[1] - jc[1]);
      check(fc[0] - jc[0] >= 0.5 * dist - 1, `${label}: Fire and Jump side by side or diagonal, not one column`,
            `Fire centre ${fc.map(Math.round)}, Jump centre ${jc.map(Math.round)}`);
      const mid = { x: (fc[0] + jc[0]) / 2, y: (fc[1] + jc[1]) / 2, id: 7 };
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [mid] });
      const both = await page.evaluate(() => Object.keys(window.__down).sort());
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      const after = await page.evaluate(() => Object.keys(window.__down).length);
      check(both.join() === 'KeyX,Space' && after === 0,
            `${label}: one touch between Fire and Jump presses both, and releases both`,
            `held ${both.join() || 'none'}, still held after release ${after}`);
      // Stick zone: on the left half, below the HUD.
      const z = box('stick-zone');
      check(z && z[2] <= w * 0.5 + 0.5 && z[1] >= hudBottom - 0.5 && z[3] >= h - 0.5,
            `${label}: stick zone on the left, below the HUD, down to the bottom`, z && z.map(Math.round).join(','));
      // The stick, pushed right from where the thumb lands: only P1's 'd'.
      const sx = (z[0] + z[2]) / 2, sy = (z[1] + z[3]) / 2;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: sx, y: sy, id: 1 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: sx + 50, y: sy, id: 1 }] });
      const held = await page.evaluate(() => Object.keys(window.__down).sort());
      const stickAt = await page.evaluate(() => { const b = document.getElementById('stick').getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      const left = await page.evaluate(() => Object.keys(window.__down).length);
      check(held.join() === 'KeyD' && left === 0, `${label}: stick right sends only the player 1 key, released on lift`,
            `held ${held.join() || 'none'}, after lift ${left}`);
      check(Math.hypot(stickAt[0] - sx, stickAt[1] - sy) < 2, `${label}: the stick appears where the thumb lands`,
            `stick centre ${stickAt.map(Math.round)}, touch ${Math.round(sx)},${Math.round(sy)}`);
    }
    if (out) await page.screenshot({ path: `${out}/layout-${w}x${h}-${mode}.png` });
  }
  await Promise.race([ctx.close(), new Promise(r => setTimeout(r, 5000))]);
}

await Promise.race([browser.close(), new Promise(r => setTimeout(r, 5000))]);
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
