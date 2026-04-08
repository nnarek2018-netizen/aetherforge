/**
 * Aetherforge renderer — UI logic.
 *
 * NO top-level import / export — compiled with "module": "none" so TypeScript
 * emits a plain script (no require/exports wrappers) safe for browser context.
 * All Electron APIs come through window.aetherforge (set by preload.ts).
 */

// ════════════════════════════════════════════════════════════════════════════════
// TYPE DECLARATIONS  (zero JS emitted — compiler only)
// ════════════════════════════════════════════════════════════════════════════════

interface HistoryEntry { role: string; content: string; }

interface ChatMeta {
  id:        string;
  title:     string;
  createdAt: number;   // Unix ms
  updatedAt: number;
  model:     string;
}

interface StoredChat extends ChatMeta {
  messages: HistoryEntry[];
}

interface UpdateInfo { updated: boolean; from: string; to: string; }

/** Persisted user preferences saved to config.json via the main process. */
interface AppConfig {
  theme:      'normal' | 'aero' | 'dune';  // 'normal' = customizable, 'aero' / 'dune' = fixed
  accent:     string;              // CSS hex color — drives the UI chrome
  background: string;              // CSS hex color — main background
  textColor:  string;              // CSS hex color — AI message text
  font:       string;              // font-family name (no quotes)
  models:     Array<{ name: string; tag: string }>;  // display-name → Ollama tag
}

interface AetherforgeBridge {
  getPort:         () => Promise<number>;
  onUpdateApplied: (cb: (info: UpdateInfo) => void) => void;
  saveFile:        (opts: { content: string; defaultName: string; ext: string })
                       => Promise<{ success: boolean; filePath?: string; error?: string }>;
  saveImage:       (opts: { base64: string; defaultName: string })
                       => Promise<{ success: boolean; filePath?: string; error?: string }>;
  showInFolder:    (fp: string) => void;
  windowControls:  { minimize: () => void; maximize: () => void; close: () => void; };
  chatList:        ()                  => Promise<ChatMeta[]>;
  chatLoad:        (id: string)        => Promise<StoredChat | null>;
  chatSave:        (chat: StoredChat)  => Promise<void>;
  chatDelete:      (id: string)        => Promise<void>;
  configGet:       ()                  => Promise<AppConfig>;
  configSet:       (cfg: AppConfig)    => Promise<void>;
}

// Extend Window — no redeclaration, just interface merging
interface Window { aetherforge: AetherforgeBridge; }

// ════════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════════════════════════════════

const LANG_EXT: { [k: string]: string } = {
  python: '.py',      py: '.py',
  javascript: '.js',  js: '.js',
  typescript: '.ts',  ts: '.ts',
  java: '.java',
  c: '.c',            cpp: '.cpp',    'c++': '.cpp',
  csharp: '.cs',      cs: '.cs',
  html: '.html',      css: '.css',
  bash: '.sh',        shell: '.sh',   sh: '.sh',
  rust: '.rs',        go: '.go',
  sql: '.sql',        json: '.json',
  yaml: '.yaml',      yml: '.yml',
  xml: '.xml',        markdown: '.md', md: '.md',
  ruby: '.rb',        php: '.php',
  swift: '.swift',    kotlin: '.kt',
  r: '.r',            lua: '.lua',    toml: '.toml',
};

const SAVE_TRIGGERS = [
  'save', 'save file', 'save the file', 'save this', 'save this file',
  'save code', 'save the code', 'save it', 'save as',
];

// ── Image Forge / ComfyUI settings ──────────────────────────────────────────
//
// HOW TO START COMFYUI:
//   1. Install ComfyUI: https://github.com/comfyanonymous/ComfyUI
//      git clone https://github.com/comfyanonymous/ComfyUI.git
//      cd ComfyUI && pip install -r requirements.txt
//   2. Start it on the default port:
//      python main.py --listen 127.0.0.1 --port 8188
//
// WHERE TO PLACE THE MODEL:
//   Model: Stable Diffusion 1.5  (fastest option for CPU / low-RAM systems)
//   File:  v1-5-pruned-emaonly.safetensors  (~4 GB)
//   Download: https://huggingface.co/runwayml/stable-diffusion-v1-5
//   Place in: <ComfyUI folder>/models/checkpoints/
//
const COMFY_URL    = 'http://127.0.0.1:8188';
const PIXART_MODEL = 'v1-5-pruned-emaonly.safetensors';  // SD 1.5 — fastest CPU-compatible model
const IMG_W        = 512;    // SD 1.5 native resolution — do not change
const IMG_H        = 512;    // SD 1.5 native resolution — do not change
const IMG_STEPS    = 20;     // 15–20 steps is a good balance; lower = faster but worse quality
const IMG_CFG      = 7.0;    // SD 1.5 works best at 7–8
const IMG_POLL_MS  = 1500;   // poll /history every 1.5 s while waiting for the image
const IMG_TIMEOUT  = 600000; // 10-minute hard timeout for very slow hardware

// ════════════════════════════════════════════════════════════════════════════════
// APP STATE
// ════════════════════════════════════════════════════════════════════════════════

let PORT         = 8745;
let busy         = false;
let welcomed     = false;

// chatHistory renamed from 'history' to avoid clash with DOM window.history
let chatHistory: HistoryEntry[] = [];

let lastCode:    { code: string; lang: string } | null = null;

// Multi-chat state
let activeChatId: string | null = null;  // null = unsaved new chat
let sidebarCache: ChatMeta[]    = [];    // local copy of sidebar list

// Image Forge state
let imageMode       = false;
let lastImageBase64: string | null = null;

// Current persisted config (loaded on init, updated by settings panel)
let currentConfig: AppConfig = {
  theme:      'normal',
  accent:     '#CC0000',
  background: '#000000',
  textColor:  '#CC0000',
  font:       'Arial',
  models:     [],
};

// ════════════════════════════════════════════════════════════════════════════════
// COLOR UTILITIES
// ════════════════════════════════════════════════════════════════════════════════

