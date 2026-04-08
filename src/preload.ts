/**
 * Aetherforge preload — contextBridge between main and renderer.
 */

import { contextBridge, ipcRenderer } from 'electron';

interface HistoryEntry { role: string; content: string; }
interface ChatMeta { id: string; title: string; createdAt: number; updatedAt: number; model: string; }
interface StoredChat extends ChatMeta { messages: HistoryEntry[]; }
interface UpdateInfo  { updated: boolean; from: string; to: string; }
interface AppConfig {
  theme:      'normal' | 'aero' | 'dune';
  accent:     string;
  background: string;
  textColor:  string;
  font:       string;
  models:     Array<{ name: string; tag: string }>;
}

contextBridge.exposeInMainWorld('aetherforge', {

  getPort: (): Promise<number> =>
    ipcRenderer.invoke('get-port'),

  /** One-time callback fired when the window is ready if a backend update was applied. */
  onUpdateApplied: (cb: (info: UpdateInfo) => void): void => {
    ipcRenderer.once('update-applied', (_evt, info: UpdateInfo) => cb(info));
  },

  saveFile: (opts: { content: string; defaultName: string; ext: string })
    : Promise<{ success: boolean; filePath?: string; error?: string }> =>
    ipcRenderer.invoke('save-file', opts),

  // Save a generated PNG image (base64-encoded) via OS save dialog.
  saveImage: (opts: { base64: string; defaultName: string })
    : Promise<{ success: boolean; filePath?: string; error?: string }> =>
    ipcRenderer.invoke('save-image', opts),

  showInFolder: (fp: string): void =>
    ipcRenderer.send('show-in-folder', fp),

  windowControls: {
    minimize: (): void => ipcRenderer.send('win-minimize'),
    maximize: (): void => ipcRenderer.send('win-maximize'),
    close:    (): void => ipcRenderer.send('win-close'),
  },

  // ── Encrypted chat persistence (OS keychain via safeStorage) ──────────────

  chatList:   (): Promise<ChatMeta[]>            => ipcRenderer.invoke('chat:list'),
  chatLoad:   (id: string): Promise<StoredChat | null> => ipcRenderer.invoke('chat:load', id),
  chatSave:   (chat: StoredChat): Promise<void>  => ipcRenderer.invoke('chat:save', chat),
  chatDelete: (id: string): Promise<void>        => ipcRenderer.invoke('chat:delete', id),

  // ── App config (theme, colors, font, models) ────────────────────────────────
  configGet: (): Promise<AppConfig>          => ipcRenderer.invoke('config:get'),
  configSet: (cfg: AppConfig): Promise<void> => ipcRenderer.invoke('config:set', cfg),
});
