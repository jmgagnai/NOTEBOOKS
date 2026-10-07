// PROTOTYPE — throwaway. Headless Chrome over the DevTools protocol: logs in, then screenshots
// the current page and each variant. Usage (both servers running):
//   node apps/frontend/src/app/notebooks/prototype/screenshot.mjs <email> <password> <notebookId> <outDir> [width]
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [, , email, password, notebookId, outDir, widthArg] = process.argv;
const width = Number(widthArg ?? 1440),
  height = 900;
const chrome = spawn(
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  [
    '--headless=new',
    '--remote-debugging-port=9333',
    `--window-size=${width},${height}`,
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${outDir}/profile`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 40; i++) {
  try {
    targets = await (await fetch('http://127.0.0.1:9333/json')).json();
    break;
  } catch {
    await sleep(250);
  }
}
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const send = (method, params = {}) =>
  new Promise((r) => {
    pending.set(++id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) =>
  (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result
    ?.result?.value;
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width,
  height,
  deviceScaleFactor: 1,
  mobile: false,
});
await send('Page.navigate', { url: 'http://localhost:4200/login' });
await sleep(2500);
const login = await evaluate(
  `fetch('http://localhost:3000/auth/login',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:${JSON.stringify(email)},password:${JSON.stringify(password)}})}).then(r=>r.status)`,
);
console.log('login', login);
const shots = [
  ['current', ''],
  ['A', '?variant=A'],
  ['B', '?variant=B'],
  ['C', '?variant=C'],
];
for (const [name, q] of shots) {
  await send('Page.navigate', { url: `http://localhost:4200/notebooks/${notebookId}${q}` });
  await sleep(3000);
  if (name !== 'current') {
    // Open the first Chat Thread so the message area is populated.
    const opened = await evaluate(
      `(async()=>{const b=[...document.querySelectorAll('button')].find(b=>/^Open /.test(b.getAttribute('aria-label')||''));if(b){b.click();return 'list'}const m=document.querySelector('button[aria-label="Chat Threads"]');if(m){m.click();await new Promise(r=>setTimeout(r,400));const i=document.querySelector('.mat-mdc-menu-panel button');if(i){i.click();return 'menu'}document.body.click()}return 'none'})()`,
    );
    await sleep(2000);
    console.log(name, 'thread via', opened);
  }
  const html = await evaluate(
    `document.documentElement.className + ' | ' + (document.querySelector('.proto-switcher__label')?.textContent ?? 'no switcher') + ' | errors:' + (window.__err ?? 0)`,
  );
  console.log(name, html);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${outDir}/${name}-${width}.png`, Buffer.from(shot.result.data, 'base64'));
  if (name === 'C') {
    await evaluate(`document.querySelector('button[aria-label="Documents"]')?.click()`);
    await sleep(800);
    const s2 = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`${outDir}/C-sheet-${width}.png`, Buffer.from(s2.result.data, 'base64'));
  }
  if (name === 'A') {
    await evaluate(`document.querySelector('button[aria-label="Collapse Documents"]')?.click()`);
    await sleep(500);
    const s2 = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`${outDir}/A-collapsed-${width}.png`, Buffer.from(s2.result.data, 'base64'));
  }
}
ws.close();
chrome.kill();
