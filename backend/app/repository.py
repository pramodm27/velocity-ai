import os
from pathlib import Path

SKIP = {".git", "node_modules", "dist", "build", ".next", ".venv", "venv", "__pycache__"}
EXT = {
    ".py", ".js", ".jsx", ".ts", ".tsx", ".java", ".go", ".rs", ".cpp", ".c",
    ".h", ".cs", ".rb", ".php", ".html", ".css", ".json", ".yaml", ".yml",
    ".toml", ".md", ".txt", ".sh", ".sql"
}

def rootpath(s: str) -> Path:
    if not s or not s.strip():
        raise ValueError("Workspace path cannot be empty")
    p = Path(s).expanduser().resolve()
    if not p.is_dir():
        raise ValueError(f"Workspace must be an existing directory: {s}")
    return p

def files(root: Path):
    result = []
    root_str = str(root)
    for dirpath, dirnames, filenames in os.walk(root_str):
        # Prune skipped directories in-place so os.walk doesn't even enter them
        dirnames[:] = [d for d in dirnames if d not in SKIP and not d.startswith(".")]
        for fn in filenames:
            ext = os.path.splitext(fn)[1].lower()
            if ext in EXT:
                full_path = os.path.join(dirpath, fn)
                try:
                    if os.path.getsize(full_path) < 1_000_000:
                        result.append(os.path.relpath(full_path, root_str))
                except OSError:
                    continue
    return sorted(result)[:10000]

def search(root: Path, q: str, n: int = 8):
    terms = [x.lower() for x in q.split() if x.strip()]
    if not terms:
        return []
    out = []
    for f in files(root):
        try:
            lines = (root / f).read_text(errors="ignore").splitlines()
        except OSError:
            continue
        found = [
            (sum(t in l.lower() for t in terms), i, l[:250])
            for i, l in enumerate(lines)
            if any(t in l.lower() for t in terms)
        ]
        if found:
            s, i, l = max(found)
            out.append({"path": f, "score": sum(x[0] for x in found), "line": i + 1, "snippet": l})
    return sorted(out, key=lambda x: x["score"], reverse=True)[:n]

def context(root: Path, paths, limit: int = 16000) -> str:
    out = ""
    for f in paths:
        try:
            p = (root / f).resolve()
            if p.is_relative_to(root) and p.is_file():
                block = f"\n--- {f} ---\n" + p.read_text(errors="ignore")[:5000]
                if len(out) + len(block) > limit:
                    break
                out += block
        except OSError:
            continue
    return out
