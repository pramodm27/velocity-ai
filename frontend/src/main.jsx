import React, { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

import {
  Code,
  Folder,
  Search,
  Terminal as Term,
  Play,
  Bot,
  Send,
  Save,
  Sparkles,
  Plus,
  X,
  Trash2,
  ChevronDown
} from "lucide-react";

import Editor from "@monaco-editor/react";

const H = { "Content-Type": "application/json" };

let cachedApiBase = null;

async function getApiBase() {
  if (cachedApiBase) return cachedApiBase;
  const candidates = ["http://127.0.0.1:8000", "http://localhost:8000"];
  for (const base of candidates) {
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), 1200);
      const res = await fetch(base + "/health", { signal: controller.signal });
      clearTimeout(id);
      if (res.ok) {
        cachedApiBase = base;
        return base;
      }
    } catch (e) {}
  }
  cachedApiBase = "http://127.0.0.1:8000";
  return cachedApiBase;
}

async function apiFetch(endpoint, options = {}) {
  const base = await getApiBase();
  try {
    return await fetch(base + endpoint, options);
  } catch (err) {
    const alt = base.includes("127.0.0.1") ? "http://localhost:8000" : "http://127.0.0.1:8000";
    try {
      const res = await fetch(alt + endpoint, options);
      cachedApiBase = alt;
      return res;
    } catch (err2) {
      throw err;
    }
  }
}

function getLanguage(filename) {
  if (!filename) return "plaintext";
  const ext = filename.split(".").pop().toLowerCase();
  const map = {
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    ts: "typescript", tsx: "typescript",
    py: "python",
    html: "html", htm: "html",
    css: "css", scss: "scss", less: "less",
    json: "json",
    md: "markdown", markdown: "markdown",
    sh: "shell", bash: "shell", zsh: "shell",
    yml: "yaml", yaml: "yaml",
    sql: "sql",
    rs: "rust",
    go: "go",
    java: "java",
    c: "c", cpp: "cpp", h: "c", hpp: "cpp",
    cs: "csharp",
    rb: "ruby",
    php: "php",
    xml: "xml",
    toml: "ini"
  };
  return map[ext] || "plaintext";
}

function formatPromptPath(fullPath) {
  if (!fullPath) return "~";
  const replaced = fullPath.replace(/^\/Users\/[^/]+/, "~");
  const parts = replaced.split("/").filter(Boolean);
  if (parts.length > 4) {
    return ".../" + parts.slice(-3).join("/");
  }
  return replaced;
}

