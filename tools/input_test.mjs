// Drives the browser build with real keyboard events (page.keyboard, not the
// harness input script) and checks that input behaves like the native game:
//   1. keyboard: through the menus into level 1, the player walks right,
//      stops when the key is released (no stuck keys after auto-repeat) or
//      when the window loses focus mid-walk, walks left and jumps; the page
//      does not act on game keys (scrolling, Backspace, quick find).
//   2. player 2: in a two player game, the default P2 keys move Blop only.
//   3. P2 keys menu: opening it and moving through it binds nothing.
//   4. AZERTY: the physical Q key binds as "a" (the layout's key, as native
//      SDL gives), walks the player, and is released when the window loses
//      focus while it is held.
//   5. gamepad: a pad appears after load, when a button is pressed (as
//      browsers only show a pad then), and that press counts. Single presses
//      and stick pushes bind in the keys menu (JOY1 BUTTON0 = 0x400, JOY1
//      RIGHT = 0x467, JOY1 BUTTON1 = 0x401, the native codes), walk and jump
//      in a level, and still do after the pad is unplugged and plugged back
//      in mid-level. No pad input is retried.
//   6. two pads: pad 0 drives player 1 and pad 1 player 2 (JOY2 = 0x800),
//      and after a reload each pad keeps its player whichever is pressed
//      first.
//
// Every step waits on the game's state (read from each frame through
// Module.onFrame) and retries a key press the game missed, so it does not
// depend on timing. Movement is measured from many small frame steps.
//
//   node tools/input_test.mjs <url> [outDir]
// Exits 0 when every check passes. Needs playwright (CHROMIUM_PATH optional).
import {
  setup, check, finish, scenario, screenshot, sleep, pause, newGamePage, waitStarted, hold, holdRepeating, track, still,
  fmt, grab, blurWindow, toMainMenu, startGame, toKeysMenu, keysMenuToStart, menuKey, bind, P1_UP, P1_RIGHT, P1_JUMP,
  P2_RIGHT,
} from './game_driver.mjs';

const [,, url = 'http://localhost:8000/', outDir] = process.argv;
await setup(url, outDir);

// --- 1. keyboard -------------------------------------------------------------
await scenario('keyboard', async () => {
  const { context, page, errors } = await newGamePage();
  await toMainMenu(page);
  await startGame(page);
  await screenshot(page, 'kb-1-start');

  const idle = await still(page);
  check(Math.abs(idle) < 5, 'no movement without input', `moved ${fmt(idle)}px`);

  const right = await track(page, 1700, () => holdRepeating(page, 'ArrowRight', 1500));
  await screenshot(page, 'kb-2-after-right');
  check(right.moved >= 60, 'holding Right (with auto-repeat) walks right', `walked ${fmt(right.moved)}px`);
  const stop = await still(page);
  check(Math.abs(stop) < 5, 'player stops when Right is released (no stuck key)', `moved ${fmt(stop)}px`);

  const left = await track(page, 800, () => hold(page, 'ArrowLeft', 500));
  check(left.moved <= -10, 'holding Left walks left', `walked ${fmt(left.moved)}px`);

  await sleep(800);
  const jump = await track(page, 700, () => hold(page, 'Space', 250));   // P1 jump (data/bb.cfg)
  check(jump.rise >= 10, 'Space jumps', `rose ${fmt(jump.rise)}px`);

  // Focus lost while a key is held: the key must not stay down.
  await sleep(800);
  await page.keyboard.down('ArrowRight');
  await sleep(400);
  await blurWindow(page);
  const afterBlur = await still(page);
  await page.keyboard.up('ArrowRight');
  check(Math.abs(afterBlur) < 5, 'player stops when the window loses focus while Right is held',
    `moved ${fmt(afterBlur)}px after the blur`);

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
  check(page.url().startsWith(url), 'page did not navigate', page.url());

  check(errors.length === 0, 'no page errors without a gamepad', errors.join(' | '));
  await context.close();
});

