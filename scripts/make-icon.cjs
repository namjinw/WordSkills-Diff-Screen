'use strict';
// build/icon.png 생성: npx electron scripts/make-icon.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2b3a8f"/><stop offset="1" stop-color="#10142b"/></linearGradient>
    <linearGradient id="ph" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffb347"/><stop offset="1" stop-color="#ff5f6d"/></linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#bg)"/>
  <!-- 뒤: 에뮬레이터(윤곽) -->
  <rect x="104" y="84" width="212" height="372" rx="38" fill="none" stroke="#7fd4ff" stroke-width="16"/>
  <rect x="124" y="124" width="172" height="292" rx="10" fill="#7fd4ff" fill-opacity=".12"/>
  <circle cx="210" cy="104" r="7" fill="#7fd4ff"/>
  <!-- 앞: 프로토타입 사진(반투명) -->
  <rect x="196" y="56" width="212" height="372" rx="38" fill="url(#ph)" fill-opacity=".78"/>
  <rect x="216" y="96" width="172" height="292" rx="10" fill="#fff" fill-opacity=".22"/>
  <rect x="236" y="130" width="92" height="14" rx="7" fill="#fff" fill-opacity=".9"/>
  <rect x="236" y="160" width="132" height="10" rx="5" fill="#fff" fill-opacity=".7"/>
  <rect x="236" y="330" width="132" height="34" rx="12" fill="#fff" fill-opacity=".85"/>
  <!-- 일치도 배지 -->
  <circle cx="396" cy="392" r="68" fill="#101526" stroke="#7dffb0" stroke-width="12"/>
  <path d="M364 394 l22 22 l42 -48" fill="none" stroke="#7dffb0" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 512, height: 512, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,' + encodeURIComponent(`<style>html,body{margin:0;background:transparent}</style>${svg}`));
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  fs.mkdirSync(path.join(__dirname, '..', 'build'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon.png'), img.toPNG());
  fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon.svg'), svg);
  console.log('icon ok', img.getSize());
  app.quit();
});
