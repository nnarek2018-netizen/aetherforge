# Aetherforge

A local-first AI desktop client built on Electron + Python. Runs entirely on your machine — no cloud, no subscriptions, no data leaves your device.

Powered by [Ollama](https://ollama.com) for language models and [ComfyUI](https://github.com/comfyanonymous/ComfyUI) for image generation.

---

## Features

- **Uncensored local AI** — uses abliterated Ollama models by default; swap in any model you like
- **SSE streaming** — responses appear token by token in real time
- **Multi-chat sidebar** — all conversations encrypted at rest via OS keychain (`safeStorage`)
- **Code detection** — code blocks are parsed out of responses with per-block SAVE buttons
- **Image Forge** — generate images locally via ComfyUI + Stable Diffusion 1.5
- **Theme system** — fully customisable Normal theme (accent colour, background, text colour, font) or the locked **Frutiger Aero** theme (glass panels, sky gradient, CSS buildings)
- **Model management** — add and remove Ollama models from the Settings panel without touching any config files
- **Auto-updating backend** — the Python server updates itself from the bundled version on each launch without reinstalling the app

---

## Requirements

| Dependency | Minimum | Notes |
|---|---|---|
| [Node.js](https://nodejs.org) | 18+ | For building/running the Electron shell |
| [Python](https://python.org) | 3.10+ | For the FastAPI backend |
| [Ollama](https://ollama.com) | latest | Must be running before launching Aetherforge |
| [ComfyUI](https://github.com/comfyanonymous/ComfyUI) | optional | Only needed for Image Forge |

---

## Quick start

```bash
# 1. Clone
git clone https://github.com/nnarek2018-netizen/aetherforge.git
cd aetherforge

# 2. Install everything (Node deps + Python deps)
setup.bat          # Windows
# or manually:
pip install fastapi "uvicorn[standard]" ollama pydantic
npm install

# 3. Pull at least one model via Ollama
ollama pull huihui_ai/dolphin3-abliterated

# 4. Start Ollama (if not already running as a service)
ollama serve

# 5. Launch
start.bat          # Windows
# or:
npm start
```

---

## Models

Aetherforge ships with four pre-configured models. Pull whichever ones you want:

```bash
ollama pull huihui_ai/dolphin3-abliterated            # General
ollama pull huihui_ai/phi4-reasoning-abliterated:3.8b # Reasoning
ollama pull huihui_ai/qwen3.5-abliterated:4b          # Code
ollama pull huihui_ai/lfm2.5-abliterated              # Learning
```

You can add any other Ollama model from the **Settings → Models** panel inside the app. Just enter a display name and the Ollama tag (e.g. `llama3:latest`).

To build the default models into a custom persona, use the included Modelfile:

```bash
ollama create Aetherforge_v1 -f Aetherforge_Modelfile
```

---

## Image Forge (optional)

Image generation requires ComfyUI running locally with Stable Diffusion 1.5.

```bash
# Install ComfyUI
git clone https://github.com/comfyanonymous/ComfyUI.git
cd ComfyUI && pip install -r requirements.txt

# Download the model
# File: v1-5-pruned-emaonly.safetensors (~4 GB)
# Source: https://huggingface.co/runwayml/stable-diffusion-v1-5
# Place it in: ComfyUI/models/checkpoints/

# Start ComfyUI on the expected port
python main.py --listen 127.0.0.1 --port 8188
```

Then click **IMAGE FORGE** in the titlebar to switch modes.

---

## Settings

Open the **⚙** button in the top bar.

### Normal theme
| Setting | What it does |
|---|---|
| Accent Color | Drives the entire UI chrome — borders, buttons, labels |
| Background | Main app background |
| Text Color | AI message text colour |
| Font | Body font; falls back to Arial if not installed |

All changes are applied instantly and saved to `config.json`.

### Frutiger Aero theme
A locked aesthetic mode — sky gradient background, CSS glass buildings, frosted-glass panels on all UI elements. The backdrop blur intensifies while the AI is responding. Colour pickers are disabled in this mode.

### Model management
- **List** — shows all configured display names and their Ollama tags
- **Remove** — removes a model from the app (does not delete it from Ollama)
- **Add** — enter a display name + Ollama tag to make it available in the dropdown

---

## Build a distributable

```bash
build.bat
```

Produces two files in `release/`:
- `Aetherforge Setup 1.0.0.exe` — NSIS installer (per-user, no admin required)
- `Aetherforge 1.0.0.exe` — portable single-file executable

> **Note:** Python must be installed on the target machine, and Ollama must be running before launching the app.

---

## Project structure

```
aetherforge/
├── src/
│   ├── main.ts          Electron main process — window, IPC, backend lifecycle
│   ├── preload.ts       Context bridge — exposes safe APIs to the renderer
│   ├── renderer.ts      All UI logic — chat, themes, settings, image forge
│   ├── index.html       Single-page shell
│   └── styles.css       All styling — Normal theme tokens + Frutiger Aero theme
├── backend/
│   ├── server.py        FastAPI server — Ollama SSE wrapper, model management
│   └── VERSION          Semver string used by the auto-updater
├── dist/                Compiled JS output (git-ignored, rebuilt by npm run build)
├── Aetherforge_Modelfile  Ollama Modelfile for the default persona
├── package.json
├── tsconfig.json        Compiler config for main + preload (commonjs)
├── tsconfig.renderer.json  Compiler config for renderer (module: none)
├── setup.bat            One-time dependency installer
├── start.bat            Dev launcher
└── build.bat            Production build + packaging
```

### How the backend auto-update works

On every launch, the main process compares the `VERSION` file bundled inside the exe (`resources/backend/VERSION`) against the one in `AppData/.../backend/VERSION`. If the bundled version is newer, it overwrites the installed backend folder before spawning the server. This means you can ship backend updates without requiring users to reinstall — just bump the version, rebuild, and distribute the new exe.

---

## Architecture notes

- **No bundler / no framework** — the renderer is compiled TypeScript with `"module": "none"`, producing a plain script tag. No webpack, no React, no Tailwind.
- **IPC boundary** — all Node/Electron APIs are gated through the `contextBridge` in `preload.ts`. The renderer only sees `window.aetherforge`.
- **Encrypted chat storage** — conversations are stored as `.enc` files in `AppData` using Electron's `safeStorage` (OS keychain on Windows). They are unreadable without the same OS user account.
- **Config file** — theme, colours, font, and model list are stored in plain JSON at `AppData/.../config.json`. Deleting it resets all settings to defaults.
- **Port discovery** — the backend starts on port `8745` by default; if that port is taken, it scans upward until it finds a free one. The port is passed to the renderer via IPC at startup.

---

## License

MIT