/** Mix two hex colors. t=0 → c1, t=1 → c2. */
function mixHex(c1: string, c2: string, t: number): string {
  const p = (h: string) => [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ];
  const [r1, g1, b1] = p(c1);
  const [r2, g2, b2] = p(c2);
  const r = Math.round(r1 * (1 - t) + r2 * t);
  const g = Math.round(g1 * (1 - t) + g2 * t);
  const b = Math.round(b1 * (1 - t) + b2 * t);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

/** Brighten a hex color by adding `amount` to each RGB channel. */
function lightenHex(hex: string, amount: number): string {
  const r = Math.min(255, parseInt(hex.slice(1, 3), 16) + amount);
  const g = Math.min(255, parseInt(hex.slice(3, 5), 16) + amount);
  const b = Math.min(255, parseInt(hex.slice(5, 7), 16) + amount);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

// ════════════════════════════════════════════════════════════════════════════════
// THEME APPLICATION
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Apply normal (fully customizable) theme by setting CSS custom properties.
 * The whole UI palette is derived from the single accent + background picks.
 */
function applyNormalTheme(cfg: AppConfig): void {
  document.body.classList.remove('theme-aero', 'theme-dune');
  document.getElementById('aero-scene')?.remove();
  document.getElementById('dune-scene')?.remove();

  const root   = document.documentElement;
  const accent = cfg.accent;
  const bg     = cfg.background;

  // Derive the full palette from accent + background
  root.style.setProperty('--bg',        bg);
  root.style.setProperty('--fg',        accent);
  root.style.setProperty('--fg-hi',     lightenHex(accent, 51));
  root.style.setProperty('--fg-dim',    mixHex(accent, bg, 0.82));
  root.style.setProperty('--fg-muted',  mixHex(accent, bg, 0.55));
  root.style.setProperty('--input-bg',  mixHex(bg, '#060606', 0.5));
  root.style.setProperty('--btn-bg',    mixHex(accent, bg, 0.93));
  root.style.setProperty('--btn-hover', mixHex(accent, bg, 0.86));
  root.style.setProperty('--code-bg',   mixHex(accent, bg, 0.96));
  root.style.setProperty('--code-line', lightenHex(accent, 30));

  // Message text colors — text color sets AI text; user text is a lighter tint
  root.style.setProperty('--ai-text',   cfg.textColor);
  root.style.setProperty('--user-text', lightenHex(cfg.textColor, 60));

  // Global font
  document.body.style.fontFamily = cfg.font + ', Arial, sans-serif';
}

/**
 * Apply Frutiger Aero theme — adds the CSS class and injects the scene layer.
 * All colors are fixed in CSS; JS only manages the scene DOM and class toggling.
 */
function applyAeroTheme(): void {
  document.body.classList.remove('theme-dune');
  document.body.classList.add('theme-aero');
  document.body.style.fontFamily = '';
  document.getElementById('dune-scene')?.remove();

  // Strip any custom properties set by normal theme so they don't bleed through
  const varsToReset = ['--bg','--fg','--fg-hi','--fg-dim','--fg-muted',
                       '--input-bg','--btn-bg','--btn-hover','--code-bg',
                       '--code-line','--ai-text','--user-text'];
  for (const v of varsToReset) document.documentElement.style.removeProperty(v);

  injectAeroScene();
}

/** Inject Frutiger Aero background: clouds + glass buildings. */
function injectAeroScene(): void {
  document.getElementById('aero-scene')?.remove();

  const scene = document.createElement('div');
  scene.id = 'aero-scene';

  // ── Clouds ──────────────────────────────────────────────────────────────────
  // Each cloud is a blurred radial-gradient ellipse
  const clouds: Array<{ top: string; left?: string; right?: string; w: number; h: number }> = [
    { top: '10%', left:  '7%',  w: 185, h: 78 },
    { top:  '5%', left: '19%',  w: 118, h: 54 },
    { top: '17%', left: '44%',  w: 204, h: 88 },
    { top:  '8%', left: '60%',  w: 138, h: 58 },
    { top: '20%', right: '7%',  w: 162, h: 72 },
    { top:  '4%', right:'20%',  w: 96,  h: 46 },
  ];

  for (const c of clouds) {
    const el = document.createElement('div');
    el.className = 'aero-cloud';
    el.style.width  = c.w + 'px';
    el.style.height = c.h + 'px';
    el.style.top    = c.top;
    if (c.left  !== undefined) el.style.left  = c.left;
    if (c.right !== undefined) el.style.right = c.right;
    scene.appendChild(el);
  }

  // ── Buildings ────────────────────────────────────────────────────────────────
  // Positioned with bottom = grass line (~37% from viewport bottom)
  const buildings: Array<{ left?: string; right?: string; w: number; h: number }> = [
    { left:  '11%', w: 54,  h: 185 },
    { left:  '17%', w: 36,  h: 238 },
    { left:  '23%', w: 62,  h: 152 },
    { right: '13%', w: 58,  h: 208 },
    { right: '21%', w: 40,  h: 162 },
    { right: '28%', w: 52,  h: 118 },
  ];

  for (const b of buildings) {
    const el = document.createElement('div');
    el.className     = 'aero-building';
    el.style.width   = b.w + 'px';
    el.style.height  = b.h + 'px';
    el.style.bottom  = '37%';  // align base to grass line
    if (b.left  !== undefined) el.style.left  = b.left;
    if (b.right !== undefined) el.style.right = b.right;
    scene.appendChild(el);
  }

  // Insert as the very first child so it stays behind all app content
  document.body.insertBefore(scene, document.body.firstChild);
}

/** Apply Dune theme — cinematic desert aesthetic with warm glass panels. */
function applyDuneTheme(): void {
  document.body.classList.remove('theme-aero');
  document.body.classList.add('theme-dune');
  document.body.style.fontFamily = '';
  document.getElementById('aero-scene')?.remove();

  const varsToReset = ['--bg','--fg','--fg-hi','--fg-dim','--fg-muted',
                       '--input-bg','--btn-bg','--btn-hover','--code-bg',
                       '--code-line','--ai-text','--user-text'];
  for (const v of varsToReset) document.documentElement.style.removeProperty(v);

  injectDuneScene();
}

/** Inject layered SVG dune silhouettes + floating spice-dust particles. */
function injectDuneScene(): void {
  document.getElementById('dune-scene')?.remove();

  const scene = document.createElement('div');
  scene.id = 'dune-scene';

  // ── SVG dune silhouettes ──────────────────────────────────────────────────
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg   = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 1200 340');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.style.cssText = 'position:absolute;bottom:0;left:0;width:100%;height:58%;pointer-events:none;';

  const duneShapes: Array<[string, string]> = [
    // Far dune ridge
    ['M0,340 L0,195 Q80,165 200,182 Q340,200 480,148 Q580,110 700,132 Q820,155 960,118 Q1080,88 1200,105 L1200,340 Z',
     'rgba(185,130,55,0.55)'],
    // Far crest highlight
    ['M0,195 Q80,165 200,182 Q340,200 480,148 Q580,110 700,132 Q820,155 960,118 Q1080,88 1200,105 L1200,115 Q1080,98 960,130 Q820,167 700,142 Q580,120 480,158 Q340,210 200,192 Q80,175 0,205 Z',
     'rgba(255,210,130,0.28)'],
    // Mid dune
    ['M0,340 L0,240 Q120,210 280,228 Q430,246 580,195 Q700,155 840,178 Q960,200 1100,162 Q1160,148 1200,155 L1200,340 Z',
     'rgba(160,100,35,0.70)'],
    // Mid crest highlight
    ['M0,240 Q120,210 280,228 Q430,246 580,195 Q700,155 840,178 Q960,200 1100,162 Q1160,148 1200,155 L1200,165 Q1160,158 1100,172 Q960,212 840,188 Q700,165 580,205 Q430,256 280,238 Q120,220 0,250 Z',
     'rgba(255,200,100,0.22)'],
    // Foreground dune
    ['M0,340 L0,282 Q90,262 220,272 Q360,283 500,252 Q640,220 760,238 Q880,256 1000,228 Q1100,208 1200,215 L1200,340 Z',
     'rgba(130,78,18,0.88)'],
    // Front crest highlight
    ['M0,282 Q90,262 220,272 Q360,283 500,252 Q640,220 760,238 Q880,256 1000,228 Q1100,208 1200,215 L1200,226 Q1100,218 1000,238 Q880,266 760,248 Q640,230 500,262 Q360,293 220,282 Q90,272 0,292 Z',
     'rgba(255,185,80,0.30)'],
  ];

  for (const [d, fill] of duneShapes) {
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', fill);
    svg.appendChild(path);
  }
  scene.appendChild(svg);

  // ── Floating spice/dust motes ─────────────────────────────────────────────
  const positions = [
    [12,18],[28,42],[45,12],[62,35],[78,22],[18,55],
    [36,28],[55,48],[71,15],[85,38],[93,25],[8,62],
  ];
  for (const [lp, tp] of positions) {
    const p = document.createElement('div');
    p.className               = 'dune-particle';
    p.style.left              = lp + '%';
    p.style.top               = tp + '%';
    const sz                  = 1.5 + Math.random() * 3;
    p.style.width             = sz + 'px';
    p.style.height            = sz + 'px';
    p.style.animationDelay    = (Math.random() * 7).toFixed(2) + 's';
    p.style.animationDuration = (5 + Math.random() * 8).toFixed(2) + 's';
    scene.appendChild(p);
  }

  document.body.insertBefore(scene, document.body.firstChild);
}

/** Apply saved config: pick the correct theme and push all settings. */
function applyConfig(cfg: AppConfig): void {
  if (cfg.theme === 'aero') {
    applyAeroTheme();
  } else if (cfg.theme === 'dune') {
    applyDuneTheme();
  } else {
    applyNormalTheme(cfg);
  }
  updateSettingsUI(cfg);
}

/** Persist current config to disk via IPC. */
async function saveConfig(): Promise<void> {
  await window.aetherforge.configSet(currentConfig);
}

/** Push the model list from config to the backend's in-memory MODELS dict. */
async function syncModelsToBackend(): Promise<void> {
  if (!currentConfig.models.length) return;
  const modelsObj: Record<string, string> = {};
  for (const m of currentConfig.models) modelsObj[m.name] = m.tag;
  try {
    await fetch(`http://127.0.0.1:${PORT}/models/set`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ models: modelsObj }),
    });
  } catch {
    // Backend not yet ready — will use default models until next sync
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// DOM REFERENCES
// ════════════════════════════════════════════════════════════════════════════════

// ── Main UI ──────────────────────────────────────────────────────────────────
const welcomeEl   = document.getElementById('welcome')       as HTMLDivElement;
const messagesEl  = document.getElementById('messages')      as HTMLDivElement;
const chatArea    = document.getElementById('chat-area')     as HTMLDivElement;
const modelSelect = document.getElementById('model-select')  as HTMLSelectElement;
const modelLabel  = document.getElementById('model-label')   as HTMLSpanElement;
const inputEl     = document.getElementById('input')         as HTMLTextAreaElement;
const btnSend     = document.getElementById('btn-send')      as HTMLButtonElement;
const btnSave     = document.getElementById('btn-save')      as HTMLButtonElement;
const btnImgForge = document.getElementById('btn-img-forge') as HTMLButtonElement;
const btnMin      = document.getElementById('btn-min')       as HTMLButtonElement;
const btnMax      = document.getElementById('btn-max')       as HTMLButtonElement;
const btnClose    = document.getElementById('btn-close')     as HTMLButtonElement;
const btnNewChat  = document.getElementById('btn-new-chat')  as HTMLButtonElement;
const chatListEl  = document.getElementById('chat-list')     as HTMLDivElement;

// ── Settings panel ────────────────────────────────────────────────────────────
const btnSettings       = document.getElementById('btn-settings')       as HTMLButtonElement;
const settingsPanel     = document.getElementById('settings-panel')     as HTMLDivElement;
const settingsOverlay   = document.getElementById('settings-overlay')   as HTMLDivElement;
const btnSettingsClose  = document.getElementById('btn-settings-close') as HTMLButtonElement;
const pickAccent        = document.getElementById('pick-accent')        as HTMLInputElement;
const pickBg            = document.getElementById('pick-bg')            as HTMLInputElement;
const pickText          = document.getElementById('pick-text')          as HTMLInputElement;
const pickFont          = document.getElementById('pick-font')          as HTMLSelectElement;
const appearanceSection = document.getElementById('appearance-section') as HTMLElement;
const aeroNoteSection   = document.getElementById('aero-note-section')  as HTMLElement;
const duneNoteSection   = document.getElementById('dune-note-section')  as HTMLElement;
const settingsModelList = document.getElementById('settings-model-list') as HTMLDivElement;
const newModelNameEl    = document.getElementById('new-model-name')     as HTMLInputElement;
const newModelTagEl     = document.getElementById('new-model-tag')      as HTMLInputElement;
const btnAddModel       = document.getElementById('btn-add-model')      as HTMLButtonElement;

// ════════════════════════════════════════════════════════════════════════════════
// SETTINGS PANEL  —  open / close / sync UI
// ════════════════════════════════════════════════════════════════════════════════

function openSettings(): void {
  settingsPanel.classList.add('open');
  settingsPanel.setAttribute('aria-hidden', 'false');
  renderSettingsModels();
}

function closeSettings(): void {
  settingsPanel.classList.remove('open');
  settingsPanel.setAttribute('aria-hidden', 'true');
}

/** Sync the settings panel UI widgets to match the given config. */
function updateSettingsUI(cfg: AppConfig): void {
  const isAero = cfg.theme === 'aero';
  const isDune = cfg.theme === 'dune';
  const isLocked = isAero || isDune;

  // Theme button active state
  document.querySelectorAll<HTMLButtonElement>('.theme-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset['theme'] === cfg.theme);
  });

  // Show/hide appearance vs locked-theme note
  appearanceSection.classList.toggle('hidden', isLocked);
  aeroNoteSection.classList.toggle('hidden',  !isAero);
  duneNoteSection.classList.toggle('hidden',  !isDune);

  // Sync color picker values
  pickAccent.value = cfg.accent;
  pickBg.value     = cfg.background;
  pickText.value   = cfg.textColor;

  // Sync font selector (find the option whose text matches the font name)
  for (let i = 0; i < pickFont.options.length; i++) {
    if (pickFont.options[i].value === cfg.font) { pickFont.selectedIndex = i; break; }
  }

  // Disable all customisation controls in locked modes
  pickAccent.disabled = isLocked;
  pickBg.disabled     = isLocked;
  pickText.disabled   = isLocked;
  pickFont.disabled   = isLocked;
}

