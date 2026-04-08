/**
 * Aetherforge — Electron main process
 * Responsibilities:
 *   1. Auto-update: compare bundled backend VERSION against installed copy,
 *      overwrite if newer, notify the renderer
 *   2. Find a free local port and spawn the Python FastAPI backend
 *   3. Wait for the backend /health endpoint
 *   4. Create the BrowserWindow
 *   5. IPC: file save dialog, window controls, encrypted chat storage
 */

import { app, BrowserWindow, dialog, ipcMain, Notification, safeStorage, shell } from 'electron';
import * as fs   from 'fs';
import * as http from 'http';
import * as net  from 'net';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';

// ── Shared types ───────────────────────────────────────────────────────────────
interface HistoryEntry { role: string; content: string; }
interface ChatMeta { id: string; title: string; createdAt: number; updatedAt: number; model: string; }
interface StoredChat extends ChatMeta { messages: HistoryEntry[]; }

interface UpdateInfo {
  updated: boolean;
  from:    string;
  to:      string;
}

interface AppConfig {
  theme:      'normal' | 'aero';
  accent:     string;
  background: string;
  textColor:  string;
  font:       string;
  models:     Array<{ name: string; tag: string }>;
}

// ── Globals ───────────────────────────────────────────────────────────────────
let mainWindow:     BrowserWindow | null = null;
let backendProcess: ChildProcess  | null = null;
let backendPort   = 8745;
let lastUpdate:   UpdateInfo      = { updated: false, from: '', to: '' };

// ══════════════════════════════════════════════════════════════════════════════
// AUTO-UPDATER
// How it works:
//   • The backend folder contains a VERSION file (e.g. "1.1.0").
//   • On every launch we compare the VERSION bundled inside the exe
//     (resources/backend/VERSION) against the one installed in
//     userData/backend/VERSION.
//   • If the bundled copy is newer, the entire backend folder is overwritten.
//   • The server always runs from userData/backend so patches apply instantly
//     without reinstalling the exe.
//   • To ship an update: bump VERSION, run build.bat, run the new installer.
// ══════════════════════════════════════════════════════════════════════════════

function readVersion(dir: string): string {
  const f = path.join(dir, 'VERSION');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf-8').trim() : '0.0.0';
}

/** Returns true when semver a > b. */
function semverGt(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    entry.isDirectory() ? copyDir(s, d) : fs.copyFileSync(s, d);
  }
}

/**
 * Check if the bundled backend is newer than the installed one.
 * If so, overwrite. Always ensures userData/backend exists.
 */
function ensureBackendCurrent(): UpdateInfo {
  // Bundled source: inside the exe's resources (production) or project root (dev)
  const bundledDir = app.isPackaged
    ? path.join(process.resourcesPath, 'backend')
    : path.join(app.getAppPath(), 'backend');

  // Writable destination: user's AppData folder
  const installedDir = path.join(app.getPath('userData'), 'backend');

  const bundledV   = readVersion(bundledDir);
  const installedV = readVersion(installedDir);
  const firstRun   = !fs.existsSync(installedDir);

  if (firstRun || semverGt(bundledV, installedV)) {
    console.log(`[updater] ${firstRun ? 'Installing' : 'Updating'} backend ${installedV} → ${bundledV}`);
    copyDir(bundledDir, installedDir);
    return { updated: !firstRun, from: installedV, to: bundledV };
  }

  console.log(`[updater] Backend v${installedV} is current.`);
  return { updated: false, from: installedV, to: installedV };
}

// ── App config (theme, colors, font, models) ──────────────────────────────────

function configFile(): string {
  return path.join(app.getPath('userData'), 'config.json');
}

/** Default config — matches the backend's built-in MODELS dict. */
function defaultConfig(): AppConfig {
  return {
    theme:      'normal',
    accent:     '#CC0000',
    background: '#000000',
    textColor:  '#CC0000',
    font:       'Arial',
    models: [
      { name: 'Aetherforge_v1_general',    tag: 'huihui_ai/dolphin3-abliterated' },
      { name: 'Aetherforge_v1_reasoning',  tag: 'huihui_ai/phi4-reasoning-abliterated:3.8b' },
      { name: 'Aetherforge_v1_code',       tag: 'huihui_ai/qwen3.5-abliterated:4b' },
      { name: 'Aetherforge_v1_learn',      tag: 'huihui_ai/lfm2.5-abliterated' },
    ],
  };
}

function readConfig(): AppConfig {
  const fp = configFile();
  if (!fs.existsSync(fp)) return defaultConfig();
  try {
    const parsed = JSON.parse(fs.readFileSync(fp, 'utf-8')) as Partial<AppConfig>;
    const merged = { ...defaultConfig(), ...parsed };
    // Sanitize: reject any theme value that no longer exists
    if (merged.theme !== 'normal' && merged.theme !== 'aero') merged.theme = 'normal';
    return merged;
  } catch { return defaultConfig(); }
}

// ── Chat storage ───────────────────────────────────────────────────────────────
function chatsDir(): string {
  const dir = path.join(app.getPath('userData'), 'chats');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function chatFile(id: string): string { return path.join(chatsDir(), `${id}.enc`); }

// ── Free-port discovery ────────────────────────────────────────────────────────
function findFreePort(start: number): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(start, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
    srv.on('error', () => findFreePort(start + 1).then(resolve));
  });
}

// ── Backend health check ───────────────────────────────────────────────────────
function waitForBackend(port: number, maxRetries = 35, retryMs = 500): Promise<void> {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    function attempt() {
      const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve(); else retry();
      });
      req.on('error', retry);
      req.setTimeout(400, () => { req.destroy(); retry(); });
    }
    function retry() {
      if (++attempts >= maxRetries) reject(new Error(`Backend on :${port} timed out`));
      else setTimeout(attempt, retryMs);
    }
    attempt();
  });
}

