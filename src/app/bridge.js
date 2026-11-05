// Connects the open app to any running 3D Maker MCP servers.
// Each MCP server (one per Claude client) listens on a port in BRIDGE_PORTS;
// the app keeps a WebSocket to every one it finds and answers their calls.
export const BRIDGE_PORTS = Array.from({ length: 10 }, (_, i) => 7457 + i);
// Retry quickly at first, then back off so idle ports are not polled constantly.
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 5000;
const FAST_MS = 200;

export function startBridge(commands, { onStatus, onActivity }) {
  const sockets = new Map(); // port -> open WebSocket
  const timers = new Map(); // port -> pending retry
  let fastUntil = 0;
  const status = () => onStatus(sockets.size);

  function schedule(port, delay) {
    clearTimeout(timers.get(port));
    const wait = Date.now() < fastUntil ? FAST_MS : delay;
    timers.set(port, setTimeout(() => connect(port, Math.min(delay * 1.5, RETRY_MAX_MS)), wait));
  }

  function connect(port, delay = RETRY_MIN_MS) {
    timers.delete(port);
    if (sockets.has(port)) return;
    let ws;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}`);
    } catch {
      return schedule(port, delay);
    }
    let opened = false;
    ws.onopen = () => {
      opened = true;
      sockets.set(port, ws);
      ws.send(JSON.stringify({ type: "hello", app: "3d-maker", version: 2 }));
      status();
    };
    ws.onclose = () => {
      if (sockets.get(port) === ws) {
        sockets.delete(port);
        status();
      }
      schedule(port, opened ? RETRY_MIN_MS : delay);
    };
    ws.onerror = () => {};
    ws.onmessage = async (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!msg || typeof msg.id === "undefined" || typeof msg.method !== "string") return;
      const fn = Object.hasOwn(commands, msg.method) ? commands[msg.method] : null;
      onActivity?.(msg.method, "start");
      try {
        if (!fn) throw new Error(`Unknown command "${msg.method}"`);
        const result = await fn(msg.params ?? {});
        ws.send(JSON.stringify({ id: msg.id, result }));
        onActivity?.(msg.method, "ok");
      } catch (err) {
        ws.send(JSON.stringify({ id: msg.id, error: String(err?.message ?? err) }));
        onActivity?.(msg.method, "error", String(err?.message ?? err));
      }
    };
  }

  BRIDGE_PORTS.forEach((p) => connect(p));
  status();

  return {
    // Poll fast for a while: a Claude run just started its MCP server.
    kick(ms = 20000) {
      fastUntil = Date.now() + ms;
      for (const port of BRIDGE_PORTS) if (!sockets.has(port) && timers.has(port)) schedule(port, RETRY_MIN_MS);
    },
  };
}
