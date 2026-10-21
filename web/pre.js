// Fetches the game data files listed in data/manifest.json into /data before
// main() runs. Files are served individually so each stays well under the
// GitHub Pages per-file limit.
//
// Saves: the settings (data/bb.cfg) and hi-scores (data/bb.scr) are kept in
// IndexedDB (IDBFS mounted at /persist). Saved copies replace the shipped
// defaults before main() runs; the game saves them whenever they change
// (Module.bbPersistSave), and again when the page is hidden or closed.
Module.preRun = Module.preRun || [];
Module.preRun.push(function () {
  // Harness settings (see game/harness.h) can come from Module.bbEnv or from
  // BB_* query parameters.
  var env = Object.assign({}, Module.bbEnv || {});
  new URLSearchParams(location.search).forEach(function (v, k) {
    if (k.indexOf('BB_') === 0) env[k] = v;
  });
  Object.keys(env).forEach(function (k) { ENV[k] = String(env[k]); });
  if (Module.bbInputScript) {
    FS.writeFile('/input_script.txt', Module.bbInputScript);
    ENV.BB_INPUT_SCRIPT = '/input_script.txt';
  }

  addRunDependency('game-data');
  FS.mkdir('/data');
  var data = fetch('data/manifest.json')
    .then(function (r) { return r.json(); })
    .then(function (files) {
      var done = 0;
      return Promise.all(files.map(function (name) {
        return fetch('data/' + name)
          .then(function (r) {
            if (!r.ok) throw new Error('data/' + name + ': HTTP ' + r.status);
            return r.arrayBuffer();
          })
          .then(function (buf) {
            FS.writeFile('/data/' + name, new Uint8Array(buf));
            done++;
            if (Module.onDataProgress) Module.onDataProgress(done, files.length);
          });
      }));
    });
  // BB_NO_PERSIST=1 (e.g. for pixel comparisons) runs with the shipped files
  // and never touches IndexedDB.
  var saves = env.BB_NO_PERSIST ? Promise.resolve(false) : bbMountSaves();
  Promise.all([data, saves])
    .then(function (r) { if (r[1]) bbRestoreSaves(); })
    .then(function () { removeRunDependency('game-data'); })
    .catch(function (e) {
      if (Module.onDataError) Module.onDataError(e);
      throw e;
    });
});

var BB_SAVE_DIR = '/persist';
var BB_SAVE_FILES = ['bb.cfg', 'bb.scr'];
var bbSavesMounted = false;
var bbSyncing = false;
var bbSyncAgain = false;

// Resolves true once IndexedDB is mounted and loaded, false if it is not
// available (private browsing, blocked storage); the game then runs with the
// shipped defaults and nothing is saved.
function bbMountSaves() {
  return new Promise(function (resolve) {
    try {
      FS.mkdir(BB_SAVE_DIR);
      FS.mount(IDBFS, {}, BB_SAVE_DIR);
      FS.syncfs(true, function (err) {
        if (err) {
          console.warn('Saves unavailable:', err);
          return resolve(false);
        }
        bbSavesMounted = true;
        resolve(true);
      });
    } catch (e) {
      console.warn('Saves unavailable:', e);
      resolve(false);
    }
  });
}

// Copies saved files over the shipped ones. A file whose size differs from
// the shipped one is not from this game version, so it is skipped.
function bbRestoreSaves() {
  BB_SAVE_FILES.forEach(function (name) {
    try {
      var saved = FS.readFile(BB_SAVE_DIR + '/' + name);
      var shipped = FS.stat('/data/' + name);
      if (saved.length === shipped.size) FS.writeFile('/data/' + name, saved);
    } catch (e) { /* not saved yet */ }
  });
}

function bbSync() {
  if (bbSyncing) { bbSyncAgain = true; return; }
  bbSyncing = true;
  FS.syncfs(false, function (err) {
    bbSyncing = false;
    if (err) console.warn('Cannot save:', err);
    else if (Module.onSaved) Module.onSaved();
    if (bbSyncAgain) { bbSyncAgain = false; bbSync(); }
  });
}

// Called by the game (game/config.cpp) right after it writes a save file.
Module.bbPersistSave = function (path) {
  if (!bbSavesMounted) return;
  var name = path.split('/').pop();
  if (BB_SAVE_FILES.indexOf(name) < 0) return;
  try {
    FS.writeFile(BB_SAVE_DIR + '/' + name, FS.readFile('/data/' + name));
  } catch (e) {
    console.warn('Cannot save ' + name + ':', e);
    return;
  }
  bbSync();
};

// Safety net: save everything when the page is hidden or closed, as the
// original does on exit. The game's own saves on change already cover the
// common cases; this catches anything they miss.
function bbSaveAll() {
  if (!bbSavesMounted || !Module._bb_web_save_all) return;
  try { Module._bb_web_save_all(); } catch (e) { /* runtime gone */ }
}
addEventListener('pagehide', bbSaveAll);
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'hidden') bbSaveAll();
});

// Keep the browser from acting on game keys (Space and arrows scrolling,
// Backspace, Firefox quick find on ' and /, Alt opening the menu bar, Space
// or Enter pressing a page button that still has focus after a click). SDL
// still gets the events. Shortcuts with Ctrl or Meta, and typing into text
// fields, keep their usual behaviour.
['keydown', 'keyup'].forEach(function (type) {
  addEventListener(type, function (e) {
    if (e.ctrlKey || e.metaKey) return;
    var t = e.target;
    if (t && t.closest && t.closest('input, textarea, select, [contenteditable]')) return;
    e.preventDefault();
  });
});