// ── Spawn Python backend from the writable userData copy ──────────────────────
function spawnBackend(port: number): ChildProcess {
  // Always run from userData/backend — this is what ensureBackendCurrent() updates
  const serverScript = path.join(app.getPath('userData'), 'backend', 'server.py');
  const python       = process.platform === 'win32' ? 'python' : 'python3';

  const proc = spawn(python, [serverScript, String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  proc.stdout?.on('data', (d: Buffer) => process.stdout.write(`[py] ${d}`));
  proc.stderr?.on('data', (d: Buffer) => process.stderr.write(`[py:err] ${d}`));
  proc.on('exit', (code: number | null) => {
    if (code !== null && code !== 0) console.error(`[py] exited with code ${code}`);
  });

  return proc;
}

// ── BrowserWindow ──────────────────────────────────────────────────────────────
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100, height: 720, minWidth: 750, minHeight: 520,
    frame: false, backgroundColor: '#000000', show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    // Push update info to renderer once it's ready to receive it
    if (lastUpdate.updated) {
      mainWindow?.webContents.send('update-applied', lastUpdate);
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── IPC ────────────────────────────────────────────────────────────────────────
function setupIPC(): void {

  ipcMain.handle('get-port',        () => backendPort);
  ipcMain.handle('get-update-info', () => lastUpdate);

  // ── App config (theme, colors, font, models) ───────────────────────────────
  ipcMain.handle('config:get', () => readConfig());
  ipcMain.handle('config:set', (_evt, cfg: AppConfig) => {
    fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2), 'utf-8');
  });

  ipcMain.on('win-minimize', () => mainWindow?.minimize());
  ipcMain.on('win-maximize', () => {
    mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize();
  });
  ipcMain.on('win-close', () => mainWindow?.close());

  ipcMain.handle('save-file', async (_evt, opts: { content: string; defaultName: string; ext: string }) => {
    if (!mainWindow) return { success: false };
    const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Code — Aetherforge',
      defaultPath: path.join(app.getPath('documents'), opts.defaultName),
      filters: [
        { name: opts.ext.replace(/^\./, '').toUpperCase() + ' Files', extensions: [opts.ext.replace(/^\./, '')] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (canceled || !filePath) return { success: false };
    try { fs.writeFileSync(filePath, opts.content, 'utf-8'); return { success: true, filePath }; }
    catch (err: unknown) { return { success: false, error: String(err) }; }
  });

  ipcMain.on('show-in-folder', (_evt, fp: string) => shell.showItemInFolder(fp));

  // Save a PNG image received as base64 from the renderer (Image Forge).
  ipcMain.handle('save-image', async (_evt, opts: { base64: string; defaultName: string }) => {
    if (!mainWindow) return { success: false };
    const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Image — Aetherforge',
      defaultPath: path.join(app.getPath('pictures'), opts.defaultName),
      filters: [
        { name: 'PNG Image', extensions: ['png'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (canceled || !filePath) return { success: false };
    try {
      fs.writeFileSync(filePath, Buffer.from(opts.base64, 'base64'));
      return { success: true, filePath };
    } catch (err: unknown) { return { success: false, error: String(err) }; }
  });

  // ── Encrypted chat storage ─────────────────────────────────────────────────

  ipcMain.handle('chat:list', (): ChatMeta[] => {
    const dir = chatsDir();
    const metas: ChatMeta[] = [];
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.enc'))) {
      try {
        const chat = JSON.parse(safeStorage.decryptString(fs.readFileSync(path.join(dir, file)))) as StoredChat;
        metas.push({ id: chat.id, title: chat.title, createdAt: chat.createdAt, updatedAt: chat.updatedAt, model: chat.model });
      } catch { /* skip corrupted files */ }
    }
    return metas.sort((a, b) => b.updatedAt - a.updatedAt);
  });

  ipcMain.handle('chat:load', (_evt, id: string): StoredChat | null => {
    const fp = chatFile(id);
    if (!fs.existsSync(fp)) return null;
    try { return JSON.parse(safeStorage.decryptString(fs.readFileSync(fp))) as StoredChat; }
    catch { return null; }
  });

  ipcMain.handle('chat:save', (_evt, chat: StoredChat): void => {
    fs.writeFileSync(chatFile(chat.id), safeStorage.encryptString(JSON.stringify(chat)));
  });

  ipcMain.handle('chat:delete', (_evt, id: string): void => {
    const fp = chatFile(id);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  });
}

// ── App lifecycle ──────────────────────────────────────────────────────────────
app.whenReady().then(async () => {

  // ── Step 1: update backend files if a newer version is bundled ──────────────
  lastUpdate  = ensureBackendCurrent();

  if (lastUpdate.updated && Notification.isSupported()) {
    new Notification({
      title: 'Aetherforge Updated',
      body:  `Backend updated v${lastUpdate.from} → v${lastUpdate.to}`,
    }).show();
  }

  // ── Step 2: start the (now up-to-date) backend ──────────────────────────────
  backendPort    = await findFreePort(8745);
  backendProcess = spawnBackend(backendPort);

  try {
    await waitForBackend(backendPort);
    console.log(`[main] Backend v${lastUpdate.to} ready on :${backendPort}`);
  } catch (err) {
    console.error('[main] Backend failed to start:', err);
  }

  setupIPC();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (backendProcess && !backendProcess.killed) backendProcess.kill('SIGTERM');
});
