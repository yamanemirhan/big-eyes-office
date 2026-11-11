// Big Eyes Office desktop app: its own window and taskbar icon, a tray icon, start with Windows, a global shortcut,
// and native notifications. The office itself still runs in your checkout (supervisor + server), so the desktop
// app, the browser and Claude all talk to the same server.
const { app, BrowserWindow, Tray, Menu, Notification, globalShortcut, nativeImage, shell, session } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const APP_URL = 'http://localhost:47800';
const SUPERVISOR = 'http://127.0.0.1:47799';
const SHORTCUT = 'CommandOrControl+Shift+Space';

function projectRoot() {
  if (process.env.BEO_ROOT) return process.env.BEO_ROOT;
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'root.json'), 'utf8')).root; } catch { return path.resolve(__dirname, '..'); }
}
const ROOT = projectRoot();

let win = null;
let tray = null;
let quitting = false;

const up = (url) => fetch(url, { signal: AbortSignal.timeout(1500) }).then((r) => r.status < 500, () => false);

/** Starts the supervisor (which starts the server) unless it already runs, e.g. from autostart or a terminal. */
async function ensureServer(onStatus) {
  if (await up(`${APP_URL}/api/state`)) return true;
  if (!(await up(`${SUPERVISOR}/`))) {
    const script = path.join(ROOT, 'scripts', 'supervisor.mjs');
    if (!fs.existsSync(script)) { onStatus(`Big Eyes Office was not found in ${ROOT}.`); return false; }
    onStatus('Starting the server…');
    const child = spawn(process.env.BEO_NODE || 'node', [script], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => onStatus('Node.js was not found. Install Node 22 or newer from nodejs.org, then open the app again.'));
    child.unref();
  }
  // The first start installs packages and builds the UI, which can take a few minutes.
  for (let i = 0; i < 600; i++) {
    if (await up(`${APP_URL}/api/state`)) return true;
    if (i === 20) onStatus('Installing and building on first start… this can take a few minutes.');
    await new Promise((r) => setTimeout(r, 500));
  }
  onStatus(`The server did not start. See ${path.join(ROOT, 'data', 'supervisor.log')}.`);
  return false;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600, title: 'Big Eyes Office',
    icon: path.join(__dirname, 'icon.png'), backgroundColor: '#f6efe6', autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'loading.html'));
  // Links to other sites open in the normal browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => { if (!url.startsWith(APP_URL)) shell.openExternal(url); return { action: url.startsWith(APP_URL) ? 'allow' : 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(APP_URL) && !url.startsWith('file:')) { e.preventDefault(); shell.openExternal(url); } });
  // Closing the window keeps the office running in the tray; agents keep working.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!app.__toldTray) {
      app.__toldTray = true;
      new Notification({ title: 'Big Eyes Office is still running', body: 'Your agents keep working. Open it from the tray icon.' }).show();
    }
  });
}

function show() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

async function supervisorCall(action) {
  try {
    const { token } = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'supervisor.json'), 'utf8'));
    await fetch(`${SUPERVISOR}/${action}`, { method: 'POST', headers: { 'x-beo-token': token } });
  } catch { /* supervisor not running */ }
}

function buildTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({ width: 16, height: 16 }));
  tray.setToolTip('Big Eyes Office');
  tray.on('click', show);
  const menu = () => Menu.buildFromTemplate([
    { label: 'Open Big Eyes Office', click: show },
    { label: `New task (${SHORTCUT.replace('CommandOrControl', 'Ctrl')})`, click: focusTaskBox },
    { type: 'separator' },
    { label: 'Start with Windows', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => { app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }); tray.setContextMenu(menu()); } },
    { label: 'Restart server', click: () => supervisorCall('restart') },
    { label: 'Open project folder', click: () => shell.openPath(ROOT) },
    { type: 'separator' },
    { label: 'Quit (agents keep running)', click: () => { quitting = true; app.quit(); } },
    { label: 'Quit and stop the server', click: async () => { await supervisorCall('shutdown'); quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu());
}

function focusTaskBox() {
  show();
  win.webContents.executeJavaScript("document.querySelector('.task-panel textarea')?.focus()").catch(() => {});
}

/** Tray tooltip and taskbar flash when something waits for you. */
function watchAttention() {
  let lastWaiting = 0;
  setInterval(async () => {
    try {
      const state = await fetch(`${APP_URL}/api/state`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json());
      const runs = state.runs ?? [];
      const running = runs.filter((r) => r.status === 'running').length;
      const waiting = runs.filter((r) => r.status === 'waiting').length;
      tray?.setToolTip(`Big Eyes Office · ${running} running${waiting ? ` · ${waiting} waiting for you` : ''}`);
      if (waiting > lastWaiting && win && !win.isFocused()) win.flashFrame(true);
      lastWaiting = waiting;
    } catch { tray?.setToolTip('Big Eyes Office · server offline'); }
  }, 5000);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', show);
  app.setAppUserModelId('dev.bigeyesoffice.app');
  app.whenReady().then(async () => {
    // The office page may use the microphone (voice commands) and notifications; nothing else gets permissions.
    session.defaultSession.setPermissionRequestHandler((wc, permission, done) => {
      done(wc.getURL().startsWith(APP_URL) && ['media', 'notifications', 'clipboard-read', 'clipboard-sanitized-write'].includes(permission));
    });
    buildTray();
    if (!process.argv.includes('--hidden')) createWindow();
    globalShortcut.register(SHORTCUT, focusTaskBox);
    const ok = await ensureServer((msg) => win?.webContents.executeJavaScript(`document.getElementById('msg').textContent = ${JSON.stringify(msg)}`).catch(() => {}));
    if (ok && win) win.loadURL(APP_URL);
    watchAttention();
  });
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => { /* stay in the tray */ });
}
