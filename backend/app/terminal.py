"""Real terminal for Velocity: a login shell on a PTY, streamed over a WebSocket.

Register in backend/app/main.py:
    from .terminal import router as terminal_router
    app.include_router(terminal_router)

Needs WebSocket support:  pip install "uvicorn[standard]"
"""
import asyncio
import fcntl
import json
import os
import pty
import signal
import struct
import termios
from pathlib import Path

from fastapi import APIRouter, WebSocket

router = APIRouter()

# A shell is full access to your machine. Only the Velocity dev server may open one;
# this blocks any other website from connecting to ws://localhost:8000.
ALLOWED_ORIGINS = {"http://localhost:5173", "http://127.0.0.1:5173"}


def set_size(fd: int, rows: int, cols: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


@router.websocket("/terminal/ws")
async def terminal_ws(ws: WebSocket, root: str = "", cols: int = 80, rows: int = 24):
    if ws.headers.get("origin") not in ALLOWED_ORIGINS:
        await ws.close(code=1008)
        return

    cwd = root if root and Path(root).is_dir() else str(Path.home())
    await ws.accept()

    pid, fd = pty.fork()
    if pid == 0:  # child process: become the shell
        os.chdir(cwd)
        shell = os.environ.get("SHELL", "/bin/zsh")
        env = {**os.environ, "TERM": "xterm-256color", "COLORTERM": "truecolor"}
        os.execvpe(shell, [shell, "-l"], env)

    set_size(fd, rows, cols)
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()

    def on_readable():
        try:
            data = os.read(fd, 65536)
        except OSError:
            data = b""
        queue.put_nowait(data)
        if not data:
            loop.remove_reader(fd)

    loop.add_reader(fd, on_readable)

    async def pump_output():
        while True:
            data = await queue.get()
            if not data:  # shell exited (user typed `exit`)
                await ws.close()
                return
            await ws.send_bytes(data)

    out_task = asyncio.create_task(pump_output())

    try:
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                break
            text = msg.get("text")
            if text is not None:
                try:
                    ev = json.loads(text)
                except ValueError:
                    continue
                if ev.get("type") == "input":
                    os.write(fd, ev["data"].encode())
                elif ev.get("type") == "resize":
                    set_size(fd, int(ev["rows"]), int(ev["cols"]))
            elif msg.get("bytes"):
                os.write(fd, msg["bytes"])
    except RuntimeError:
        pass  # socket already closed
    finally:
        out_task.cancel()
        try:
            loop.remove_reader(fd)
        except Exception:
            pass
        try:
            os.kill(pid, signal.SIGHUP)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            pass
        try:
            os.close(fd)
        except OSError:
            pass
