import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";

const WS_URL = "ws://localhost:8000/terminal/ws";

export default function TerminalPanel({ root }) {
  const host = useRef(null);

  useEffect(() => {
    let disposed = false;

    const term = new Terminal({
      fontFamily: '"JetBrains Mono", "SF Mono", Menlo, Consolas, monospace',
      fontSize: 12.5,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      theme: {
        background: "#0e0e11",
        foreground: "#d4d4d8",
        cursor: "#a78bfa",
        selectionBackground: "#3b3566"
      }
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    fit.fit();

    const url = `${WS_URL}?root=${encodeURIComponent(root || "")}&cols=${term.cols}&rows=${term.rows}`;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";

    const send = obj => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(obj));

    ws.onmessage = e => {
      if (disposed) return;
      term.write(typeof e.data === "string" ? e.data : new Uint8Array(e.data));
    };
    ws.onclose = () => {
      if (!disposed) term.write("\r\n\x1b[2m[session closed]\x1b[0m\r\n");
    };
    ws.onerror = () => {
      if (!disposed) {
        term.write("\r\n\x1b[31mCannot reach the backend terminal at " + WS_URL + "\x1b[0m\r\n");
      }
    };

    const onData = term.onData(data => send({ type: "input", data }));
    const onResize = term.onResize(({ rows, cols }) => send({ type: "resize", rows, cols }));

    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* host not visible yet */
      }
    });
    observer.observe(host.current);
    term.focus();

    return () => {
      disposed = true;
      observer.disconnect();
      onData.dispose();
      onResize.dispose();
      ws.close();
      term.dispose();
    };
  }, [root]);

  return (
    <div className="term-panel" onClick={() => host.current?.querySelector("textarea")?.focus()}>
      <div className="term-host" ref={host} />
    </div>
  );
}