// --- 2. player 2 default keys ------------------------------------------------
await scenario('player 2', async () => {
  const { context, page, errors } = await newGamePage();
  await toMainMenu(page);
  await startGame(page, 2);
  const g = (await track(page, 0)).first;
  await screenshot(page, 'p2-1-start');
  check(!!g.player && !!g.blop, 'both players found on screen', JSON.stringify({ blip: g.player, blop: g.blop }));

  const f = await track(page, 1100, () => hold(page, 'f', 800));   // P2 right (data/bb.cfg: Q S D F, Tab, G, H)
  check(f.blopMoved >= 30, 'F walks player 2 right', `Blop moved ${fmt(f.blopMoved)}px`);
  check(Math.abs(f.drift) < 5, 'F does not move player 1', `Blip moved ${fmt(f.drift)}px`);
  const d = await track(page, 800, () => hold(page, 'd', 500));    // P2 left
  check(d.blopMoved <= -15, 'D walks player 2 left', `Blop moved ${fmt(d.blopMoved)}px`);
  check(errors.length === 0, 'no page errors in a two player game', errors.join(' | '));
  await context.close();
});

// --- 3. P2 keys menu ---------------------------------------------------------
const cfgBytes = page => page.evaluate(() => Array.from(Module.FS.readFile('/data/bb.cfg')));
await scenario('P2 keys menu', async () => {
  const { context, page, errors } = await newGamePage();
  const before = await cfgBytes(page);
  await toMainMenu(page);
  await toKeysMenu(page, 2);
  await screenshot(page, 'p2menu-1-open');
  for (let i = 0; i < 7; i++) await menuKey(page, 'ArrowDown', `entry ${i + 1}`);
  await screenshot(page, 'p2menu-2-return');
  await menuKey(page, 'Enter', 'the main menu');
  const after = await cfgBytes(page);
  check(JSON.stringify(after) === JSON.stringify(before),
    'opening the P2 keys menu and moving through it binds nothing',
    after.map((v, i) => (v !== before[i] ? `byte ${i}: ${before[i]} -> ${v}` : null)).filter(Boolean).join(', '));
  check(errors.length === 0, 'no page errors (P2 keys menu)', errors.join(' | '));
  await context.close();
});

// --- 4. AZERTY ---------------------------------------------------------------
await scenario('AZERTY', async () => {
  const { context, page, errors } = await newGamePage();
  // Playwright's keyboard is QWERTY only, so send AZERTY events through CDP:
  // the key in the QWERTY "Q" position types "a".
  const cdp = await context.newCDPSession(page);
  const azertyA = { code: 'KeyQ', key: 'a', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 };
  const down = () => cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: 'a', ...azertyA });
  const up = () => cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...azertyA });

  await toMainMenu(page);
  await toKeysMenu(page);
  for (let i = 0; i < 3; i++) await menuKey(page, 'ArrowDown', 'RIGHT');
  const code = await bind(page, P1_RIGHT, async () => { await down(); await sleep(150); await up(); },
    'a'.charCodeAt(0), 'RIGHT');
  await screenshot(page, 'az-1-keys-menu');
  check(code === 'a'.charCodeAt(0), 'AZERTY: physical Q key binds as "a" (layout key, like native SDL)', '0x' + code.toString(16));
  await keysMenuToStart(page, 3);
  await startGame(page);

  const walk = await track(page, 800, async () => { await down(); await sleep(600); });
  check(walk.moved >= 30, 'AZERTY: holding physical Q ("a" = P1 RIGHT) walks right', `walked ${fmt(walk.moved)}px`);
  await blurWindow(page);                // "a" still physically held
  const afterBlur = await still(page);
  check(Math.abs(afterBlur) < 5, 'AZERTY: player stops when the window loses focus while "a" is held',
    `moved ${fmt(afterBlur)}px after the blur`);
  await up();                           // the real release, after the blur
  await sleep(300);
  const again = await track(page, 900, async () => { await down(); await sleep(600); await up(); });
  check(again.moved >= 30, 'AZERTY: the key works again after the blur', `walked ${fmt(again.moved)}px`);
  check(errors.length === 0, 'no page errors (AZERTY)', errors.join(' | '));
  await context.close();
});

// Simulated standard-mapping pads, invisible to the page until connected,
// as a browser only shows a pad once a button is pressed after load. Each
// connect is a new pad object, as after unplugging and plugging back.
const fakePads = () => {
  const pads = [null, null, null, null];
  let ts = 1;
  navigator.getGamepads = () => pads.slice();
  const send = (type, p) => { const e = new Event(type); e.gamepad = p; window.dispatchEvent(e); };
  window.bbPad = {
    // pressed: the button whose press made the browser show the pad.
    connect(i, pressed = -1) {
      pads[i] = {
        id: `Simulated pad ${i} (STANDARD GAMEPAD Vendor: 045e Product: 028e with a long browser name)`,
        index: i, connected: true, mapping: 'standard', timestamp: ts++, axes: [0, 0, 0, 0],
        buttons: Array.from({ length: 17 }, (_, b) => ({ pressed: b === pressed, touched: b === pressed, value: b === pressed ? 1 : 0 })),
      };
      send('gamepadconnected', pads[i]);
    },
    disconnect(i) { const p = pads[i]; pads[i] = null; p.connected = false; send('gamepaddisconnected', p); },
    button(i, b, down) { pads[i].buttons[b] = { pressed: down, touched: down, value: down ? 1 : 0 }; pads[i].timestamp = ts++; },
    axis(i, a, v) { pads[i].axes[a] = v; pads[i].timestamp = ts++; },
  };
};
const padCall = (page, fn, ...args) => page.evaluate(([fn, args]) => window.bbPad[fn](...args), [fn, args]);

