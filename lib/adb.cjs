'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function candidates(saved) {
  const list = [];
  if (saved) list.push(saved);
  for (const dir of (process.env.PATH || '').split(path.delimiter)) if (dir) list.push(path.join(dir, 'adb.exe'));
  for (const root of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk')]) {
    if (root) list.push(path.join(root, 'platform-tools', 'adb.exe'));
  }
  return list;
}

/** 저장된 경로 → PATH → Android SDK platform-tools 순으로 adb.exe 탐색. 없으면 null */
function findAdb(saved) {
  for (const c of candidates(saved)) { try { if (fs.statSync(c).isFile()) return c; } catch {} }
  return null;
}

function run(adb, args, timeout = 8000) {
  return new Promise((resolve, reject) => {
    execFile(adb, args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout, windowsHide: true },
      (err, stdout, stderr) => err ? reject(new Error((stderr && stderr.toString().trim()) || err.message)) : resolve(stdout));
  });
}

async function pickDevice(adb) {
  const text = (await run(adb, ['devices'])).toString();
  const ids = text.split(/\r?\n/).slice(1).map((l) => l.trim().split(/\s+/)).filter((p) => p[1] === 'device').map((p) => p[0]);
  if (!ids.length) throw new Error('연결된 에뮬레이터/기기가 없습니다 (adb devices)');
  return ids.find((i) => i.startsWith('emulator-')) || ids[0];
}

/** 화면만 나온 PNG Buffer */
async function screencap(adb) {
  const id = await pickDevice(adb);
  const png = await run(adb, ['-s', id, 'exec-out', 'screencap', '-p'], 10000);
  if (png.length < 8 || png[0] !== 0x89 || png[1] !== 0x50) throw new Error('screencap 결과가 PNG가 아닙니다');
  return png;
}

module.exports = { findAdb, screencap };
