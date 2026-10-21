// Drives the browser build with real keyboard events (page.keyboard, not the
// harness input script) and checks that input behaves like the native game:
//   1. keyboard: through the menus into level 1, the player walks right,
//      stops when the key is released (no stuck keys after auto-repeat) or
//      when the window loses focus mid-walk, walks left and jumps; the page
//      does not act on game keys (scrolling, Backspace, quick find).
//   2. player 2: in a two player game, the default P2 keys move Blop only.
//   3. AZERTY: the physical Q key binds as "a" (the layout's key, as native
//      SDL gives), walks the player, and is released when the window loses
//      focus while it is held.
//   4. gamepad: a pad appears after load, when a button is pressed (as
//      browsers only show a pad then), and that press counts. Single presses
//      and stick pushes bind in the keys menu (JOY1 BUTTON0 = 0x400, JOY1
//      RIGHT = 0x467, JOY1 BUTTON1 = 0x401, the native codes), walk and jump
//      in a level, and still do after the pad is unplugged and plugged back
//      in mid-level. No pad input is retried.
//
// Every step waits on the game's state (read from each frame through
// Module.onFrame) and retries a key press the game missed, so it does not
// depend on timing.
//
//   node tools/input_test.mjs <url> [outDir]
// Exits 0 when every check passes. Needs playwright (CHROMIUM_PATH optional).
import {
  setup, check, finish, scenario, screenshot, sleep, newGamePage, hold, holdRepeating, grab, scroll, walked,
  fmt, blurWindow, toMainMenu, startGame, toKeysMenu, keysMenuToStart, menuKey, bind, P1_UP, P1_RIGHT, P1_JUMP,
} from './game_driver.mjs';

const [,, url = 'http://localhost:8000/', outDir] = process.argv;
await setup(url, outDir);

// --- 1. keyboard -------------------------------------------------------------
await scenario('keyboard', async () => {
  const { context, page, errors } = await newGamePage();
  await toMainMenu(page);
  await startGame(page);

  const a = await grab(page, 'kb-1-start');
  await sleep(800);
  const a2 = await grab(page);
  check(!!a2.player, 'player found on screen', JSON.stringify(a2.player));
  check(Math.abs(walked(a, a2)) < 3, 'no movement without input', `moved ${fmt(walked(a, a2))}px`);

  await holdRepeating(page, 'ArrowRight', 1500);
  const b = await grab(page, 'kb-2-after-right');
  check(walked(a2, b) >= 60, 'holding Right (with auto-repeat) walks right', `walked ${fmt(walked(a2, b))}px`);

  await sleep(800);
  const b2 = await grab(page);
  check(Math.abs(walked(b, b2)) < 3, 'player stops when Right is released (no stuck key)', `moved ${fmt(walked(b, b2))}px`);

  await hold(page, 'ArrowLeft', 500);
  await sleep(300);
  const c = await grab(page, 'kb-3-after-left');
  check(walked(b2, c) <= -10, 'holding Left walks left', `walked ${fmt(walked(b2, c))}px`);

  await sleep(500);
  const d0 = await grab(page);
  await page.keyboard.down('Space');    // P1 jump (data/bb.cfg)
  await sleep(250);
  const d1 = await grab(page, 'kb-4-jump');
  await page.keyboard.up('Space');
  const dy = d1.player && d0.player ? d1.player.y - d0.player.y : NaN;
  check(dy <= -10, 'Space jumps', `player y ${fmt(d0.player?.y)} -> ${fmt(d1.player?.y)}`);

  // Focus lost while a key is held: the key must not stay down.
  await sleep(800);
  await page.keyboard.down('ArrowRight');
  await sleep(400);
  const e0 = await grab(page);
  await blurWindow(page);
  await sleep(300);
  const e1 = await grab(page);
  await sleep(1000);
  const e2 = await grab(page, 'kb-5-after-blur');
  await page.keyboard.up('ArrowRight');
  check(Math.abs(walked(e1, e2)) < 3, 'player stops when the window loses focus while Right is held',
    `moved ${fmt(walked(e1, e2))}px in the second after the blur (${fmt(walked(e0, e1))}px around it)`);

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

  const a = await grab(page, 'p2-1-start');
  check(!!a.player && !!a.blop, 'both players found on screen', JSON.stringify({ blip: a.player, blop: a.blop }));
  await hold(page, 'f', 800);           // P2 right (data/bb.cfg: Q S D F, Tab, G, H)
  await sleep(300);
  const b = await grab(page, 'p2-2-after-f');
  const blopDx = b.blop && a.blop ? b.blop.x - a.blop.x + scroll(a, b) : NaN;
  const blipDx = b.player && a.player ? b.player.x - a.player.x + scroll(a, b) : NaN;
  check(blopDx >= 30, 'F walks player 2 right', `Blop moved ${fmt(blopDx)}px`);
  check(Math.abs(blipDx) < 5, 'F does not move player 1', `Blip moved ${fmt(blipDx)}px`);
  await hold(page, 'd', 500);           // P2 left
  await sleep(300);
  const c = await grab(page, 'p2-3-after-d');
  const blopDx2 = c.blop && b.blop ? c.blop.x - b.blop.x + scroll(b, c) : NaN;
  check(blopDx2 <= -15, 'D walks player 2 left', `Blop moved ${fmt(blopDx2)}px`);
  check(errors.length === 0, 'no page errors in a two player game', errors.join(' | '));
  await context.close();
});