// Waits until the latest change reached IndexedDB (the page counts syncs).
async function waitSaved(page) {
  const n = await page.evaluate(() => window.bbSaves);
  if (n === 0) await page.waitForFunction(() => window.bbSaves > 0, null, { timeout: 10000 });
  await page.waitForFunction(() => !bbSyncing, null, { timeout: 10000 });
}

// --- 5. gamepad --------------------------------------------------------------
// Strict: every pad press or push below happens once, with no retry.
await scenario('gamepad', async () => {
  const { context, page, errors } = await newGamePage({ initScripts: [fakePads] });
  const pad = (fn, ...args) => padCall(page, fn, 0, ...args);
  const stick = async ms => { await pad('axis', 0, 1); await pause(page, ms); await pad('axis', 0, 0); };

  await toMainMenu(page);
  await toKeysMenu(page);
  // The press that makes the browser show the pad binds UP.
  const up = await bind(page, P1_UP, async () => {
    await pad('connect', 0);
    await pause(page, 150);
    await pad('button', 0, false);
  }, 0x400, 'UP', 1);
  check(up === 0x400, 'the button press that connects the pad binds UP as JOY1 BUTTON0 (0x400)', '0x' + up.toString(16));

  for (let i = 0; i < 3; i++) await menuKey(page, 'ArrowDown', 'RIGHT');
  const right = await bind(page, P1_RIGHT, () => stick(150), 0x400 + 103, 'RIGHT', 1);
  check(right === 0x467, 'the first stick push binds RIGHT as JOY1 RIGHT (0x467)', '0x' + right.toString(16));

  for (let i = 0; i < 2; i++) await menuKey(page, 'ArrowDown', 'JUMP');
  const jumpCode = await bind(page, P1_JUMP, async () => {
    await pad('button', 1, true); await pause(page, 150); await pad('button', 1, false);
  }, 0x401, 'JUMP', 1);
  await screenshot(page, 'pad-1-keys-menu');
  check(jumpCode === 0x401, 'one press of button 1 binds JUMP as JOY1 BUTTON1 (0x401)', '0x' + jumpCode.toString(16));

  await keysMenuToStart(page, 5);
  await startGame(page);
  const jumpOnce = async () => {
    await sleep(1200);                  // back on the ground
    return track(page, 1000, async () => { await pad('button', 1, true); await pause(page, 250); await pad('button', 1, false); });
  };

  const w1 = await track(page, 1400, () => stick(1200));
  check(w1.moved >= 60, 'pushing the stick right walks the player right', `walked ${fmt(w1.moved)}px`);
  const s1 = await still(page);
  check(Math.abs(s1) < 5, 'player stops when the stick is released', `moved ${fmt(s1)}px`);
  const j1 = await jumpOnce();
  check(j1.rise >= 10, 'button 1 jumps', `rose ${fmt(j1.rise)}px`);

  await pad('disconnect');
  const f0 = await page.evaluate(() => window.bbFrames);
  await sleep(1000);
  const f1 = await page.evaluate(() => window.bbFrames);
  check(f1 - f0 > 20, 'the game keeps running after the pad is unplugged', `${f1 - f0} frames in 1 s`);

  // Plugged back in mid-level by pressing the jump button: that press jumps.
  await sleep(1200);
  const j2 = await track(page, 1000, async () => { await pad('connect', 1); await pause(page, 250); await pad('button', 1, false); });
  check(j2.rise >= 10, 'after a reconnect, the press that connects the pad jumps', `rose ${fmt(j2.rise)}px (Blip seen in ${j2.seen} samples)`);
  await sleep(800);
  const w2 = await track(page, 1400, () => stick(1200));
  check(w2.moved >= 60, 'after a reconnect, the first stick push walks', `walked ${fmt(w2.moved)}px`);
  const j3 = await jumpOnce();
  check(j3.rise >= 10, 'after a reconnect, one press of button 1 jumps', `rose ${fmt(j3.rise)}px`);
  check(errors.length === 0, 'no page errors with a gamepad', errors.join(' | '));
  await context.close();
});