/** Render the model list inside the settings drawer. */
function renderSettingsModels(): void {
  settingsModelList.innerHTML = '';

  if (!currentConfig.models.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'font-size:10px;color:var(--fg-muted);padding:4px 0 8px;';
    empty.textContent   = 'No models configured.';
    settingsModelList.appendChild(empty);
    return;
  }

  for (const model of currentConfig.models) {
    const item = document.createElement('div');
    item.className = 'settings-model-item';

    const info    = document.createElement('div');
    info.className = 'settings-model-info';

    const nameEl = document.createElement('div');
    nameEl.className   = 'settings-model-name';
    nameEl.textContent = model.name;

    const tagEl = document.createElement('div');
    tagEl.className   = 'settings-model-tag';
    tagEl.textContent = model.tag;

    info.appendChild(nameEl);
    info.appendChild(tagEl);

    const delBtn = document.createElement('button');
    delBtn.className   = 'settings-model-del';
    delBtn.textContent = '✕';
    delBtn.title       = 'Remove model';
    // Capture `model` in closure
    const modelName = model.name;
    delBtn.addEventListener('click', async () => {
      if (!confirm(`Remove model "${modelName}"?`)) return;
      currentConfig.models = currentConfig.models.filter(m => m.name !== modelName);
      await saveConfig();
      await syncModelsToBackend();
      await loadModels();
      renderSettingsModels();
    });

    item.appendChild(info);
    item.appendChild(delBtn);
    settingsModelList.appendChild(item);
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// UTILITY HELPERS
// ════════════════════════════════════════════════════════════════════════════════

/** Collision-resistant ID using timestamp + random suffix. */
function generateChatId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Truncate a user message to use as a chat title. */
function makeChatTitle(text: string): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  return clean.length > 45 ? clean.slice(0, 42) + '…' : clean;
}

/** Compact relative/absolute timestamp for the sidebar. */
function formatDate(ts: number): string {
  const d   = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  const daysDiff = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (daysDiff === 1) return 'Yesterday';
  if (daysDiff < 7)  return `${daysDiff}d ago`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// ════════════════════════════════════════════════════════════════════════════════
// SIDEBAR  —  render / refresh / actions
// ════════════════════════════════════════════════════════════════════════════════

/** Rebuild the sidebar list from a ChatMeta array. */
function renderSidebar(chats: ChatMeta[]): void {
  sidebarCache    = chats;
  chatListEl.innerHTML = '';

  for (const meta of chats) {
    const item = document.createElement('div');
    item.className   = 'chat-item' + (meta.id === activeChatId ? ' active' : '');
    item.dataset['chatId'] = meta.id;

    const titleEl = document.createElement('div');
    titleEl.className   = 'chat-item-title';
    titleEl.textContent = meta.title || 'New Chat';

    const dateEl = document.createElement('div');
    dateEl.className   = 'chat-item-date';
    dateEl.textContent = formatDate(meta.updatedAt);

    const delBtn = document.createElement('button');
    delBtn.className   = 'chat-item-del';
    delBtn.textContent = '✕';
    delBtn.title       = 'Delete chat';
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${meta.title || 'this chat'}"?`)) return;
      await window.aetherforge.chatDelete(meta.id);
      if (meta.id === activeChatId) startNewChat();
      const updated = await window.aetherforge.chatList();
      renderSidebar(updated);
    });

    item.appendChild(titleEl);
    item.appendChild(dateEl);
    item.appendChild(delBtn);
    item.addEventListener('click', () => openChat(meta.id));
    chatListEl.appendChild(item);
  }
}

