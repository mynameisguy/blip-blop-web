// Loads the game data listed in data/manifest.json into /data before main()
// runs. Files are served individually so each stays well under the GitHub
// Pages per-file limit. Downloads start as soon as this script runs, in
// parallel with the WebAssembly download, and are kept in the Cache API so a
// second visit does not download them again.
//
// Saves: the settings (data/bb.cfg) and hi-scores (data/bb.scr) are kept in
// IndexedDB (IDBFS mounted at BB_SAVE_DIR). Saved copies replace the shipped
// defaults before main() runs; the game saves them whenever they change
// (Module.bbPersistSave), and again when the page is hidden or closed.
//
// Page hooks (all optional, set on Module before blipblop.js loads):
//   onDataProgress(loadedBytes, totalBytes, filesDone, fileCount, fromCache)
//   onDataError(error)
//   bbEnv / bbInputScript   harness settings (see game/harness.h)

(function () {
  var CACHE_NAME = 'bb-data-v1';
  var PARALLEL = 6;

  function openCache() {
    try {
      if (typeof caches === 'undefined') return Promise.resolve(null);
      return caches.open(CACHE_NAME).catch(function () { return null; });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  // Reads a response body, reporting bytes as they arrive.
  function readBody(response, size, onBytes) {
    if (!response.body || !response.body.getReader) {
      return response.arrayBuffer().then(function (buf) {
        onBytes(buf.byteLength);
        return new Uint8Array(buf);
      });
    }
    var reader = response.body.getReader();
    var chunks = [];
    var length = 0;
    function pump() {
      return reader.read().then(function (r) {
        if (r.done) return;
        chunks.push(r.value);
        length += r.value.length;
        onBytes(r.value.length);
        return pump();
      });
    }
    return pump().then(function () {
      if (chunks.length === 1) return chunks[0];
      var out = new Uint8Array(length);
      var pos = 0;
      chunks.forEach(function (c) { out.set(c, pos); pos += c.length; });
      return out;
    });
  }

  function loadAll() {
    var progress = { loaded: 0, total: 0, done: 0, count: 0, cached: 0 };
    function report() {
      if (Module.onDataProgress)
        Module.onDataProgress(progress.loaded, progress.total, progress.done,
                              progress.count, progress.cached === progress.done && progress.done > 0);
    }

    return Promise.all([
      fetch('data/manifest.json', { cache: 'no-cache' }).then(function (r) {
        if (!r.ok) throw new Error('data/manifest.json: HTTP ' + r.status);
        return r.json();
      }),
      openCache(),
    ]).then(function (res) {
      var entries = res[0], cache = res[1];
      progress.count = entries.length;
      entries.forEach(function (e) { progress.total += e.size; });
      report();

      var files = {};
      var urls = {};
      var next = 0;

      function loadOne(entry) {
        // The hash in the query string names this exact content, so a
        // cached copy is always the right one. The server ignores it.
        var url = 'data/' + entry.name + '?v=' + entry.hash;
        urls[new URL(url, location.href).href] = true;
        var counted = 0;
        function onBytes(n) { counted += n; progress.loaded += n; report(); }

        var fromCache = Promise.resolve(null);
        if (cache) {
          try { fromCache = cache.match(url).catch(function () { return null; }); }
          catch (e) {}
        }
        return fromCache.then(function (hit) {
          if (hit) {
            return readBody(hit, entry.size, onBytes).then(function (bytes) {
              if (bytes.length !== entry.size) throw new Error('stale cache');
              progress.cached++;
              return bytes;
            }).catch(function () {
              progress.loaded -= counted;
              counted = 0;
              return null;
            });
          }
          return null;
        }).then(function (bytes) {
          if (bytes) return bytes;
          return fetch(url).then(function (r) {
            if (!r.ok) throw new Error('data/' + entry.name + ': HTTP ' + r.status);
            return readBody(r, entry.size, onBytes);
          }).then(function (bytes) {
            if (bytes.length !== entry.size)
              throw new Error('data/' + entry.name + ': got ' + bytes.length +
                              ' bytes, expected ' + entry.size);
            if (cache) {
              // Caching is best effort (the quota may be full, or the
              // browser may refuse synchronously).
              try {
                cache.put(url, new Response(bytes, {
                  headers: { 'Content-Type': 'application/octet-stream' },
                })).catch(function () {});
              } catch (e) {}
            }
            return bytes;
          });
        }).then(function (bytes) {
          files[entry.name] = bytes;
          progress.done++;
          report();
        });
      }

      function worker() {
        if (next >= entries.length) return Promise.resolve();
        return loadOne(entries[next++]).then(worker);
      }
      var workers = [];
      for (var i = 0; i < PARALLEL; i++) workers.push(worker());

      return Promise.all(workers).then(function () {
        // Drop cached files that are no longer part of the game data.
        if (cache) {
          cache.keys().then(function (reqs) {
            reqs.forEach(function (req) {
              if (!urls[req.url]) cache.delete(req).catch(function () {});
            });
          }).catch(function () {});
        }
        return files;
      });
    });
  }

  var data = loadAll();
  data.catch(function (e) {
    if (Module.onDataError) Module.onDataError(e);
    else console.error(e);
  });

  Module.preRun = Module.preRun || [];
  Module.preRun.unshift(function () {
    // Harness settings (see game/harness.h) can come from Module.bbEnv or
    // from BB_* query parameters.
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
    // BB_NO_PERSIST=1 (e.g. for pixel comparisons) runs with the shipped
    // files and never touches IndexedDB.
    var saves = env.BB_NO_PERSIST ? Promise.resolve(false) : bbMountSaves();
    Promise.all([data, saves]).then(function (r) {
      var files = r[0];
      Object.keys(files).forEach(function (name) {
        FS.writeFile('/data/' + name, files[name]);
        delete files[name];
      });
      if (r[1]) bbRestoreSaves();
      removeRunDependency('game-data');
    }).catch(function () {
      // Data errors are already reported through onDataError; the game does
      // not start.
    });
  });
})();

var BB_SAVE_DIR = '/blip-n-blop-saves';
var BB_SAVE_FILES = ['bb.cfg', 'bb.scr'];
var bbSavesMounted = false;
var bbSyncing = false;
var bbSyncAgain = false;

// Resolves true once IndexedDB is mounted and loaded, false if it is not
// available (private browsing, blocked storage); the game then runs with the
// shipped defaults and nothing is saved. If loading fails on bad records,
// they are dropped (or, failing that, the database is recreated) so saves
// do not stay off for this browser profile.
function bbMountSaves() {
  return new Promise(function (resolve) {
    function load(repairs) {
      FS.syncfs(true, function (err) {
        if (!err) {
          bbSavesMounted = true;
          bbWatchDb();
          return resolve(true);
        }
        if (!repairs.length) {
          console.warn('Saves unavailable:', err);
          return resolve(false);
        }
        console.warn('Repairing saves after:', err);
        bbCloseDb();
        repairs[0](function () { load(repairs.slice(1)); });
      });
    }
    try {
      FS.mkdir(BB_SAVE_DIR);
      FS.mount(IDBFS, {}, BB_SAVE_DIR);
      load([bbDropBadRecords, bbDeleteDb]);
    } catch (e) {
      console.warn('Saves unavailable:', e);
      resolve(false);
    }
  });
}

function bbCloseDb() {
  var db = IDBFS.dbs[BB_SAVE_DIR];
  delete IDBFS.dbs[BB_SAVE_DIR];
  try { if (db) db.close(); } catch (e) { /* already closed */ }
}

// Deletes records IDBFS cannot load: it expects a Date timestamp, a numeric
// mode and, for a file, byte contents.
function bbDropBadRecords(done) {
  var req;
  try { req = indexedDB.open(BB_SAVE_DIR); } catch (e) { return done(); }
  req.onerror = req.onblocked = function () { done(); };
  req.onsuccess = function () {
    var db = req.result;
    if (!db.objectStoreNames.contains('FILE_DATA')) { db.close(); return done(); }
    var tx = db.transaction('FILE_DATA', 'readwrite');
    tx.objectStore('FILE_DATA').openCursor().onsuccess = function (e) {
      var c = e.target.result;
      if (!c) return;
      var v = c.value;
      var ok = v && v.timestamp instanceof Date && typeof v.mode === 'number' &&
        (!FS.isFile(v.mode) || v.contents instanceof Uint8Array);
      if (!ok) c.delete();
      c.continue();
    };
    tx.oncomplete = tx.onerror = tx.onabort = function () { db.close(); done(); };
  };
}

// Last resort: start this profile's saves afresh.
function bbDeleteDb(done) {
  var req;
  try { req = indexedDB.deleteDatabase(BB_SAVE_DIR); } catch (e) { return done(); }
  req.onsuccess = req.onerror = req.onblocked = function () { done(); };
}

// Copies saved files over the shipped ones. A file whose size differs from
// the shipped one is not from this game version, so it is skipped.
// Anything else stored under a save name (e.g. a directory) is removed, so
// the next save can write the file.
function bbRestoreSaves() {
  BB_SAVE_FILES.forEach(function (name) {
    var path = BB_SAVE_DIR + '/' + name;
    var stat;
    try { stat = FS.stat(path); } catch (e) { return; } // not saved yet
    try {
      if (!FS.isFile(stat.mode)) {
        bbRemoveTree(path);
        return;
      }
      var saved = FS.readFile(path);
      if (saved.length === FS.stat('/data/' + name).size) FS.writeFile('/data/' + name, saved);
    } catch (e) {
      console.warn('Ignoring saved ' + name + ':', e);
    }
  });
}

function bbRemoveTree(path) {
  if (FS.isDir(FS.stat(path).mode)) {
    FS.readdir(path).forEach(function (n) {
      if (n !== '.' && n !== '..') bbRemoveTree(path + '/' + n);
    });
    FS.rmdir(path);
  } else {
    FS.unlink(path);
  }
}

// IDBFS keeps its database connection open. If the browser closes it (site
// data cleared, database deleted), every later sync fails with "The database
// connection is closing": drop the cached connection and try once more.
function bbSyncfs(populate, callback, retried) {
  FS.syncfs(populate, function (err) {
    if (err && !retried) {
      var db = IDBFS.dbs[BB_SAVE_DIR];
      delete IDBFS.dbs[BB_SAVE_DIR];
      try { if (db) db.close(); } catch (e) { /* already closed */ }
      return bbSyncfs(populate, callback, true);
    }
    callback(err);
  });
}

// Lets another tab or the browser delete or upgrade the database instead of
// being blocked by our open connection; the next save reopens it.
function bbWatchDb() {
  var db = IDBFS.dbs[BB_SAVE_DIR];
  if (!db || db.onversionchange) return;
  db.onversionchange = function () {
    db.close();
    if (IDBFS.dbs[BB_SAVE_DIR] === db) delete IDBFS.dbs[BB_SAVE_DIR];
  };
}

function bbSync() {
  if (bbSyncing) { bbSyncAgain = true; return; }
  bbSyncing = true;
  bbSyncfs(false, function (err) {
    bbSyncing = false;
    if (err) console.warn('Cannot save:', err);
    else {
      bbWatchDb();
      if (Module.onSaved) Module.onSaved();
    }
    if (bbSyncAgain) { bbSyncAgain = false; bbSync(); }
  });
}

// Called by the game (game/config.cpp) right after it writes a save file.
Module.bbPersistSave = function (path) {
  if (!bbSavesMounted) return;
  var name = path.split('/').pop();
  if (BB_SAVE_FILES.indexOf(name) < 0) return;
  var path = BB_SAVE_DIR + '/' + name;
  try {
    var data = FS.readFile('/data/' + name);
    try { FS.writeFile(path, data); } catch (e) {
      bbRemoveTree(path); // something else under that name: replace it
      FS.writeFile(path, data);
    }
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

// A browser only shows a pad to the page once a button is pressed on it, so
// the pad arrives with that button already down, and SDL takes the state in
// the gamepadconnected event as its starting point: the press would never
// count. Hand SDL (which listens after us) a copy of the pad at rest, with
// an older timestamp so its next poll compares against the real state and
// reports the pressed button and pushed stick.
// The copy's name starts with the pad's Gamepad API index ("#1 ..."), which
// the game uses as the pad's JOYn slot (Input::webAddJoystick), so pads keep
// their bindings whatever order they are pressed in after a reload.
addEventListener('gamepadconnected', function (e) {
  var pad = e.gamepad;
  if (!pad) return;
  var rest = {
    id: (pad.index >= 0 && pad.index <= 9 ? '#' + pad.index + ' ' : '') + pad.id,
    index: pad.index,
    connected: pad.connected,
    mapping: pad.mapping,
    timestamp: (pad.timestamp || 0) - 1,
    axes: Array.prototype.map.call(pad.axes, function () { return 0; }),
    buttons: Array.prototype.map.call(pad.buttons, function () {
      return { pressed: false, touched: false, value: 0 };
    }),
  };
  try { Object.defineProperty(e, 'gamepad', { value: rest }); } catch (err) { /* keep the real one */ }
}, true);

// Keep the browser from acting on game keys (Space and arrows scrolling,
// Backspace, Firefox quick find on ' and /, Alt opening the menu bar, Space
// or Enter pressing a page button that still has focus after a click). SDL
// still gets the events. Typing into text fields is left alone, and so are
// keys with Ctrl or Meta here; SDL itself still blocks most Ctrl shortcuts,
// but the ones browsers reserve (Ctrl+W, Ctrl+T, Ctrl+N) cannot be blocked.
['keydown', 'keyup'].forEach(function (type) {
  addEventListener(type, function (e) {
    if (e.ctrlKey || e.metaKey) return;
    // Reload, fullscreen and dev tools stay with the browser.
    if (e.key === 'F5' || e.key === 'F11' || e.key === 'F12') return;
    var t = e.target;
    if (t && t.closest && t.closest('input, textarea, select, [contenteditable]')) return;
    e.preventDefault();
  });
});
