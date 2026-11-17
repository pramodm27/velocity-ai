from fastapi.testclient import TestClient
from app.main import app
from pathlib import Path

client = TestClient(app)

def test_all():
    # 1. Health check
    res = client.get("/health")
    assert res.status_code == 200, f"Health check failed: {res.text}"
    assert res.json() == {"status": "ok"}
    print("✓ Health check passed")

    # 2. Workspace index
    cwd = str(Path("..").resolve())
    res = client.post("/workspace/index", json={"root": cwd})
    assert res.status_code == 200, f"Index failed: {res.text}"
    data = res.json()
    assert data["file_count"] > 0, "Expected file count > 0"
    assert any("main.py" in f for f in data["files"]), "main.py should be in files"
    assert not any("node_modules" in f for f in data["files"]), "node_modules should be excluded"
    print(f"✓ Index passed: {data['file_count']} files found")

    # 3. Workspace index invalid
    res = client.post("/workspace/index", json={"root": "/nonexistent/path/xyz"})
    assert res.status_code == 400, f"Expected 400, got: {res.status_code}"
    print("✓ Invalid index passed")

    # 4. Workspace search
    res = client.post("/workspace/search", json={"root": cwd, "query": "FastAPI", "limit": 5})
    assert res.status_code == 200, f"Search failed: {res.text}"
    results = res.json()["results"]
    assert len(results) > 0, "Expected search results for FastAPI"
    print(f"✓ Search passed: {len(results)} hits found")

    # 5. Workspace read
    res = client.post("/workspace/read", json={"root": cwd, "path": "backend/app/main.py"})
    assert res.status_code == 200, f"Read failed: {res.text}"
    assert "FastAPI" in res.json()["content"]
    print("✓ Read passed")

    # 6. Workspace read invalid (directory traversal / escaping)
    res = client.post("/workspace/read", json={"root": cwd, "path": "../../etc/passwd"})
    assert res.status_code == 400, f"Expected 400 for path traversal, got: {res.status_code}"
    print("✓ Traversal rejection passed")

    # 7. Workspace save
    tmp_path = "backend/test_save.tmp"
    res = client.post("/workspace/save", json={"root": cwd, "path": tmp_path, "content": "print('hello_save')"})
    assert res.status_code == 200, f"Save failed: {res.text}"
    # Verify content
    saved_file = Path(cwd) / tmp_path
    assert saved_file.read_text() == "print('hello_save')"
    saved_file.unlink()
    print("✓ Save passed")

    # 8. Terminal execution
    res = client.post("/terminal/execute", json={"root": cwd, "command": "echo hello_velocity"})
    assert res.status_code == 200, f"Terminal failed: {res.text}"
    assert "hello_velocity" in res.json()["stdout"]
    assert res.json()["returncode"] == 0
    print("✓ Terminal execute passed")

    # 9. Terminal blocked command
    res = client.post("/terminal/execute", json={"root": cwd, "command": "sudo rm -rf /"})
    assert res.status_code == 403, f"Expected 403 for blocked command, got: {res.status_code}"
    print("✓ Blocked command passed")

    # 10. Terminal invalid workspace
    res = client.post("/terminal/execute", json={"root": "/invalid/root", "command": "echo 1"})
    assert res.status_code == 400, f"Expected 400 for invalid root, got: {res.status_code}"
    print("✓ Terminal invalid root passed")

    # 11. Chat stream invalid root
    res = client.post("/chat/stream", json={"root": "/invalid/root", "message": "hi"})
    assert res.status_code == 400, f"Expected 400 for invalid root, got: {res.status_code}"
    print("✓ Chat invalid root passed")

    print("\nALL BACKEND API TESTS PASSED!")

if __name__ == "__main__":
    test_all()
