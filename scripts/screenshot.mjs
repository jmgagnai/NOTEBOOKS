#!/usr/bin/env node
/**
 * Signed-in screenshots of the running app, for PR evidence and visual checks.
 *
 * The session cookie is httpOnly, so Chrome's own `--screenshot` flag only
 * ever reaches the sign-in page. This signs in through the API instead, hands
 * the cookie to headless Chrome over the DevTools protocol, and captures each
 * path. No dependencies: Node's fetch and WebSocket, and the installed Chrome.
 *
 *   node scripts/screenshot.mjs [--register] [--out dir] [--width 1440] [--height 900] \
 *        [--settle 2000] / /notebooks/<id> ...
 *
 * Needs the backend and `ng serve` running (docs/run-for-screenshots.md).
 * Account: SCREENSHOT_EMAIL / SCREENSHOT_PASSWORD, defaulting to a throwaway
 * screenshots@example.com; `--register` creates it first (a 409 is fine).
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const API = process.env.SCREENSHOT_API ?? 'http://localhost:3000';
const APP = process.env.SCREENSHOT_APP ?? 'http://localhost:4200';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const email = process.env.SCREENSHOT_EMAIL ?? 'screenshots@example.com';
const password = process.env.SCREENSHOT_PASSWORD ?? 'screenshots-only';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args.splice(i, 2)[1];
};
const register = args.includes('--register') && args.splice(args.indexOf('--register'), 1);
const out = resolve(opt('out', 'screenshots'));
const width = Number(opt('width', 1440));
const height = Number(opt('height', 900));
const settle = Number(opt('settle', 2000));
const paths = args.length > 0 ? args : ['/'];

async function post(path, body) {
  return fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

if (register) {
  const res = await post('/auth/register', { email, password });
  if (!res.ok && res.status !== 409)
    throw new Error(`register → ${res.status} ${await res.text()}`);
}
const login = await post('/auth/login', { email, password });
if (!login.ok) {
  throw new Error(`login as ${email} → ${login.status}; pass --register the first time`);
}
const cookies = login.headers.getSetCookie().map((c) => c.split(';')[0].split('='));

// Headless Chrome prints its DevTools endpoint on stderr.
const chrome = spawn(CHROME, [
  '--headless=new',
  '--remote-debugging-port=0',
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'screenshot-chrome-'))}`,
  '--hide-scrollbars',
  'about:blank',
]);
const endpoint = await new Promise((done, fail) => {
  let log = '';
  chrome.stderr.on('data', (chunk) => {
    log += chunk;
    const match = log.match(/DevTools listening on (ws:\/\/\S+)/);
    if (match) done(match[1]);
  });
  chrome.on('exit', (code) => fail(new Error(`Chrome exited (${code}):\n${log}`)));
});

const socket = new WebSocket(endpoint);
await new Promise((done) => socket.addEventListener('open', done, { once: true }));
let nextId = 0;
const pending = new Map();
const listeners = new Set();
socket.addEventListener('message', ({ data }) => {
  const message = JSON.parse(data);
  if (message.id !== undefined) {
    const call = pending.get(message.id);
    pending.delete(message.id);
    message.error ? call.fail(new Error(message.error.message)) : call.done(message.result);
  } else {
    for (const listener of listeners) listener(message);
  }
});
const send = (method, params = {}, sessionId) =>
  new Promise((done, fail) => {
    const id = ++nextId;
    pending.set(id, { done, fail });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
const once = (method, sessionId) =>
  new Promise((done) => {
    const listener = (message) => {
      if (message.method === method && message.sessionId === sessionId) {
        listeners.delete(listener);
        done(message.params);
      }
    };
    listeners.add(listener);
  });

try {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Network.enable', {}, sessionId);
  for (const [name, value] of cookies) {
    await send('Network.setCookie', { url: API, name, value, httpOnly: true }, sessionId);
  }
  await send(
    'Emulation.setDeviceMetricsOverride',
    { width, height, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );
  mkdirSync(out, { recursive: true });
  for (const path of paths) {
    const loaded = once('Page.loadEventFired', sessionId);
    await send('Page.navigate', { url: `${APP}${path}` }, sessionId);
    await loaded;
    // The app fetches its data after load; give it time to render.
    await new Promise((done) => setTimeout(done, settle));
    const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
    const file = join(out, `${path.replace(/^\/|\/$/g, '').replace(/\//g, '_') || 'home'}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    console.log(file);
  }
} finally {
  socket.close();
  chrome.kill();
}
