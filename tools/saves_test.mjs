// Checks that settings (data/bb.cfg) and hi-scores (data/bb.scr) survive a
// page reload in the browser build, as they survive a restart natively.
//   1. settings: with real key presses, turn VSYNC off and bind P1 UP to W
//      in the options menu, reload, and check the game came back with both
//      (the file, and the keys menu drawn the same as before the reload).
//   2. hi-scores: put a hi-score table in the browser's save storage,
//      reload, and check the game loaded it (it saves the same table back
//      when the page is hidden) and that a fresh profile does not have it.
//   3. bad storage: wrong-size, empty, random and directory entries in the
//      save storage, and the database deleted while the game runs. The game
//      must start, fall back to the shipped files where needed, and save
//      again afterwards.
//
//   node tools/saves_test.mjs <url> [outDir]
// Exits 0 when every check passes. Needs playwright (CHROMIUM_PATH optional).
import {
  setup, check, finish, scenario, screenshot, sleep, newGamePage, waitStarted, waitState, menuKey, bind,
  toMainMenu, toKeysMenu, P1_UP, StepError,
} from './game_driver.mjs';

const [,, url = 'http://localhost:8000/', outDir] = process.argv;
await setup(url, outDir);

const SDLK_UP = 0x40000052;

// vsync flag and P1 UP key from the game's config file.
const readConfig = page => page.evaluate(() => {
  const d = Module.FS.readFile('/data/bb.cfg');
  const v = new DataView(d.buffer, d.byteOffset, d.length);
  return { size: d.length, vsync: d[0], p1up: d.length >= 10 ? v.getUint32(6, true) : null };
});
const readFile = (page, path) => page.evaluate(p => Array.from(Module.FS.readFile(p)), path);
const saves = page => page.evaluate(() => window.bbSaves);

async function waitSaves(page, n, what) {
  const end = Date.now() + 10000;
  while (await saves(page) < n) {
    if (Date.now() > end) throw new StepError(`${what}: no save reached IndexedDB within 10 s`);
    await sleep(100);
  }
}

// Shows the latest menu frame: waits for a few frames after the last change.
async function settledShot(page, name) {
  const s = await waitState(page, s => s.title, 5000);
  await waitState(page, t => t.frame > s.frame + 5, 3000);
  return screenshot(page, name);
}

async function reload(page, errors) {
  await page.reload();
  await waitStarted(page, errors);
}

// Hiding the page makes the game save both files (web/pre.js).
async function hidePage(page) {
  const n = await saves(page);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    delete document.visibilityState;
  });
  await waitSaves(page, n + 1, 'hiding the page');
}

// --- 1. settings -------------------------------------------------------------
let shippedScores;
await scenario('settings', async () => {
  const { context, page, errors } = await newGamePage({ persist: true });
  const before = await readConfig(page);
  check(before.vsync === 1 && before.p1up === SDLK_UP, 'first visit uses the shipped config', JSON.stringify(before));
  shippedScores = await readFile(page, '/data/bb.scr');

  await toMainMenu(page);
  await menuKey(page, 'ArrowDown', 'OPTIONS');
  await menuKey(page, 'Enter', 'the options menu');
  await menuKey(page, 'ArrowRight', 'VSYNC OFF');
  await menuKey(page, 'ArrowDown', 'TOGGLE FULLSCREEN');
  await menuKey(page, 'ArrowDown', 'PLAYER 1 CONTROL');
  await menuKey(page, 'Enter', 'the P1 keys menu');
  const fresh = await settledShot(page, 'saves-1-keys-default');
  const code = await bind(page, P1_UP, async () => {
    await page.keyboard.down('w'); await sleep(150); await page.keyboard.up('w');
  }, 'w'.charCodeAt(0), 'UP');
  check(code === 'w'.charCodeAt(0), 'W binds to P1 UP', '0x' + code.toString(16));
  await waitSaves(page, 2, 'menu changes');
  const edited = await settledShot(page, 'saves-2-keys-edited');
  const after = await readConfig(page);
  check(after.vsync === 0 && after.p1up === 'w'.charCodeAt(0), 'menu changes are written to data/bb.cfg',
    JSON.stringify(after));
  check(await saves(page) >= 2, 'changes were flushed to IndexedDB', `${await saves(page)} syncs`);

  await reload(page, errors);
  const reloaded = await readConfig(page);
  check(reloaded.vsync === 0 && reloaded.p1up === 'w'.charCodeAt(0), 'settings survive a reload',
    JSON.stringify(reloaded));
  await toMainMenu(page);
  await toKeysMenu(page);
  const shown = await settledShot(page, 'saves-3-keys-after-reload');
  check(shown.equals(edited), 'after the reload the keys menu shows UP = W, as before it');
  check(!shown.equals(fresh), 'and differs from the default keys menu');
  check(errors.length === 0, 'no page errors', errors.join(' | '));
  await context.close();
});

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

