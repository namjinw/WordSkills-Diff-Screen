'use strict';
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = { opacity: 50, autoFit: true, clickThrough: true, autoCompare: true, adbPath: '', photoPath: '', photoDir: '', docked: true, dockSide: 'right', split: 50, threshold: 20, excludeTop: 0, excludeBottom: 0, autoMatch: false, rulers: false, calib: {} };
let cache = null;
const file = () => path.join(app.getPath('userData'), 'config.json');

function load() {
  if (cache) return cache;
  try { cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf8')) }; }
  catch { cache = { ...DEFAULTS }; }
  return cache;
}
function save(patch) {
  cache = { ...load(), ...patch };
  try { fs.mkdirSync(path.dirname(file()), { recursive: true }); fs.writeFileSync(file(), JSON.stringify(cache, null, 2)); } catch {}
  return cache;
}
module.exports = { load, save };
