// Fetches the game data files listed in data/manifest.json into /data before
// main() runs. Files are served individually so each stays well under the
// GitHub Pages per-file limit.
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
  fetch('data/manifest.json')
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
    })
    .then(function () { removeRunDependency('game-data'); })
    .catch(function (e) {
      if (Module.onDataError) Module.onDataError(e);
      throw e;
    });
});