// --- 3. AZERTY ---------------------------------------------------------------
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

  const a = await grab(page);
  await down();
  await sleep(600);
  const b = await grab(page);
  check(walked(a, b) >= 30, 'AZERTY: holding physical Q ("a" = P1 RIGHT) walks right', `walked ${fmt(walked(a, b))}px`);
  await blurWindow(page);
  await sleep(300);
  const c = await grab(page);
  await sleep(1000);
  const d = await grab(page, 'az-2-after-blur');
  check(Math.abs(walked(c, d)) < 3, 'AZERTY: player stops when the window loses focus while "a" is held',
    `moved ${fmt(walked(c, d))}px in the second after the blur`);
  await up();                           // the real release, after the blur
  await sleep(300);
  const e = await grab(page);
  await down();
  await sleep(600);
  await up();
  await sleep(200);
  const f = await grab(page);
  check(walked(e, f) >= 30, 'AZERTY: the key works again after the blur', `walked ${fmt(walked(e, f))}px`);
  check(errors.length === 0, 'no page errors (AZERTY)', errors.join(' | '));
  await context.close();
});

// --- 4. gamepad --------------------------------------------------------------
// Strict: every pad press or push below happens once, with no retry.
await scenario('gamepad', async () => {
  // A standard-mapping pad the page cannot see until bbPadConnect(), as a
  // browser only shows a pad once a button is pressed after load. Each
  // connect is a new pad object, as after unplugging and plugging back.
  const fakePad = () => {
    let pad = null;
    let ts = 1;
    navigator.getGamepads = () => [pad, null, null, null];
    const send = (type, p) => { const e = new Event(type); e.gamepad = p; window.dispatchEvent(e); };
    // pressed: the button whose press made the browser show the pad.
    window.bbPadConnect = pressed => {
      pad = {
        id: 'Simulated pad (STANDARD GAMEPAD Vendor: 045e Product: 028e with a long browser name)',
        index: 0, connected: true, mapping: 'standard', timestamp: ts++, axes: [0, 0, 0, 0],
        buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: i === pressed, touched: i === pressed, value: i === pressed ? 1 : 0 })),
      };
      send('gamepadconnected', pad);
    };
    window.bbPadDisconnect = () => { const p = pad; pad = null; p.connected = false; send('gamepaddisconnected', p); };
    window.bbPadButton = (i, down) => {
      pad.buttons[i] = { pressed: down, touched: down, value: down ? 1 : 0 };
      pad.timestamp = ts++;
    };
    window.bbPadAxis = (i, v) => { pad.axes[i] = v; pad.timestamp = ts++; };
  };
  const { context, page, errors } = await newGamePage({ initScripts: [fakePad] });
  const pad = (fn, ...args) => page.evaluate(([fn, args]) => window[fn](...args), [fn, args]);
  const button = async (i, ms = 150) => { await pad('bbPadButton', i, true); await sleep(ms); await pad('bbPadButton', i, false); };
  const stick = async ms => { await pad('bbPadAxis', 0, 1); await sleep(ms); await pad('bbPadAxis', 0, 0); };
  // Presses the jump button once and measures the player's rise.
  const jump = async name => {
    await sleep(1200);                  // back on the ground
    const a = await grab(page);
    await pad('bbPadButton', 1, true);
    await sleep(250);
    const b = await grab(page, name);
    await pad('bbPadButton', 1, false);
    return a.player && b.player ? b.player.y - a.player.y : NaN;
  };
  const walk = async name => {
    await sleep(500);
    const a = await grab(page);
    await stick(1200);
    const b = await grab(page, name);
    return walked(a, b);
  };

  await toMainMenu(page);
  await toKeysMenu(page);
  // The press that makes the browser show the pad binds UP.
  const up = await bind(page, P1_UP, async () => {
    await pad('bbPadConnect', 0);
    await sleep(150);
    await pad('bbPadButton', 0, false);
  }, 0x400, 'UP', 1);
  check(up === 0x400, 'the button press that connects the pad binds UP as JOY1 BUTTON0 (0x400)', '0x' + up.toString(16));

  for (let i = 0; i < 3; i++) await menuKey(page, 'ArrowDown', 'RIGHT');
  const right = await bind(page, P1_RIGHT, () => stick(150), 0x400 + 103, 'RIGHT', 1);
  check(right === 0x467, 'the first stick push binds RIGHT as JOY1 RIGHT (0x467)', '0x' + right.toString(16));

  for (let i = 0; i < 2; i++) await menuKey(page, 'ArrowDown', 'JUMP');
  const jumpCode = await bind(page, P1_JUMP, () => button(1), 0x401, 'JUMP', 1);
  await screenshot(page, 'pad-1-keys-menu');
  check(jumpCode === 0x401, 'one press of button 1 binds JUMP as JOY1 BUTTON1 (0x401)', '0x' + jumpCode.toString(16));

  await keysMenuToStart(page, 5);
  await startGame(page);
  const w1 = await walk('pad-2-after-stick');
  check(w1 >= 60, 'pushing the stick right walks the player right', `walked ${fmt(w1)}px`);
  await sleep(300);
  const c = await grab(page);
  await sleep(600);
  const d = await grab(page);
  check(Math.abs(walked(c, d)) < 3, 'player stops when the stick is released', `moved ${fmt(walked(c, d))}px`);
  const j1 = await jump('pad-3-jump');
  check(j1 <= -10, 'button 1 jumps', `player rose ${fmt(-j1)}px`);

  await pad('bbPadDisconnect');
  const f0 = await page.evaluate(() => window.bbFrames);
  await sleep(1000);
  const f1 = await page.evaluate(() => window.bbFrames);
  check(f1 - f0 > 20, 'the game keeps running after the pad is unplugged', `${f1 - f0} frames in 1 s`);

  // Plugged back in mid-level by pressing the jump button: that press jumps.
  await sleep(1200);
  const a = await grab(page);
  await pad('bbPadConnect', 1);
  await sleep(250);
  const b = await grab(page, 'pad-4-reconnect-jump');
  await pad('bbPadButton', 1, false);
  const j2 = a.player && b.player ? b.player.y - a.player.y : NaN;
  check(j2 <= -10, 'after a reconnect, the press that connects the pad jumps', `player rose ${fmt(-j2)}px`);
  const w2 = await walk('pad-5-reconnect-stick');
  check(w2 >= 60, 'after a reconnect, the first stick push walks', `walked ${fmt(w2)}px`);
  const j3 = await jump();
  check(j3 <= -10, 'after a reconnect, one press of button 1 jumps', `player rose ${fmt(-j3)}px`);
  check(errors.length === 0, 'no page errors with a gamepad', errors.join(' | '));
  await context.close();
});

await finish();
