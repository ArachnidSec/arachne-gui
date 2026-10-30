#!/usr/bin/env node
/**
 * Interaction test: drives the real UI in headless Chrome over CDP and asserts
 * what the user would see. No dependencies — fetch for discovery, the built-in
 * WebSocket for the protocol.
 *
 *   node tools/drive.mjs [--url http://127.0.0.1:7777] [--keep]
 *
 * Needs a Chromium binary: CHROME_BIN, or one of the usual caches.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const URL_ = flag('url', 'http://127.0.0.1:7777');
const PORT = Number(flag('port', '9333'));
const KEEP = argv.includes('--keep');

function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  try {
    for (const dir of fs.readdirSync(cache)) {
      const bin = path.join(cache, dir, 'chrome-mac/headless_shell');
      if (fs.existsSync(bin)) return bin;
    }
  } catch { /* not a mac with playwright */ }
  for (const bin of ['/usr/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium-browser']) {
    if (fs.existsSync(bin)) return bin;
  }
  throw new Error('no Chromium found — set CHROME_BIN');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(findChrome(), [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu',
  '--hide-scrollbars', '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore' });

let ws;
let nextId = 1;
const pending = new Map();
const problems = [];

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
  return r.result?.value;
};

async function waitFor(expression, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await evaluate(expression)) return true; } catch { /* not ready */ }
    await sleep(120);
  }
  return false;
}