/** Load and display a saved chat by id. */
async function openChat(id: string): Promise<void> {
  const stored = await window.aetherforge.chatLoad(id);
  if (!stored) return;

  // Reset view
  messagesEl.innerHTML = '';
  welcomeEl.style.display = 'none';
  welcomed    = true;
  chatHistory = [];
  lastCode    = null;
  btnSave.disabled = true;
  activeChatId = id;

  // Restore model selector if the option exists
  const opt = modelSelect.querySelector(`option[value="${stored.model}"]`);
  if (opt) modelSelect.value = stored.model;

  // Replay all messages through the existing render pipeline
  for (const msg of stored.messages) {
    if (msg.role === 'user') {
      const body = addBlock('you', '[ YOU ]');
      body.textContent = msg.content;
    } else if (msg.role === 'assistant') {
      const body = addBlock('ai', '[ AETHERFORGE ]');
      renderResponse(body, msg.content);
    }
    chatHistory.push(msg);
  }

  scrollBottom();
  renderSidebar(sidebarCache);  // refresh active highlight in sidebar
}

/** Reset to a blank new-chat session. */
function startNewChat(): void {
  activeChatId = null;
  chatHistory  = [];
  lastCode     = null;
  btnSave.disabled = true;
  welcomed     = false;

  messagesEl.innerHTML    = '';
  welcomeEl.style.display = '';
  welcomeEl.classList.remove('fade-out');

  renderSidebar(sidebarCache);  // clears active highlight
  inputEl.focus();
}

