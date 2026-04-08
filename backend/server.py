#!/usr/bin/env python3
"""
Aetherforge backend — FastAPI server that wraps Ollama with SSE token streaming.
Run directly:  python server.py [port]
Electron spawns this automatically; do not run manually while the app is open.
"""

import json
import sys
from typing import AsyncGenerator

import ollama
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

app = FastAPI(title="Aetherforge Backend")

# Allow all origins — only the local Electron renderer connects here
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Friendly display names → Ollama model identifiers
MODELS: dict[str, str] = {
    "Aetherforge_v1_general" : "huihui_ai/dolphin3-abliterated",
    "Aetherforge_v1_reasoning": "huihui_ai/phi4-reasoning-abliterated:3.8b",
    "Aetherforge_v1_code"    : "huihui_ai/qwen3.5-abliterated:4b",
    "Aetherforge_v1_learn"   : "huihui_ai/lfm2.5-abliterated",
}


class Message(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    model_name: str          # display name, e.g. "General Void"
    messages: list[Message]


class ModelsPayload(BaseModel):
    models: dict[str, str]  # display_name → ollama_tag


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/models")
def get_models():
    """Return the list of available model display names."""
    return {"models": list(MODELS.keys())}


@app.post("/models/set")
def set_models(payload: ModelsPayload):
    """Replace the in-memory MODELS dict. Called by the renderer on startup/change."""
    global MODELS
    if payload.models:
        MODELS = payload.models
    return {"status": "ok", "count": len(MODELS)}


async def token_stream(model_id: str, messages: list[dict]) -> AsyncGenerator[str, None]:
    """Yield SSE lines.  Each content chunk: data: {"token": "..."}
    Final sentinel:  data: [DONE]
    Error line:      data: {"error": "..."}
    """
    try:
        stream = ollama.chat(model=model_id, messages=messages, stream=True)
        for chunk in stream:
            # Ollama library may use dict or attribute access depending on version
            try:
                piece: str = chunk["message"]["content"]
            except (KeyError, TypeError):
                piece = getattr(getattr(chunk, "message", None), "content", "") or ""

            if piece:
                yield f"data: {json.dumps({'token': piece})}\n\n"

    except Exception as exc:
        msg = str(exc)
        # Give a helpful pull-command when Ollama reports the model is missing
        if 'not found' in msg.lower() or '404' in msg:
            yield f"data: {json.dumps({'error': f'Model not found. Run:  ollama pull {model_id}'})}\n\n"
        else:
            yield f"data: {json.dumps({'error': msg})}\n\n"
    finally:
        yield "data: [DONE]\n\n"


@app.post("/chat")
def chat(req: ChatRequest):
    model_id = MODELS.get(req.model_name)
    if not model_id:
        raise HTTPException(status_code=400, detail=f"Unknown model: {req.model_name!r}")

    messages = [{"role": m.role, "content": m.content} for m in req.messages]

    return StreamingResponse(
        token_stream(model_id, messages),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",   # disable nginx buffering if behind a proxy
        },
    )


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8745
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="error")
