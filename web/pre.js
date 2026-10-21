// Loads the game data listed in data/manifest.json into /data before main()
// runs. Files are served individually so each stays well under the GitHub
// Pages per-file limit. Downloads start as soon as this script runs, in
// parallel with the WebAssembly download, and are kept in the Cache API so a
// second visit does not download them again.
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
    data.then(function (files) {
      Object.keys(files).forEach(function (name) {
        FS.writeFile('/data/' + name, files[name]);
        delete files[name];
      });
      removeRunDependency('game-data');
    }).catch(function () {
      // Already reported through onDataError; the game does not start.
    });
  });
})();