/** Encrypt and save the current chat; refresh the sidebar. */
async function autoSave(): Promise<void> {
  if (!chatHistory.length) return;

  const now   = Date.now();
  const title = makeChatTitle(
    chatHistory.find(m => m.role === 'user')?.content ?? 'New Chat'
  );

  if (activeChatId === null) activeChatId = generateChatId();

  // Preserve original createdAt when updating an existing chat
  const existing   = sidebarCache.find(m => m.id === activeChatId);
  const createdAt  = existing ? existing.createdAt : now;

  await window.aetherforge.chatSave({
    id:        activeChatId,
    title,
    createdAt,
    updatedAt: now,
    model:     modelSelect.value,
    messages:  chatHistory.slice(),
  });

  const updated = await window.aetherforge.chatList();
  renderSidebar(updated);
}

// ════════════════════════════════════════════════════════════════════════════════
// WELCOME OVERLAY
// ════════════════════════════════════════════════════════════════════════════════

function dismissWelcome(): void {
  if (welcomed) return;
  welcomed = true;
  welcomeEl.classList.add('fade-out');
  setTimeout(() => { welcomeEl.style.display = 'none'; }, 750);
}

// ════════════════════════════════════════════════════════════════════════════════
// CHAT DOM HELPERS
// ════════════════════════════════════════════════════════════════════════════════

function scrollBottom(): void { chatArea.scrollTop = chatArea.scrollHeight; }

/** Add a labelled message block; return the body container. */
function addBlock(who: 'you' | 'ai' | 'sys', label: string): HTMLElement {
  const block = document.createElement('div');
  block.className = 'msg-block';

  const lbl = document.createElement('div');
  lbl.className   = `msg-lbl ${who}`;
  lbl.textContent = label;

  const body = document.createElement('div');
  body.className  = `msg-body ${who}`;

  block.appendChild(lbl);
  block.appendChild(body);
  messagesEl.appendChild(block);
  scrollBottom();
  return body;
}

function addSystem(text: string, isError = false): void {
  const body = addBlock('sys', '[ SYSTEM ]');
  body.className  = `msg-body ${isError ? 'err' : 'sys'}`;
  body.textContent = text;
  scrollBottom();
}

function showThinking(): HTMLElement {
  const block = document.createElement('div');
  block.className = 'msg-block';

  const lbl = document.createElement('div');
  lbl.className   = 'msg-lbl ai';
  lbl.textContent = '[ AETHERFORGE ]';

  const dots = document.createElement('div');
  dots.className  = 'thinking';
  dots.innerHTML  = '<span></span><span></span><span></span>';

  block.appendChild(lbl);
  block.appendChild(dots);
  messagesEl.appendChild(block);
  scrollBottom();
  return block;
}

// ════════════════════════════════════════════════════════════════════════════════
// CODE BLOCK RENDERING
// ════════════════════════════════════════════════════════════════════════════════

const CODE_RE = /```(\w*)\n?([\s\S]*?)```/g;

interface CodeBlock { lang: string; code: string; start: number; end: number; }

function parseCodeBlocks(text: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  let m: RegExpExecArray | null;
  CODE_RE.lastIndex = 0;
  while ((m = CODE_RE.exec(text)) !== null) {
    blocks.push({ lang: m[1].trim(), code: m[2].trim(), start: m.index, end: m.index + m[0].length });
  }
  return blocks;
}