// Writes entries straight into the save storage (IDBFS mounted at BB_SAVE_DIR in web/pre.js):
// name -> byte array, or 'dir' for a directory.
async function store(page, entries) {
  await page.evaluate(entries => new Promise((resolve, reject) => {
    const FS = Module.FS;
    for (const [name, data] of Object.entries(entries)) {
      const path = BB_SAVE_DIR + '/' + name;
      try { FS.unlink(path); } catch (e) { /* none */ }
      if (data === 'dir') { FS.mkdir(path); FS.writeFile(path + '/x', 'x'); } else FS.writeFile(path, new Uint8Array(data));
    }
    FS.syncfs(false, e => (e ? reject(e) : resolve()));
  }), entries);
}

await scenario('hi-scores', async () => {
  const table = Array.from({ length: 10 }, (_, i) => [900000 - i * 1000, 'SAVES TEST ' + i]);
  const crafted = encodeScores(table);
  const { context, page, errors } = await newGamePage({ persist: true });
  const shipped = await readFile(page, '/data/bb.scr');
  check(JSON.stringify(shipped) !== JSON.stringify(crafted), 'test table differs from the shipped one');
  await store(page, { 'bb.scr': crafted });
  await reload(page, errors);
  const loaded = await readFile(page, '/data/bb.scr');
  check(JSON.stringify(loaded) === JSON.stringify(crafted), 'saved hi-scores replace the shipped file before main()');
  // The game saves its in-memory table when the page is hidden: the same
  // bytes only if it accepted the stored file (a bad checksum resets it).
  await page.evaluate(() => Module.FS.writeFile('/data/bb.scr', new Uint8Array(244)));
  await hidePage(page);
  const resaved = await readFile(page, '/data/bb.scr');
  check(JSON.stringify(resaved) === JSON.stringify(crafted), 'the game loaded that table (saved back on hide)');
  check(errors.length === 0, 'no page errors', errors.join(' | '));
  await context.close();

  // A different profile (new context) starts from the shipped files.
  const other = await newGamePage({ persist: true });
  const cfg = await readConfig(other.page);
  const scr = await readFile(other.page, '/data/bb.scr');
  check(cfg.p1up === SDLK_UP && JSON.stringify(scr) === JSON.stringify(shipped),
    'a new browser profile starts from the shipped files');
  await other.context.close();
});

// --- 3. bad storage ----------------------------------------------------------
const random = n => Array.from({ length: n }, () => (Math.random() * 256) | 0);
const cases = {
  'wrong sizes': { 'bb.cfg': random(10), 'bb.scr': random(5000) },
  'empty files': { 'bb.cfg': [], 'bb.scr': [] },
  'directories': { 'bb.cfg': 'dir', 'bb.scr': 'dir' },
  'random bytes of the right size': { 'bb.cfg': random(62), 'bb.scr': random(244) },
};
for (const [name, entries] of Object.entries(cases)) {
  await scenario(`bad storage (${name})`, async () => {
    const { context, page, errors } = await newGamePage({ persist: true });
    const shippedCfg = await readFile(page, '/data/bb.cfg');
    await store(page, entries);
    await reload(page, errors);
    const cfg = await readFile(page, '/data/bb.cfg');
    const scr = await readFile(page, '/data/bb.scr');
    if (name === 'random bytes of the right size') {
      // Same size as a real save: loaded as is, like a damaged file natively.
      // The hi-score checksum fails, so the game uses its default table.
      check(JSON.stringify(cfg) === JSON.stringify(entries['bb.cfg']), `${name}: the stored config is loaded as is`);
    } else {
      check(JSON.stringify(cfg) === JSON.stringify(shippedCfg) && JSON.stringify(scr) === JSON.stringify(shippedScores),
        `${name}: the game falls back to the shipped files`);
    }
    // Menus still work (they also take the arrow keys and Return directly).
    await toMainMenu(page);
    await menuKey(page, 'ArrowDown', 'OPTIONS');
    check(true, `${name}: the game starts and its menus respond`);
    // The next save replaces the bad entries with real files.
    await hidePage(page);
    const kinds = await page.evaluate(() => ['bb.cfg', 'bb.scr'].map(n => {
      const s = Module.FS.stat(BB_SAVE_DIR + '/' + n);
      return Module.FS.isFile(s.mode) ? s.size : 'not a file';
    }));
    check(kinds[0] === 62 && kinds[1] === 244, `${name}: the next save writes proper files`, JSON.stringify(kinds));
    await reload(page, errors);
    check(errors.length === 0, `${name}: no page errors`, errors.join(' | '));
    await context.close();
  });
}