// Blop can end up behind a foreground bush (or Blip): walks him left with
// P2 LEFT (D) until he is in view, so the next check can see him stay put.
async function showBlop(page) {
  for (let i = 0; i < 6; i++) {
    const g = await grab(page);
    if (g.blop && (!g.player || Math.abs(g.blop.x - g.player.x) > 60)) break;
    await hold(page, 'd', 300);
    await sleep(500);
  }
  await sleep(700);
}

// --- 6. two pads -------------------------------------------------------------
await scenario('two pads', async () => {
  // Saves on (fresh profile), so the bindings survive the reload below.
  const { context, page, errors } = await newGamePage({ initScripts: [fakePads], persist: true });
  const press = async (i, b, ms = 150) => {
    await padCall(page, 'button', i, b, true); await pause(page, ms); await padCall(page, 'button', i, b, false);
  };
  await toMainMenu(page);
  await toKeysMenu(page, 1);
  for (let i = 0; i < 3; i++) await menuKey(page, 'ArrowDown', 'RIGHT');
  const r1 = await bind(page, P1_RIGHT, async () => {
    await padCall(page, 'connect', 0, 0); await pause(page, 150); await padCall(page, 'button', 0, 0, false);
  }, 0x400, 'P1 RIGHT', 1);
  check(r1 === 0x400, 'pad 0 button 0 binds P1 RIGHT as JOY1 BUTTON0 (0x400)', '0x' + r1.toString(16));
  // Reload (the binding is saved) for fresh menus; the page then sees no
  // pad until one is pressed again, as in a real browser.
  await waitSaved(page);
  await page.reload();
  await waitStarted(page, errors);
  await toMainMenu(page);
  await toKeysMenu(page, 2);
  for (let i = 0; i < 3; i++) await menuKey(page, 'ArrowDown', 'RIGHT');
  const r2 = await bind(page, P2_RIGHT, async () => {
    await padCall(page, 'connect', 1, 0); await pause(page, 150); await padCall(page, 'button', 1, 0, false);
  }, 0x800, 'P2 RIGHT', 1);
  await screenshot(page, 'pads-1-p2-keys-menu');
  check(r2 === 0x800, 'pad 1 button 0 binds P2 RIGHT as JOY2 BUTTON0 (0x800)', '0x' + r2.toString(16));
  await waitSaved(page);
  await keysMenuToStart(page, 3);
  await startGame(page, 2);

  const a = await track(page, 1100, () => press(1, 0, 800));
  check(a.blopMoved >= 30 && Math.abs(a.drift) < 5, 'pad 1 walks player 2 only',
    `Blop ${fmt(a.blopMoved)}px, Blip ${fmt(a.drift)}px`);
  await showBlop(page);
  const b = await track(page, 1100, async () => {
    await padCall(page, 'connect', 0, 0); await pause(page, 800); await padCall(page, 'button', 0, 0, false);
  });
  check(b.moved >= 30 && Math.abs(b.blopDrift) < 5, 'pad 0 (connected second) walks player 1 only',
    `Blip ${fmt(b.moved)}px, Blop ${fmt(b.blopDrift)}px`);

  // After a reload the pads come back in the opposite order (pad 1 first).
  await page.reload();
  await waitStarted(page, errors);
  await toMainMenu(page);
  await startGame(page, 2);
  await screenshot(page, 'pads-2-after-reload');
  const c = await track(page, 1100, async () => {
    await padCall(page, 'connect', 1, 0); await pause(page, 800); await padCall(page, 'button', 1, 0, false);
  });
  check(c.blopMoved >= 30 && Math.abs(c.drift) < 5, 'after a reload, pad 1 pressed first still drives player 2',
    `Blop ${fmt(c.blopMoved)}px, Blip ${fmt(c.drift)}px`);
  await showBlop(page);
  const d = await track(page, 1100, async () => {
    await padCall(page, 'connect', 0, 0); await pause(page, 800); await padCall(page, 'button', 0, 0, false);
  });
  check(d.moved >= 30 && Math.abs(d.blopDrift) < 5, 'and pad 0 pressed second drives player 1',
    `Blip ${fmt(d.moved)}px, Blop ${fmt(d.blopDrift)}px`);
  check(errors.length === 0, 'no page errors with two pads', errors.join(' | '));
  await context.close();
});

await finish();