/** Replace body's content with rendered text + code widgets. */
function renderResponse(body: HTMLElement, raw: string): void {
  body.innerHTML = '';
  const blocks   = parseCodeBlocks(raw);

  if (!blocks.length) {
    body.textContent = raw;
    return;
  }

  // Update the global lastCode so SAVE CODE works after replaying a chat
  const last = blocks[blocks.length - 1];
  lastCode = { code: last.code, lang: last.lang };
  btnSave.disabled = false;

  let cursor = 0;
  for (const blk of blocks) {
    const before = raw.slice(cursor, blk.start);
    if (before.trim()) {
      const t = document.createElement('div');
      t.className   = 'msg-body ai';
      t.textContent = before;
      body.appendChild(t);
    }
    body.appendChild(buildCodeWidget(blk.lang, blk.code));
    cursor = blk.end;
  }

  const after = raw.slice(cursor);
  if (after.trim()) {
    const t = document.createElement('div');
    t.className   = 'msg-body ai';
    t.textContent = after;
    body.appendChild(t);
  }
}

function buildCodeWidget(lang: string, code: string): HTMLElement {
  const ext = LANG_EXT[lang.toLowerCase()] ?? '.txt';

  const widget  = document.createElement('div');
  widget.className = 'code-widget';

  const header  = document.createElement('div');
  header.className = 'code-header';

  const langTag = document.createElement('span');
  langTag.className   = 'code-lang';
  langTag.textContent = lang || 'code';

  const saveBtn = document.createElement('button');
  saveBtn.className   = 'code-save';
  saveBtn.textContent = 'SAVE';
  saveBtn.addEventListener('click', async () => {
    await handleSave({ code, lang }, saveBtn);
  });

  header.appendChild(langTag);
  header.appendChild(saveBtn);

  const pre = document.createElement('div');
  pre.className   = 'code-body';
  pre.textContent = code;

  widget.appendChild(header);
  widget.appendChild(pre);
  return widget;
}

// ════════════════════════════════════════════════════════════════════════════════
// SAVE CODE
// ════════════════════════════════════════════════════════════════════════════════

async function handleSave(
  entry: { code: string; lang: string } | null,
  inlineBtn?: HTMLButtonElement
): Promise<void> {
  if (!entry) {
    addSystem('No code found yet. Ask the AI to write some code first.');
    return;
  }

  const ext    = LANG_EXT[entry.lang.toLowerCase()] ?? '.txt';
  const result = await window.aetherforge.saveFile({
    content:     entry.code,
    defaultName: `aetherforge_code${ext}`,
    ext,
  });

  if (result.success && result.filePath) {
    addSystem(`Saved → ${result.filePath}`);
    if (inlineBtn) { inlineBtn.textContent = 'SAVED'; inlineBtn.classList.add('saved'); }
  } else if (!result.success && result.error) {
    addSystem(`Save failed: ${result.error}`, true);
  }
  // User cancelled dialog → silent
}

// ════════════════════════════════════════════════════════════════════════════════
// BACKEND MODEL LOADING
// ════════════════════════════════════════════════════════════════════════════════

async function loadModels(): Promise<void> {
  // Preserve the current selection so adding/removing a model doesn't reset it
  const prev = modelSelect.value;
  try {
    const res  = await fetch(`http://127.0.0.1:${PORT}/models`);
    const data = await res.json() as { models: string[] };
    modelSelect.innerHTML = '';
    if (!data.models.length) {
      modelSelect.innerHTML = '<option value="">No models</option>';
      return;
    }
    for (const name of data.models) {
      const opt = document.createElement('option');
      opt.value = name; opt.textContent = name;
      modelSelect.appendChild(opt);
    }
    // Restore previous selection if the model still exists
    if (prev && modelSelect.querySelector(`option[value="${prev}"]`)) {
      modelSelect.value = prev;
    }
  } catch {
    modelSelect.innerHTML = '<option value="">Backend unavailable</option>';
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// SEND  —  main message flow
// ════════════════════════════════════════════════════════════════════════════════

async function handleSend(): Promise<void> {
  if (busy) return;

  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = '';

  // ─── Image Forge mode: route to ComfyUI generation ─────────────────────────
  if (imageMode) {
    busy = true;
    btnSend.disabled    = true;
    btnSend.textContent = '  …  ';
    try {
      await handleImageForge(text);
    } finally {
      busy = false;
      btnSend.disabled    = false;
      btnSend.textContent = 'FORGE ▶';
    }
    return;
  }

  // ─── Text chat mode ─────────────────────────────────────────────────────────
  dismissWelcome();

  // Render user message
  const youBody = addBlock('you', '[ YOU ]');
  youBody.textContent = text;

  // Intercept save commands — handled locally, never sent to AI
  const cleaned = text.toLowerCase().trim().replace(/[.,!?]+$/, '');
  if (SAVE_TRIGGERS.indexOf(cleaned) !== -1) {
    await handleSave(lastCode);
    return;
  }

  chatHistory.push({ role: 'user', content: text });

  const model = modelSelect.value;
  if (!model) { addSystem('No model selected.', true); return; }

  busy = true;
  btnSend.disabled    = true;
  btnSend.textContent = '  …  ';

  // In Aero/Dune mode, intensify the backdrop blur while the AI is responding
  if (currentConfig.theme === 'aero') chatArea.classList.add('aero-responding');
  if (currentConfig.theme === 'dune') chatArea.classList.add('dune-responding');

  const thinkingBlock = showThinking();

  let aiBody:  HTMLElement | null = null;
  let rawText  = '';
  let firstTok = true;

  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/chat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ model_name: model, messages: chatHistory }),
    });

    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let   buf     = '';

    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') break outer;

        let parsed: { token?: string; error?: string };
        try { parsed = JSON.parse(payload); } catch { continue; }

        if (parsed.error) {
          thinkingBlock.remove();
          addSystem(`Error from backend: ${parsed.error}`, true);
          chatArea.classList.remove('aero-responding', 'dune-responding');
          resetUI();
          return;
        }

        if (parsed.token) {
          if (firstTok) {
            thinkingBlock.remove();
            aiBody   = addBlock('ai', '[ AETHERFORGE ]');
            firstTok = false;
          }
          rawText += parsed.token;
          if (aiBody) aiBody.textContent = rawText;   // plain text during stream
          scrollBottom();
        }
      }
    }

  } catch (err: unknown) {
    thinkingBlock.remove();
    addSystem(`Connection error: ${String(err)}`, true);
    rawText = `[ERROR] ${String(err)}`;
  }

  // Remove responding blur class once streaming is done
  chatArea.classList.remove('aero-responding', 'dune-responding');

  // Post-process: render code blocks once streaming completes
  if (aiBody && rawText && !rawText.startsWith('[ERROR]')) {
    renderResponse(aiBody, rawText);
  }

  if (rawText) {
    chatHistory.push({ role: 'assistant', content: rawText });

    // Auto-save the conversation after every successful AI response
    if (!rawText.startsWith('[ERROR]')) {
      await autoSave();
    }
  }

  resetUI();
  scrollBottom();
}

