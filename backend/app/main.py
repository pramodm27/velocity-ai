import json
import subprocess
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .model import complete, stream
from .repository import context, files, rootpath, search

app = FastAPI(title="Velocity AI IDE")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

class Root(BaseModel):
    root: str

class Search(Root):
    query: str
    limit: int = 8

class Read(Root):
    path: str

class SaveFile(Root):
    path: str
    content: str

class Chat(Root):
    message: str
    history: list[dict] = Field(default_factory=list)

class Completion(Root):
    path: str = ""
    prefix: str
    suffix: str = ""

class Terminal(Root):
    command: str
    cwd: str = ""

@app.get("/health")
def health():
    return {"status": "ok"}

@app.post("/workspace/index")
def index(x: Root):
    try:
        r = rootpath(x.root)
        f = files(r)
        return {"root": str(r), "file_count": len(f), "files": f}
    except ValueError as e:
        raise HTTPException(400, str(e))

@app.post("/workspace/search")
def find(x: Search):
    try:
        r = rootpath(x.root)
        return {"results": search(r, x.query, min(30, x.limit))}
    except ValueError as e:
        raise HTTPException(400, str(e))

@app.post("/workspace/read")
def read(x: Read):
    try:
        r = rootpath(x.root)
        p = (r / x.path).resolve()
        if not p.is_relative_to(r) or not p.is_file():
            raise ValueError("Invalid file path")
        if p.stat().st_size > 1_000_000:
            raise ValueError("File over 1 MB")
        return {"path": x.path, "content": p.read_text(errors="replace")}
    except ValueError as e:
        raise HTTPException(400, str(e))

@app.post("/workspace/save")
def save(x: SaveFile):
    try:
        r = rootpath(x.root)
        p = (r / x.path).resolve()
        if not p.is_relative_to(r):
            raise ValueError("Invalid file path")
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(x.content, encoding="utf-8")
        return {"status": "ok", "path": x.path}
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, str(e))

@app.post("/completion")
async def completion(x: Completion):
    try:
        r = rootpath(x.root)
    except ValueError as e:
        raise HTTPException(400, str(e))
    hits = search(r, x.prefix[-500:], 4)
    ctx = context(r, [h["path"] for h in hits])
    prompt = (
        f"Return only code to insert at cursor. No markdown/explanation. File {x.path}. Context:\n"
        f"{ctx}\nBefore cursor:\n{x.prefix[-2500:]}\nAfter:\n{x.suffix[:500]}"
    )
    result = await complete([
        {"role": "system", "content": "You are a concise inline autocomplete engine."},
        {"role": "user", "content": prompt}
    ])
    return {"completion": result}

@app.post("/chat/stream")
async def chat(x: Chat):
    try:
        r = rootpath(x.root)
    except ValueError as e:
        raise HTTPException(400, str(e))
    hits = search(r, x.message, 8)
    ctx = context(r, [h["path"] for h in hits])
    system_prompt = (
        "You are Velocity, an expert coding assistant. Use repository context and cite paths. Do not claim to run tools.\n"
        + ctx
    )
    msgs = [{"role": "system", "content": system_prompt}]
    for h in x.history[-10:]:
        if isinstance(h, dict) and h.get("content") and h.get("role") in ("user", "assistant", "system"):
            msgs.append({"role": h["role"], "content": str(h["content"])})
    msgs.append({"role": "user", "content": x.message})

    async def events():
        try:
            async for t in stream(msgs):
                yield f"data: {json.dumps({'token': t})}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(events(), media_type="text/event-stream")

@app.post("/terminal/execute")
def terminal(x: Terminal):
    try:
        dir_to_use = rootpath(x.cwd if x.cwd else x.root)
    except ValueError as e:
        raise HTTPException(400, str(e))

    cmd_clean = x.command.strip()
    if not cmd_clean:
        return {"stdout": "", "stderr": "", "returncode": 0, "cwd": str(dir_to_use)}

    if any(z in cmd_clean for z in ["rm -rf /", "sudo ", "shutdown", "reboot", "mkfs", "dd if="]):
        raise HTTPException(403, "Command blocked")

    # Native cd support
    if cmd_clean == "cd" or cmd_clean.startswith("cd "):
        target = cmd_clean[3:].strip() if cmd_clean.startswith("cd ") else "~"
        try:
            check = subprocess.run(
                f"cd {target} && pwd",
                shell=True,
                cwd=dir_to_use,
                capture_output=True,
                text=True,
                timeout=5
            )
            if check.returncode == 0:
                new_cwd = check.stdout.strip()
                return {"stdout": "", "stderr": "", "returncode": 0, "cwd": new_cwd}
            else:
                return {
                    "stdout": check.stdout,
                    "stderr": check.stderr,
                    "returncode": check.returncode,
                    "cwd": str(dir_to_use)
                }
        except Exception as e:
            return {"stdout": "", "stderr": str(e), "returncode": 1, "cwd": str(dir_to_use)}

    try:
        p = subprocess.run(
            cmd_clean,
            shell=True,
            cwd=dir_to_use,
            capture_output=True,
            text=True,
            stdin=subprocess.DEVNULL,
            timeout=20
        )
        return {
            "stdout": p.stdout[-15000:],
            "stderr": p.stderr[-15000:],
            "returncode": p.returncode,
            "cwd": str(dir_to_use)
        }
    except subprocess.TimeoutExpired as e:
        stdout = (e.stdout or "")[-15000:]
        stderr = (e.stderr or "")[-15000:]
        return {
            "stdout": stdout,
            "stderr": (stderr + "\n[Command timed out after 20s]").strip(),
            "returncode": 124,
            "cwd": str(dir_to_use)
        }