function App() {
  const [root, setRoot] = useState(localStorage.root || "");
  const [files, setFiles] = useState([]);
  const [active, setActive] = useState("");
  const [code, setCode] = useState("");
  const [q, setQ] = useState("");
  const [chat, setChat] = useState([
    { role: "assistant", content: "Welcome to Velocity. Index a workspace and ask about your code." }
  ]);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [term, setTerm] = useState(false);
  const [status, setStatus] = useState("Ready");
  const [aiBusy, setAiBusy] = useState(false);

  // Multi-terminal state
  const [terminals, setTerminals] = useState([
    {
      id: 1,
      name: "Terminal 1",
      cwd: localStorage.root || "",
      lines: [
        { type: "system", text: "Velocity Shell v1.0 — Type any shell command (ls, npm test, git status, cd ...)" }
      ],
      cmdHistory: [],
      historyIdx: -1,
      input: "",
      busy: false
    }
  ]);
  const [activeTermId, setActiveTermId] = useState(1);

  const end = useRef();
  const editorRef = useRef(null);
  const termEndRef = useRef(null);
  const termInputRef = useRef(null);

  const activeTerm = terminals.find(t => t.id === activeTermId) || terminals[0];

  useEffect(() => {
    if (termEndRef.current) {
      termEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [activeTerm?.lines, activeTerm?.busy]);

  useEffect(() => {
    if (term && termInputRef.current) {
      termInputRef.current.focus();
    }
  }, [term, activeTermId]);

  useEffect(() => {
    if (localStorage.root) {
      loadWorkspace(localStorage.root);
    }
  }, []);

  async function loadWorkspace(dir) {
    if (!dir || !dir.trim()) return;
    try {
      setStatus("Indexing…");
      const r = await apiFetch("/workspace/index", {
        method: "POST",
        headers: H,
        body: JSON.stringify({ root: dir })
      });
      const d = await r.json();
      if (!r.ok) throw Error(d.detail || "Failed to index");
      setFiles(d.files || []);
      setStatus((d.file_count || 0) + " files indexed");
      if (d.files && d.files.length > 0 && !active) {
        openFile(dir, d.files[0]);
      }
      setTerminals(prev =>
        prev.map(t => (!t.cwd ? { ...t, cwd: dir } : t))
      );
    } catch (e) {
      setStatus("Index failed: " + e.message);
    }
  }

  async function index() {
    if (!root.trim()) {
      setStatus("Please enter a workspace directory path");
      return;
    }
    localStorage.root = root;
    await loadWorkspace(root);
  }

  async function openFile(rootDir, path) {
    setActive(path);
    try {
      const r = await apiFetch("/workspace/read", {
        method: "POST",
        headers: H,
        body: JSON.stringify({ root: rootDir || root, path })
      });
      const d = await r.json();
      if (!r.ok) throw Error(d.detail || "Failed to read file");
      setCode(d.content || "");
    } catch (e) {
      setCode("// " + e.message);
    }
  }

  function open(path) {
    openFile(root, path);
  }

  async function save() {
    if (!active || !root) return;
    try {
      setStatus("Saving " + active + "…");
      const r = await apiFetch("/workspace/save", {
        method: "POST",
        headers: H,
        body: JSON.stringify({ root, path: active, content: code })
      });
      const d = await r.json();
      if (!r.ok) throw Error(d.detail || "Save failed");
      setStatus("Saved " + active);
    } catch (e) {
      setStatus("Save failed: " + e.message);
    }
  }

  async function triggerAiComplete() {
    if (!active || !root || aiBusy || !editorRef.current) return;
    const editor = editorRef.current;
    const position = editor.getPosition();
    const model = editor.getModel();
    if (!position || !model) return;

    const offset = model.getOffsetAt(position);
    const fullText = model.getValue();
    const prefix = fullText.slice(0, offset);
    const suffix = fullText.slice(offset);

    setAiBusy(true);
    setStatus("Generating inline completion…");
    try {
      const r = await apiFetch("/completion", {
        method: "POST",
        headers: H,
        body: JSON.stringify({ root, path: active, prefix, suffix })
      });
      const d = await r.json();
      if (!r.ok) throw Error(d.detail || "Completion failed");
      const snippet = d.completion || "";
      if (snippet && window.monaco) {
        editor.executeEdits("ai-autocomplete", [
          {
            range: new window.monaco.Range(
              position.lineNumber,
              position.column,
              position.lineNumber,
              position.column
            ),
            text: snippet
          }
        ]);
        setStatus("Autocomplete applied");
      } else {
        setStatus("No completion suggested");
      }
    } catch (e) {
      setStatus("AI completion failed: " + e.message);
    } finally {
      setAiBusy(false);
    }
  }

  function handleEditorMount(editor, monacoInstance) {
    editorRef.current = editor;
    window.monaco = monacoInstance;

    editor.addCommand(monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyS, () => {
      save();
    });
  }

  function addTerminal() {
    const newId = (Math.max(0, ...terminals.map(t => t.id)) || 0) + 1;
    const newTerm = {
      id: newId,
      name: `Terminal ${newId}`,
      cwd: activeTerm?.cwd || root || "",
      lines: [
        { type: "system", text: `Velocity Shell #${newId} initialized.` }
      ],
      cmdHistory: [],
      historyIdx: -1,
      input: "",
      busy: false
    };
    setTerminals(prev => [...prev, newTerm]);
    setActiveTermId(newId);
  }

  function closeTerminal(id, e) {
    e?.stopPropagation();
    if (terminals.length <= 1) return;
    const next = terminals.filter(t => t.id !== id);
    setTerminals(next);
    if (activeTermId === id) {
      setActiveTermId(next[0].id);
    }
  }

  function clearTerminal() {
    setTerminals(prev =>
      prev.map(t => (t.id === activeTermId ? { ...t, lines: [] } : t))
    );
  }

  function updateActiveTerminal(updater) {
    setTerminals(prev =>
      prev.map(t => (t.id === activeTermId ? updater(t) : t))
    );
  }

  async function executeTerminalCommand() {
    const termObj = activeTerm;
    const rawCmd = (termObj.input || "").trim();
    if (!rawCmd || termObj.busy) return;

    const termCwd = termObj.cwd || root || "";

    if (rawCmd === "clear") {
      updateActiveTerminal(t => ({
        ...t,
        lines: [],
        input: "",
        cmdHistory: [rawCmd, ...t.cmdHistory.filter(c => c !== rawCmd)],
        historyIdx: -1
      }));
      return;
    }

    const cmdEntry = {
      type: "cmd",
      path: termCwd,
      command: rawCmd,
      timestamp: new Date().toLocaleTimeString()
    };

    updateActiveTerminal(t => ({
      ...t,
      lines: [...t.lines, cmdEntry],
      input: "",
      busy: true,
      cmdHistory: [rawCmd, ...t.cmdHistory.filter(c => c !== rawCmd)],
      historyIdx: -1
    }));

    try {
      const r = await apiFetch("/terminal/execute", {
        method: "POST",
        headers: H,
        body: JSON.stringify({ root: root || termCwd, cwd: termCwd, command: rawCmd })
      });
      const d = await r.json();
      if (!r.ok) {
        updateActiveTerminal(t => ({
          ...t,
          busy: false,
          lines: [
            ...t.lines,
            { type: "error", text: d.detail || `Command failed with status ${r.status}` }
          ]
        }));
        return;
      }

      updateActiveTerminal(t => ({
        ...t,
        busy: false,
        cwd: d.cwd || t.cwd,
        lines: [
          ...t.lines,
          {
            type: "out",
            stdout: d.stdout || "",
            stderr: d.stderr || "",
            exitCode: d.returncode
          }
        ]
      }));
    } catch (e) {
      updateActiveTerminal(t => ({
        ...t,
        busy: false,
        lines: [...t.lines, { type: "error", text: "Error: " + e.message }]
      }));
    }
  }

  function handleTerminalKeyDown(e) {
    if (e.key === "Enter") {
      e.preventDefault();
      executeTerminalCommand();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const hist = activeTerm.cmdHistory;
      if (!hist.length) return;
      const nextIdx = Math.min(activeTerm.historyIdx + 1, hist.length - 1);
      updateActiveTerminal(t => ({
        ...t,
        historyIdx: nextIdx,
        input: hist[nextIdx] || ""
      }));
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const hist = activeTerm.cmdHistory;
      const nextIdx = activeTerm.historyIdx - 1;
      if (nextIdx < 0) {
        updateActiveTerminal(t => ({
          ...t,
          historyIdx: -1,
          input: ""
        }));
      } else {
        updateActiveTerminal(t => ({
          ...t,
          historyIdx: nextIdx,
          input: hist[nextIdx] || ""
        }));
      }
    }
  }

  async function send() {
    if (!msg.trim() || busy) return;

    const m = msg;
    setMsg("");
    setBusy(true);

    setChat(c => [
      ...c,
      { role: "user", content: m },
      { role: "assistant", content: "" }
    ]);

    try {
      const r = await apiFetch("/chat/stream", {
        method: "POST",
        headers: H,
        body: JSON.stringify({
          root,
          message: m,
          history: chat.slice(-8)
        })
      });

      if (!r.ok) {
        const errText = await r.text();
        throw Error(errText || `Server responded with ${r.status}`);
      }
      if (!r.body) throw Error("Streaming response unavailable");

      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let answer = "";

      const processEvent = (eventStr) => {
        const lines = eventStr.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") continue;
          if (!data) continue;
          const parsed = JSON.parse(data);
          if (parsed.error) throw Error(parsed.error);
          if (parsed.token) {
            answer += parsed.token;
            setChat(c => {
              const updated = [...c];
              updated[updated.length - 1] = {
                role: "assistant",
                content: answer
              };
              return updated;
            });
          }
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() || "";

        for (const event of events) {
          processEvent(event);
        }
      }

      buffer += decoder.decode();
      if (buffer.trim()) {
        processEvent(buffer);
      }
    } catch (e) {
      setChat(c => {
        const updated = [...c];
        updated[updated.length - 1] = {
          role: "assistant",
          content: "Error: " + e.message
        };
        return updated;
      });
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (end.current) {
      end.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [chat]);

  return (
    <main>
      <header>
        <div className="brand">
          <Code /> <b>Velocity</b><small>AI IDE</small>
        </div>
        <div className="root">
          <Folder />
          <input
            value={root}
            onChange={e => setRoot(e.target.value)}
            placeholder="Workspace absolute path (e.g. /Users/me/project)"
          />
          <button onClick={index}>Index</button>
        </div>
        <span className="status">{status}</span>
      </header>
      <section className="layout">
        <aside>
          <h4>EXPLORER</h4>
          <div className="filter">
            <Search />
            <input
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="Filter files"
            />
          </div>
          {files
            .filter(f => f.toLowerCase().includes(q.toLowerCase()))
            .map(f => (
              <button
                className={"file " + (f === active ? "sel" : "")}
                onClick={() => open(f)}
                key={f}
              >
                {f}
              </button>
            ))}
        </aside>
        <section className="work">
          <div className="tab">
            <span className="tab-title">{active || "Welcome"}</span>
            {active && (
              <div className="tab-actions">
                <button
                  className="btn-action"
                  title="AI Code Completion"
                  disabled={aiBusy}
                  onClick={triggerAiComplete}
                >
                  <Sparkles size={13} /> {aiBusy ? "Thinking…" : "AI Complete"}
                </button>
                <button
                  className="btn-action"
                  title="Save File (Ctrl+S / Cmd+S)"
                  onClick={save}
                >
                  <Save size={13} /> Save
                </button>
              </div>
            )}
          </div>
          <div className="editor">
            <Editor
              theme="vs-dark"
              language={getLanguage(active)}
              value={code}
              onMount={handleEditorMount}
              onChange={v => setCode(v || "")}
              options={{ fontSize: 13, minimap: { enabled: false }, automaticLayout: true }}
            />
          </div>
          <footer>
            <button
              className={"footer-term-btn " + (term ? "active" : "")}
              onClick={() => setTerm(!term)}
            >
              <Term size={14} /> Terminal {terminals.length > 1 ? `(${terminals.length})` : ""}
            </button>
            <span>Velocity • {active || "Workspace Ready"}</span>
          </footer>

          {term && (
            <div className="terminal-panel">
              <div className="terminal-header">
                <div className="terminal-tabs">
                  {terminals.map(t => (
                    <div
                      key={t.id}
                      className={"term-tab " + (t.id === activeTermId ? "sel" : "")}
                      onClick={() => setActiveTermId(t.id)}
                    >
                      <Term size={12} />
                      <span>{t.name}</span>
                      {terminals.length > 1 && (
                        <button
                          className="term-tab-close"
                          title="Close Terminal"
                          onClick={e => closeTerminal(t.id, e)}
                        >
                          <X size={11} />
                        </button>
                      )}
                    </div>
                  ))}
                  <button
                    className="term-add-btn"
                    title="New Terminal"
                    onClick={addTerminal}
                  >
                    <Plus size={13} />
                  </button>
                </div>
                <div className="terminal-actions">
                  <button
                    className="term-tool-btn"
                    title="Clear Screen"
                    onClick={clearTerminal}
                  >
                    <Trash2 size={13} />
                  </button>
                  <button
                    className="term-tool-btn"
                    title="Close Terminal Drawer"
                    onClick={() => setTerm(false)}
                  >
                    <ChevronDown size={14} />
                  </button>
                </div>
              </div>

              <div className="terminal-body" onClick={() => termInputRef.current?.focus()}>
                <div className="terminal-output">
                  {activeTerm.lines.map((item, idx) => {
                    if (item.type === "system") {
                      return (
                        <div key={idx} className="term-line term-system">
                          {item.text}
                        </div>
                      );
                    }
                    if (item.type === "cmd") {
                      return (
                        <div key={idx} className="term-line term-cmd-line">
                          <span className="term-prompt">
                            <span className="term-prompt-user">velocity</span>
                            <span className="term-prompt-sep">:</span>
                            <span className="term-prompt-path">{formatPromptPath(item.path)}</span>
                            <span className="term-prompt-sym"> ❯</span>
                          </span>
                          <span className="term-cmd-text">{item.command}</span>
                        </div>
                      );
                    }
                    if (item.type === "error") {
                      return (
                        <div key={idx} className="term-line term-error">
                          {item.text}
                        </div>
                      );
                    }
                    if (item.type === "out") {
                      return (
                        <div key={idx} className="term-line term-output-block">
                          {item.stdout && <pre className="term-stdout">{item.stdout}</pre>}
                          {item.stderr && <pre className="term-stderr">{item.stderr}</pre>}
                          <div
                            className={
                              "term-exit " + (item.exitCode === 0 ? "exit-ok" : "exit-err")
                            }
                          >
                            [Exit: {item.exitCode}]
                          </div>
                        </div>
                      );
                    }
                    return null;
                  })}

                  {activeTerm.busy && (
                    <div className="term-line term-busy">
                      <span className="term-spinner">●</span> Running command…
                    </div>
                  )}
                  <div ref={termEndRef} />
                </div>

                <div className="terminal-prompt-input-line">
                  <span className="term-prompt">
                    <span className="term-prompt-user">velocity</span>
                    <span className="term-prompt-sep">:</span>
                    <span className="term-prompt-path">
                      {formatPromptPath(activeTerm.cwd || root)}
                    </span>
                    <span className="term-prompt-sym"> ❯</span>
                  </span>
                  <input
                    ref={termInputRef}
                    className="term-input"
                    value={activeTerm.input || ""}
                    disabled={activeTerm.busy}
                    onChange={e =>
                      updateActiveTerminal(t => ({ ...t, input: e.target.value }))
                    }
                    onKeyDown={handleTerminalKeyDown}
                    placeholder={activeTerm.busy ? "Running…" : "Type command…"}
                    autoFocus
                  />
                  <button
                    className="term-exec-btn"
                    title="Execute Command"
                    disabled={activeTerm.busy || !(activeTerm.input || "").trim()}
                    onClick={executeTerminalCommand}
                  >
                    <Play size={11} />
                  </button>
                </div>
              </div>
            </div>
          )}
        </section>

        <aside className="chat">
          <h3><Bot /> Velocity Agent</h3>
          <div className="messages">
            {chat.map((x, i) => (
              <article key={i}>
                <label>{x.role.toUpperCase()}</label>
                <p>{x.content || (busy && i === chat.length - 1 ? "Thinking…" : "")}</p>
              </article>
            ))}
            <div ref={end} />
          </div>
          <div className="compose">
            <textarea
              value={msg}
              onChange={e => setMsg(e.target.value)}
              onKeyDown={e => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), send())}
              placeholder="Ask Velocity…"
            />
            <button disabled={busy} onClick={send}>
              <Send />
            </button>
          </div>
        </aside>
      </section>
      <div className="bar">
        ● Velocity AI <span>{status}</span>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