function resetUI(): void {
  busy = false;
  btnSend.disabled    = false;
  btnSend.textContent = 'SEND ▶';
}

// ════════════════════════════════════════════════════════════════════════════════
// IMAGE FORGE — ComfyUI + PixArt-Sigma local image generation
// ════════════════════════════════════════════════════════════════════════════════

/** Build a minimal ComfyUI API workflow for Stable Diffusion 1.5. */
function buildPixArtWorkflow(prompt: string, seed: number): object {
  return {
    "1": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": PIXART_MODEL } },
    "2": { "class_type": "CLIPTextEncode", "inputs": { "clip": ["1", 1], "text": prompt } },
    "3": { "class_type": "CLIPTextEncode", "inputs": { "clip": ["1", 1], "text": "" } },
    "4": { "class_type": "EmptyLatentImage", "inputs": { "width": IMG_W, "height": IMG_H, "batch_size": 1 } },
    "5": {
      "class_type": "KSampler",
      "inputs": {
        "model": ["1", 0], "positive": ["2", 0], "negative": ["3", 0],
        "latent_image": ["4", 0],
        "seed": seed, "steps": IMG_STEPS, "cfg": IMG_CFG,
        "sampler_name": "euler", "scheduler": "normal", "denoise": 1.0
      }
    },
    "6": { "class_type": "VAEDecode", "inputs": { "samples": ["5", 0], "vae": ["1", 2] } },
    "7": { "class_type": "SaveImage", "inputs": { "filename_prefix": "AetherforgeImg", "images": ["6", 0] } }
  };
}

async function checkComfyUI(): Promise<boolean> {
  try {
    const res = await fetch(`${COMFY_URL}/system_stats`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch { return false; }
}

async function submitComfyPrompt(workflow: object): Promise<string> {
  const clientId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const res = await fetch(`${COMFY_URL}/prompt`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ client_id: clientId, prompt: workflow }),
  });
  if (!res.ok) throw new Error(`ComfyUI rejected prompt: HTTP ${res.status}`);
  const data = await res.json() as { prompt_id: string; error?: unknown };
  if (data.error) throw new Error(`ComfyUI error: ${JSON.stringify(data.error)}`);
  return data.prompt_id;
}

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary  = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function pollComfyResult(promptId: string): Promise<string> {
  const deadline = Date.now() + IMG_TIMEOUT;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, IMG_POLL_MS));

    const res  = await fetch(`${COMFY_URL}/history/${promptId}`);
    const hist = await res.json() as Record<string, {
      outputs?: Record<string, {
        images?: { filename: string; subfolder: string; type: string }[];
      }>;
    }>;

    const entry = hist[promptId];
    if (!entry?.outputs) continue;

    for (const node of Object.values(entry.outputs)) {
      const imgInfo = node.images?.[0];
      if (!imgInfo) continue;

      const { filename, subfolder, type } = imgInfo;
      const viewUrl = `${COMFY_URL}/view?filename=${encodeURIComponent(filename)}`
                    + `&subfolder=${encodeURIComponent(subfolder)}`
                    + `&type=${encodeURIComponent(type)}`;

      const imgRes = await fetch(viewUrl);
      if (!imgRes.ok) throw new Error(`Failed to fetch image: HTTP ${imgRes.status}`);
      return bufferToBase64(await imgRes.arrayBuffer());
    }
  }

  throw new Error('Image generation timed out (10 min). Low-end hardware may need more time.');
}

async function generateImage(prompt: string): Promise<string> {
  const seed     = Math.floor(Math.random() * 2 ** 32);
  const workflow = buildPixArtWorkflow(prompt, seed);
  const promptId = await submitComfyPrompt(workflow);
  return pollComfyResult(promptId);
}

function enterImageMode(): void {
  imageMode = true;
  btnImgForge.classList.add('active');
  btnImgForge.textContent    = '◀ TEXT MODE';
  modelLabel.style.display   = 'none';
  modelSelect.style.display  = 'none';
  inputEl.placeholder        = 'Describe the image to forge…   (Enter → generate)';
  btnSend.textContent        = 'FORGE ▶';
  btnSave.textContent        = 'SAVE IMG';
  btnSave.disabled           = lastImageBase64 === null;
}

function exitImageMode(): void {
  imageMode = false;
  btnImgForge.classList.remove('active');
  btnImgForge.textContent   = 'IMAGE FORGE';
  modelLabel.style.display  = '';
  modelSelect.style.display = '';
  inputEl.placeholder       = 'Type a message…   (Enter → send  ·  Shift+Enter → newline)';
  btnSend.textContent       = 'SEND ▶';
  btnSave.textContent       = 'SAVE CODE';
  btnSave.disabled          = lastCode === null;
}

