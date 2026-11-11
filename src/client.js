// A small Language Server Protocol client: starts `barq lsp` and talks
// Content-Length framed JSON-RPC over its stdin/stdout. No VS Code dependency,
// so test/run.js can drive it with plain Node.

"use strict";

const cp = require("child_process");

class Client {
  /**
   * @param {object} o
   * @param {string} o.command   the barq command
   * @param {string[]} [o.args]  default ["lsp"]
   * @param {string} [o.cwd]
   * @param {(line: string) => void} [o.log]  gets the server's stderr
   */
  constructor(o) {
    this.command = o.command;
    this.args = o.args || ["lsp"];
    this.cwd = o.cwd;
    this.log = o.log || (() => {});
    this.nextId = 0;
    this.waiting = new Map(); // id -> {resolve, reject}
    this.handlers = new Map(); // notification method -> fn(params)
    this.exitHandlers = [];
    this.buffer = Buffer.alloc(0);
    this.proc = null;
    this.ready = false;
    this.stopping = false;
    this.capabilities = {};
  }

  /** Start the server and send `initialize`; resolves with its result. */
  start(initParams, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        this.kill();
        reject(err);
      };
      try {
        // On Windows barq is bin\barq.cmd, which needs a shell to start.
        this.proc = cp.spawn(this.command, this.args, {
          cwd: this.cwd,
          env: { ...process.env, NO_COLOR: "1" },
          shell: process.platform === "win32",
        });
      } catch (err) {
        fail(err);
        return;
      }
      const proc = this.proc;
      proc.on("error", (err) => fail(err));
      proc.stdout.on("data", (chunk) => this.receive(chunk));
      proc.stderr.setEncoding("utf8");
      proc.stderr.on("data", (d) => String(d).split(/\r?\n/).filter(Boolean).forEach((l) => this.log(l)));
      proc.on("exit", (code, signal) => {
        const wasReady = this.ready;
        this.ready = false;
        for (const w of this.waiting.values()) w.reject(new Error("the Barq language server stopped"));
        this.waiting.clear();
        if (!settled) fail(new Error(`barq lsp exited (${code === null ? signal : "code " + code}) before it started`));
        if (wasReady && !this.stopping) this.exitHandlers.forEach((fn) => fn(code, signal));
      });
      const timer = setTimeout(() => fail(new Error("barq lsp did not answer initialize")), timeoutMs);
      this.request("initialize", initParams).then(
        (result) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          this.capabilities = (result && result.capabilities) || {};
          this.ready = true;
          this.notify("initialized", {});
          resolve(result);
        },
        (err) => {
          clearTimeout(timer);
          fail(err);
        }
      );
    });
  }

  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const end = this.buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const header = this.buffer.slice(0, end).toString("ascii");
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        this.buffer = this.buffer.slice(end + 4);
        continue;
      }
      const size = Number(m[1]);
      if (this.buffer.length < end + 4 + size) return;
      const body = this.buffer.slice(end + 4, end + 4 + size).toString("utf8");
      this.buffer = this.buffer.slice(end + 4 + size);
      let msg;
      try {
        msg = JSON.parse(body);
      } catch (_) {
        continue;
      }
      this.dispatch(msg);
    }
  }

  dispatch(msg) {
    if (msg.id !== undefined && msg.method === undefined) {
      const w = this.waiting.get(msg.id);
      if (!w) return;
      this.waiting.delete(msg.id);
      if (msg.error) {
        const err = new Error(msg.error.message);
        err.code = msg.error.code;
        w.reject(err);
      } else w.resolve(msg.result === undefined ? null : msg.result);
    } else if (msg.method !== undefined && msg.id !== undefined) {
      // a request from the server: none are used yet, so answer null
      this.send({ jsonrpc: "2.0", id: msg.id, result: null });
    } else if (msg.method !== undefined) {
      const fn = this.handlers.get(msg.method);
      if (fn) fn(msg.params);
    }
  }

  send(msg) {
    if (!this.proc || !this.proc.stdin.writable) return false;
    const data = Buffer.from(JSON.stringify(msg), "utf8");
    this.proc.stdin.write(`Content-Length: ${data.length}\r\n\r\n`);
    this.proc.stdin.write(data);
    return true;
  }

  /** Send a request. A cancellation token (VS Code's) sends $/cancelRequest and resolves null. */
  request(method, params, token) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      if (!this.send({ jsonrpc: "2.0", id, method, params })) {
        this.waiting.delete(id);
        reject(new Error("the Barq language server is not running"));
        return;
      }
      if (token && token.onCancellationRequested) {
        token.onCancellationRequested(() => {
          if (!this.waiting.has(id)) return;
          this.waiting.delete(id);
          this.notify("$/cancelRequest", { id });
          resolve(null);
        });
      }
    });
  }

  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  on(method, fn) {
    this.handlers.set(method, fn);
  }

  /** fn(code, signal) when a running server stops without being asked to. */
  onExit(fn) {
    this.exitHandlers.push(fn);
  }

  async stop() {
    if (!this.proc) return;
    this.stopping = true;
    if (this.ready) {
      try {
        await Promise.race([this.request("shutdown", null), new Promise((r) => setTimeout(r, 2000))]);
        this.notify("exit", null);
      } catch (_) {
        // already gone
      }
    }
    this.ready = false;
    const proc = this.proc;
    await new Promise((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
      const t = setTimeout(() => {
        proc.kill();
        resolve();
      }, 2000);
      proc.on("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
    this.proc = null;
  }

  kill() {
    this.ready = false;
    if (this.proc && this.proc.exitCode === null) {
      try {
        this.proc.kill();
      } catch (_) {
        // ignore
      }
    }
  }
}

module.exports = { Client };