const click = (selector) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);
const text = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent?.trim() || ''`);
const visible = (selector) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`);

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function typeMessage(value) {
  await evaluate(`(() => {
    const input = document.querySelector('#input');
    input.value = ${JSON.stringify(value)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
}

async function main() {
  // discover the page target
  let target;
  for (let i = 0; i < 60 && !target; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
    } catch { /* not up yet */ }
    if (!target) await sleep(150);
  }
  if (!target) throw new Error('chrome did not expose a page target');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      problems.push((d.exception?.description || d.text || '').split('\n').slice(0, 3).join(' | '));
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      problems.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
    }
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: URL_ });
  await waitFor('document.querySelector("#thread-title")?.textContent?.length > 0', 10000);

  console.log(`\n${URL_}\n`);

  check('page renders', await visible('.sidebar'));
  check('switcher has both spaces', await evaluate('document.querySelectorAll("#view-switch button").length') === 2);

  // chat space
  await click('#view-switch button[data-view="chat"]');
  check('chat space selected', await waitFor('document.querySelector("#view-switch button[data-view=chat]").classList.contains("on")'));
  check('chat list offers New thread', await waitFor('[...document.querySelectorAll(".row .row-name")].some(n => n.textContent === "New thread")'));

  await click('.row.new');
  check('new thread opens with a header', await waitFor('document.querySelector("#thread-title").textContent === "New thread"', 5000), await text('#thread-title'));

  await typeMessage('hello there');
  const saidOk = await waitFor('[...document.querySelectorAll(".msg.user .bubble")].some(b => b.textContent.includes("hello there"))', 5000);
  check('message appears', saidOk, saidOk ? '' : await evaluate('document.querySelector("#transcript").innerHTML.slice(0, 300)'));
  check('a reply arrives', await waitFor('document.querySelectorAll(".msg.agent").length > 0', 20000), `${await evaluate('document.querySelectorAll(".msg.agent").length')} reply(s)`);

  // row menu wiring (pin state depends on data, so assert the menu, not the pin)
  const opened = await evaluate(`(() => { const d = document.querySelector('.row:not(.proj) .dots'); if (!d) return false; d.click(); return true; })()`);
  check('row menu opens', opened && await waitFor('document.querySelector(".menu")'), `rows=${await evaluate('document.querySelectorAll(".row").length')}`);
  const items = await evaluate(`[...document.querySelectorAll('.menu button')].map(b => b.textContent)`);
  check('menu offers pin, rename, delete', ['Rename', 'Delete'].every((x) => items.includes(x)) && (items.includes('Pin') || items.includes('Unpin')), items.join(', '));
  await evaluate(`[...document.querySelectorAll('.menu button')].find(b => b.textContent === 'Rename').click()`);
  check('rename opens prefilled', await waitFor('!document.querySelector("#create-modal").classList.contains("hidden") && document.querySelector("#create-name").value.length > 0'));
  await evaluate(`document.querySelector('#create-cancel').click()`);

  // projects
  const projectPlus = await evaluate(`(() => {
    const head = [...document.querySelectorAll('.section-head')].find(h => h.querySelector('.label')?.textContent === 'Projects');
    if (!head) return false; head.querySelector('.add').click(); return true;
  })()`);
  check('projects + opens the dialog', projectPlus && await waitFor('!document.querySelector("#create-modal").classList.contains("hidden")'));
  await evaluate(`document.querySelector('#create-name').value = 'Test project'; document.querySelector('#create-run').click();`);
  check('project is created', await waitFor('[...document.querySelectorAll(".row.proj .row-name")].some(n => n.textContent === "Test project")', 5000));

  // drag the thread into the project
  const dragged = await evaluate(`(() => {
    const thread = [...document.querySelectorAll('.row')].find(r => !r.classList.contains('proj') && !r.classList.contains('new') && r.querySelector('.row-name'));
    const project = [...document.querySelectorAll('.row.proj')].find(r => r.textContent.includes('Test project'));
    if (!thread || !project) return false;
    const dt = new DataTransfer();
    thread.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    project.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
    project.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
    return true;
  })()`);
  check('thread drags into a project', dragged && await waitFor('fetch("/api/threads").then(r => r.json()).then(d => d.threads.some(t => t.projectId))', 6000));

  // agents space
  await click('#view-switch button[data-view="room"]');
  await waitFor('document.querySelector("#view-switch button[data-view=room]").classList.contains("on")');
  const agentClicked = await evaluate(`(() => {
    const row = [...document.querySelectorAll('.row')].find(r => r.textContent.includes('Mira'));
    if (!row) return false; row.click(); return true;
  })()`);
  check('agent click opens a chat directly', agentClicked && await waitFor('document.querySelector("#create-modal").classList.contains("hidden") && document.querySelector("#thread-title").textContent === "Mira"', 6000), await text('#thread-title'));

  // drag an agent into a room
  const agentDrop = await evaluate(`(() => {
    const agent = [...document.querySelectorAll('.row')].find(r => r.querySelector('.row-name')?.textContent === 'Sable');
    const room = [...document.querySelectorAll('.row')].find(r => r.textContent.includes('acme-checkout'));
    if (!agent || !room) return false;
    const dt = new DataTransfer();
    agent.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    room.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
    room.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
    return true;
  })()`);
  check('agent drags into a room', agentDrop && await waitFor('fetch("/api/threads").then(r => r.json()).then(d => d.threads.some(t => t.title === "acme-checkout" && t.members.includes("triage")))', 6000));

  // sidebar collapse
  await click('#collapse-btn');
  check('sidebar collapses', await waitFor('document.querySelector(".app").classList.contains("collapsed")'));
  const mainW = await evaluate('Math.round(document.querySelector(".main").getBoundingClientRect().width)');
  const winW = await evaluate('window.innerWidth');
  check('collapsed content keeps full width', mainW > winW * 0.9, `${mainW}px of ${winW}`);
  check('switcher moves to the topbar', await evaluate('document.querySelector("#top-slot #view-switch") !== null'));
  await click('#collapse-btn');
  check('sidebar restores', await waitFor('!document.querySelector(".app").classList.contains("collapsed")'));
  check('switcher returns to the sidebar', await evaluate('document.querySelector(".side-head #view-switch") !== null'));

  if (!KEEP) {
    await send('Page.captureScreenshot').then((r) => fs.writeFileSync('/tmp/drive.png', Buffer.from(r.data, 'base64'))).catch(() => {});
  }

  check('no console errors', problems.length === 0, problems.slice(0, 3).join(' | '));

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
  return failed.length === 0;
}

main()
  .then((ok) => { if (!KEEP) chrome.kill(); process.exit(ok ? 0 : 1); })
  .catch((err) => { console.error(`\ndriver error: ${err.message}\n`); chrome.kill(); process.exit(1); });