async function handleImageForge(prompt: string): Promise<void> {
  dismissWelcome();

  const youBody = addBlock('you', '[ YOU ]');
  youBody.textContent = prompt;

  const forgeBlock     = document.createElement('div');
  forgeBlock.className = 'msg-block';

  const forgeLbl       = document.createElement('div');
  forgeLbl.className   = 'msg-lbl ai';
  forgeLbl.textContent = '[ IMAGE FORGE ]';

  const forgeStatus        = document.createElement('div');
  forgeStatus.className    = 'msg-body err';
  forgeStatus.textContent  = 'Forging image…';

  forgeBlock.appendChild(forgeLbl);
  forgeBlock.appendChild(forgeStatus);
  messagesEl.appendChild(forgeBlock);
  scrollBottom();

  if (!(await checkComfyUI())) {
    forgeStatus.textContent =
      'ComfyUI is not running.\n\n' +
      'Start it:  python main.py --listen 127.0.0.1 --port 8188\n' +
      'Model:     place ' + PIXART_MODEL + '\n' +
      '           in <ComfyUI>/models/checkpoints/';
    return;
  }

  try {
    const base64 = await generateImage(prompt);
    lastImageBase64 = base64;

    forgeStatus.className   = 'msg-body ai';
    forgeStatus.textContent = '';
    const img               = document.createElement('img');
    img.className           = 'forge-img';
    img.src                 = `data:image/png;base64,${base64}`;
    img.alt                 = prompt;
    forgeStatus.appendChild(img);

    btnSave.disabled = false;
    scrollBottom();
  } catch (err: unknown) {
    forgeStatus.textContent = `Image generation failed: ${String(err)}`;
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ════════════════════════════════════════════════════════════════════════════════

async function init(): Promise<void> {
  PORT = await window.aetherforge.getPort();

  // ── Load and immediately apply saved config (theme/colors/font/models) ──────
  currentConfig = await window.aetherforge.configGet();
  applyConfig(currentConfig);

  // ── Sync model list to backend, then populate the dropdown ──────────────────
  await syncModelsToBackend();
  await loadModels();

  inputEl.focus();

  // ── Input / send bindings ────────────────────────────────────────────────────
  inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  });
  btnSend.addEventListener('click', () => handleSend());

  // Save button: handles both code (text mode) and images (Image Forge mode)
  btnSave.addEventListener('click', async () => {
    if (imageMode) {
      if (!lastImageBase64) return;
      const result = await window.aetherforge.saveImage({
        base64:      lastImageBase64,
        defaultName: `aetherforge_image_${Date.now()}.png`,
      });
      if (result.success && result.filePath) addSystem(`Image saved → ${result.filePath}`);
      else if (!result.success && result.error) addSystem(`Save failed: ${result.error}`, true);
    } else {
      await handleSave(lastCode);
    }
  });

  // IMAGE FORGE toggle
  btnImgForge.addEventListener('click', () => {
    if (busy) return;
    imageMode ? exitImageMode() : enterImageMode();
  });

  // Window controls
  btnMin.addEventListener('click',   () => window.aetherforge.windowControls.minimize());
  btnMax.addEventListener('click',   () => window.aetherforge.windowControls.maximize());
  btnClose.addEventListener('click', () => window.aetherforge.windowControls.close());

  // Show an in-app notice if the backend was updated this launch
  window.aetherforge.onUpdateApplied((info) => {
    addSystem(`Aetherforge updated: v${info.from} → v${info.to}  ·  Restart to apply model changes.`);
  });

  // New-chat button
  btnNewChat.addEventListener('click', () => startNewChat());

  // ── Settings panel ───────────────────────────────────────────────────────────

  // Open/close
  btnSettings.addEventListener('click', openSettings);
  settingsOverlay.addEventListener('click', closeSettings);
  btnSettingsClose.addEventListener('click', closeSettings);

  // Theme toggle buttons
  document.querySelectorAll<HTMLButtonElement>('.theme-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const theme = btn.dataset['theme'] as 'normal' | 'aero' | 'dune';
      currentConfig.theme = theme;
      applyConfig(currentConfig);
      await saveConfig();
    });
  });

  // Accent color — live preview on `input`, persist on `change`
  pickAccent.addEventListener('input', () => {
    currentConfig.accent = pickAccent.value;
    applyNormalTheme(currentConfig);
  });
  pickAccent.addEventListener('change', async () => {
    currentConfig.accent = pickAccent.value;
    applyNormalTheme(currentConfig);
    await saveConfig();
  });

  // Background color
  pickBg.addEventListener('input', () => {
    currentConfig.background = pickBg.value;
    applyNormalTheme(currentConfig);
  });
  pickBg.addEventListener('change', async () => {
    currentConfig.background = pickBg.value;
    applyNormalTheme(currentConfig);
    await saveConfig();
  });

  // Text color
  pickText.addEventListener('input', () => {
    currentConfig.textColor = pickText.value;
    applyNormalTheme(currentConfig);
  });
  pickText.addEventListener('change', async () => {
    currentConfig.textColor = pickText.value;
    applyNormalTheme(currentConfig);
    await saveConfig();
  });

  // Font selector
  pickFont.addEventListener('change', async () => {
    currentConfig.font = pickFont.value;
    applyNormalTheme(currentConfig);
    await saveConfig();
  });

  // Add model — validate inputs, push to backend, refresh dropdown
  btnAddModel.addEventListener('click', async () => {
    const name = newModelNameEl.value.trim();
    const tag  = newModelTagEl.value.trim();

    // Visual validation
    if (!name || !tag) {
      if (!name) { newModelNameEl.style.borderColor = '#ff4444'; setTimeout(() => { newModelNameEl.style.borderColor = ''; }, 1500); }
      if (!tag)  { newModelTagEl.style.borderColor  = '#ff4444'; setTimeout(() => { newModelTagEl.style.borderColor  = ''; }, 1500); }
      return;
    }

    if (currentConfig.models.some(m => m.name === name)) {
      alert(`A model named "${name}" already exists.`);
      return;
    }

    currentConfig.models.push({ name, tag });
    newModelNameEl.value = '';
    newModelTagEl.value  = '';

    await saveConfig();
    await syncModelsToBackend();
    await loadModels();
    renderSettingsModels();
  });

  // ── Load sidebar and open most recent chat (if any) ──────────────────────────
  const chats = await window.aetherforge.chatList();
  renderSidebar(chats);

  if (chats.length > 0) {
    await openChat(chats[0].id);   // list is sorted newest-first by main process
  }
}

document.addEventListener('DOMContentLoaded', init);