await scenario('database deleted while running', async () => {
  const { context, page, errors } = await newGamePage({ persist: true });
  // Our open connection must not block the deletion.
  const outcome = await page.evaluate(() => new Promise(resolve => {
    const req = indexedDB.deleteDatabase(BB_SAVE_DIR);
    req.onsuccess = () => resolve('deleted');
    req.onerror = () => resolve('error');
    req.onblocked = () => resolve('blocked');
  }));
  check(outcome === 'deleted', 'the save database can be deleted while the game runs', outcome);
  await toMainMenu(page);
  await menuKey(page, 'ArrowDown', 'OPTIONS');
  await menuKey(page, 'Enter', 'the options menu');
  const n = await saves(page);
  await menuKey(page, 'ArrowRight', 'VSYNC OFF');
  await waitSaves(page, n + 1, 'a change after the deletion');
  await reload(page, errors);
  const cfg = await readConfig(page);
  check(cfg.vsync === 0, 'a change made after the deletion is saved and survives a reload', JSON.stringify(cfg));
  check(errors.length === 0, 'no page errors', errors.join(' | '));
  await context.close();
});

await scenario('malformed database records', async () => {
  const { context, page, errors } = await newGamePage({ persist: true });
  // A good save (VSYNC off) next to records IDBFS cannot load: a numeric
  // timestamp (IDBFS calls timestamp.getTime()) and a file without contents.
  await toMainMenu(page);
  await menuKey(page, 'ArrowDown', 'OPTIONS');
  await menuKey(page, 'Enter', 'the options menu');
  const n = await saves(page);
  await menuKey(page, 'ArrowRight', 'VSYNC OFF');
  await waitSaves(page, n + 1, 'the good save');
  await page.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open(BB_SAVE_DIR);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('FILE_DATA', 'readwrite');
      const store = tx.objectStore('FILE_DATA');
      store.put({ timestamp: 5, mode: 33206, contents: new Uint8Array(3) }, BB_SAVE_DIR + '/bad-timestamp');
      store.put({ timestamp: new Date(), mode: 33206 }, BB_SAVE_DIR + '/no-contents');
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }));
  const warnings = [];
  page.on('console', m => { if (m.type() === 'warning') warnings.push(m.text()); });
  await reload(page, errors);
  check(warnings.some(w => w.startsWith('Repairing saves')), 'the malformed records break loading (repair ran)',
    warnings.filter(w => w.includes('save')).join(' | '));
  const mounted = await page.evaluate(() => bbSavesMounted);
  check(mounted, 'saves still load after malformed records are stored');
  const cfg = await readConfig(page);
  check(cfg.vsync === 0, 'the good save survives the repair', JSON.stringify(cfg));
  await toMainMenu(page);
  await menuKey(page, 'ArrowDown', 'OPTIONS');
  await menuKey(page, 'Enter', 'the options menu');
  const m = await saves(page);
  await menuKey(page, 'ArrowRight', 'VSYNC ON');
  await waitSaves(page, m + 1, 'a change after the repair');
  await reload(page, errors);
  check((await readConfig(page)).vsync === 1, 'and saving works again after the repair');
  check(errors.length === 0, 'no page errors', errors.join(' | '));
  await context.close();
});

await finish();
