// Barq for VS Code. Language features come from the Barq language server
// (`barq lsp`): completion, hover, go to definition, references, rename,
// signature help, outline, workspace symbols, formatting and inline errors.
// When the server cannot start (an older barq, or barq.languageServer.enable
// is off), formatting, errors and the outline fall back to running `barq fmt` /
// `barq check` per file. Debugging runs `barq dap` (see debug.js). Everything
// goes through the barq command, so the extension always matches the installed
// language version.

"use strict";

const vscode = require("vscode");
const cp = require("child_process");
const fs = require("fs");
const path = require("path");
const lib = require("./lib");
const { Client } = require("./client");
const lsp = require("./lsp");
const debug = require("./debug");

const LANG = "barq";
let diagnostics;
let output;
const timers = new Map();
let missingShown = false;
let client = null; // a running language server, or null
let starting = null;
let crashes = [];

function config() {
  return vscode.workspace.getConfiguration("barq");
}

function barqCommand() {
  return config().get("path") || "barq";
}

function cwdFor(uri) {
  const folder = uri && vscode.workspace.getWorkspaceFolder(uri);
  if (folder) return folder.uri.fsPath;
  return uri && uri.scheme === "file" ? path.dirname(uri.fsPath) : undefined;
}

/** Run barq with stdin; resolves {code, stdout, stderr}. */
function runBarq(args, input, cwd) {
  return new Promise((resolve) => {
    let child;
    try {
      // On Windows barq is bin\barq.cmd, which needs a shell to start.
      child = cp.spawn(barqCommand(), args, {
        cwd,
        env: { ...process.env, NO_COLOR: "1" },
        shell: process.platform === "win32",
      });
    } catch (err) {
      resolve({ code: -1, stdout: "", stderr: String(err), missing: true });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: String(err), missing: err.code === "ENOENT" }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input, "utf8");
  });
}

function reportMissing() {
  if (missingShown) return;
  missingShown = true;
  vscode.window
    .showWarningMessage(
      `Barq: cannot run "${barqCommand()}". Install Barq or set "barq.path" to bin/barq in your barq checkout.`,
      "Open settings",
      "Get Barq"
    )
    .then((choice) => {
      if (choice === "Open settings") vscode.commands.executeCommand("workbench.action.openSettings", "barq.path");
      if (choice === "Get Barq") vscode.env.openExternal(vscode.Uri.parse("https://github.com/barq-lang/barq"));
    });
}

// -- formatting ---------------------------------------------------------------

const formatter = {
  async provideDocumentFormattingEdits(document) {
    const text = document.getText();
    const res = await runBarq(
      lib.fmtArgs(config().get("format.indentSize"), config().get("format.sortImports")),
      text,
      cwdFor(document.uri)
    );
    if (res.missing) {
      reportMissing();
      return [];
    }
    if (res.code !== 0) {
      // A syntax error: barq check already underlines it; leave the text alone.
      output.appendLine(`barq fmt: ${res.stderr.trim()}`);
      return [];
    }
    if (res.stdout === text) return [];
    const whole = new vscode.Range(document.positionAt(0), document.positionAt(text.length));
    return [vscode.TextEdit.replace(whole, res.stdout)];
  },
};

// -- diagnostics ----------------------------------------------------------------

async function check(document) {
  if (client || document.languageId !== LANG || !config().get("diagnostics.enable")) return;
  const file = document.uri.scheme === "file" ? document.uri.fsPath : document.fileName;
  const res = await runBarq(lib.checkArgs(file), document.getText(), cwdFor(document.uri));
  if (res.missing) {
    reportMissing();
    return;
  }
  const items = lib.parseCheckOutput(res.stdout).map((row) => {
    const line = Math.min(row.line - 1, Math.max(document.lineCount - 1, 0));
    const range = new vscode.Range(line, row.col - 1, line, row.endCol - 1);
    const d = new vscode.Diagnostic(range, row.message, vscode.DiagnosticSeverity.Error);
    d.source = "barq";
    d.code = row.kind;
    return d;
  });
  diagnostics.set(document.uri, items);
}

function scheduleCheck(document, delay) {
  if (client || document.languageId !== LANG) return;
  const key = document.uri.toString();
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => check(document), delay));
}

async function checkWorkspace() {
  if (client) {
    // the server checks open files; for the rest run barq check once
    projectCommand("Barq check", ["check", "."]);
    return;
  }
  const files = await vscode.workspace.findFiles("**/*.bq", "{**/views/**,**/node_modules/**,**/.barq/**}");
  let count = 0;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Barq: checking files" },
    async () => {
      for (const uri of files) {
        const doc = await vscode.workspace.openTextDocument(uri);
        await check(doc);
        count += (diagnostics.get(uri) || []).length;
      }
    }
  );
  vscode.window.showInformationMessage(
    count ? `Barq: ${count} error${count === 1 ? "" : "s"} in ${files.length} files — see the Problems panel.` : `Barq: ${files.length} files checked, no errors.`
  );
}

// -- outline and `use` links ----------------------------------------------------

const KINDS = {
  Class: vscode.SymbolKind.Class,
  Interface: vscode.SymbolKind.Interface,
  Enum: vscode.SymbolKind.Enum,
  EnumMember: vscode.SymbolKind.EnumMember,
  Function: vscode.SymbolKind.Function,
  Method: vscode.SymbolKind.Method,
  Constructor: vscode.SymbolKind.Constructor,
  Property: vscode.SymbolKind.Property,
  Constant: vscode.SymbolKind.Constant,
};

function toSymbol(document, s) {
  const end = document.lineAt(s.endLine).range.end;
  const range = new vscode.Range(s.line, 0, end.line, end.character);
  const sel = new vscode.Range(s.line, Math.max(s.col, 0), s.line, Math.max(s.col, 0) + s.name.length);
  const sym = new vscode.DocumentSymbol(s.name, "", KINDS[s.kind] || vscode.SymbolKind.Variable, range, sel);
  sym.children = s.children.map((c) => toSymbol(document, c));
  return sym;
}

const symbols = {
  provideDocumentSymbols(document) {
    return lib.documentSymbols(document.getText()).map((s) => toSymbol(document, s));
  },
};

const links = {
  provideDocumentLinks(document) {
    if (document.uri.scheme !== "file") return [];
    const root = lib.findProjectRoot(document.uri.fsPath, fs.existsSync);
    const out = [];
    for (let i = 0; i < document.lineCount; i++) {
      const t = lib.useTargets(document.lineAt(i).text);
      if (!t) continue;
      const hit = t.candidates.map((c) => path.join(root, c)).find((p) => fs.existsSync(p));
      if (hit) {
        const link = new vscode.DocumentLink(new vscode.Range(i, t.start, i, t.end), vscode.Uri.file(hit));
        link.tooltip = path.relative(root, hit);
        out.push(link);
      }
    }
    return out;
  },
};

// -- language server ---------------------------------------------------------------

function serverSettings() {
  return {
    diagnostics: config().get("diagnostics.enable"),
    diagnosticsOnType: config().get("diagnostics.onType"),
    sortImports: config().get("format.sortImports"),
  };
}

function isBarqDoc(d) {
  return d.languageId === LANG && (d.uri.scheme === "file" || d.uri.scheme === "untitled");
}

function sendOpen(d) {
  if (!client || !isBarqDoc(d)) return;
  client.notify("textDocument/didOpen", {
    textDocument: { uri: d.uri.toString(), languageId: LANG, version: d.version || 1, text: d.getText() },
  });
}

async function startServer() {
  if (starting) return starting;
  if (client || !config().get("languageServer.enable")) return client;
  const folders = vscode.workspace.workspaceFolders || [];
  const c = new Client({
    command: barqCommand(),
    cwd: folders[0] ? folders[0].uri.fsPath : undefined,
    log: (line) => output.appendLine(line),
  });
  c.on("textDocument/publishDiagnostics", (p) => {
    const uri = vscode.Uri.parse(p.uri);
    diagnostics.set(uri, (p.diagnostics || []).map(convert.diagnostic));
  });
  starting = c
    .start({
      processId: process.pid,
      clientInfo: { name: "vscode-barq" },
      rootUri: folders[0] ? folders[0].uri.toString() : null,
      workspaceFolders: folders.map((f) => ({ uri: f.uri.toString(), name: f.name })),
      initializationOptions: serverSettings(),
      capabilities: {},
    })
    .then(
      () => {
        client = c;
        output.appendLine("Barq language server started.");
        diagnostics.clear();
        vscode.workspace.textDocuments.forEach(sendOpen);
        c.onExit((code) => {
          client = null;
          diagnostics.clear();
          const now = Date.now();
          crashes = crashes.filter((t) => now - t < 180000).concat(now);
          output.appendLine(`Barq language server stopped (code ${code}).`);
          if (crashes.length <= 3) startServer();
          else {
            output.appendLine("It stopped 3 times in 3 minutes; using barq fmt / barq check until you run 'Barq: Restart language server'.");
            vscode.workspace.textDocuments.forEach((d) => scheduleCheck(d, 0));
          }
        });
        return c;
      },
      (err) => {
        if (err && err.code === "ENOENT") reportMissing();
        output.appendLine(`Barq language server not available (${err.message}); using barq fmt / barq check instead.`);
        vscode.workspace.textDocuments.forEach((d) => scheduleCheck(d, 0));
        return null;
      }
    )
    .finally(() => {
      starting = null;
    });
  return starting;
}

async function stopServer() {
  const c = client;
  client = null;
  if (c) await c.stop();
}

async function restartServer() {
  crashes = [];
  await stopServer();
  diagnostics.clear();
  const c = await startServer();
  if (!c) vscode.workspace.textDocuments.forEach((d) => scheduleCheck(d, 0));
  return c;
}

let convert;

// -- commands ---------------------------------------------------------------------

function terminal(name, cwd) {
  const existing = vscode.window.terminals.find((t) => t.name === name);
  if (existing) existing.dispose();
  return vscode.window.createTerminal({ name, cwd });
}

function quote(arg) {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `"${arg.replace(/(["\\$`])/g, "\\$1")}"`;
}

async function runFile() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== LANG) {
    vscode.window.showWarningMessage("Barq: open a .bq file to run it.");
    return;
  }
  if (editor.document.isDirty) await editor.document.save();
  const file = editor.document.uri.fsPath;
  const t = terminal("Barq", path.dirname(file));
  t.show();
  t.sendText([barqCommand(), "run", file, ...(config().get("run.args") || [])].map(quote).join(" "));
}

function projectCommand(title, args) {
  const editor = vscode.window.activeTextEditor;
  const folder = editor ? cwdFor(editor.document.uri) : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const t = terminal(title, folder);
  t.show();
  t.sendText([barqCommand(), ...args].map(quote).join(" "));
}

async function showPackages() {
  const res = await runBarq(["packages"], undefined, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
  if (res.missing) return reportMissing();
  const version = await runBarq(["version"]);
  output.clear();
  output.appendLine(version.stdout.trim());
  output.appendLine(res.stdout.trim());
  output.show(true);
}

// -- activation -------------------------------------------------------------------

function activate(context) {
  diagnostics = vscode.languages.createDiagnosticCollection("barq");
  output = vscode.window.createOutputChannel("Barq");
  const selector = { language: LANG };
  const p = lsp.providers(vscode, () => client, {
    format: (d) => formatter.provideDocumentFormattingEdits(d),
    symbols: (d) => symbols.provideDocumentSymbols(d),
    indentSize: () => config().get("format.indentSize"),
  });
  convert = p.convert;
  context.subscriptions.push(
    diagnostics,
    output,
    vscode.languages.registerDocumentFormattingEditProvider(selector, p.formatting),
    vscode.languages.registerDocumentSymbolProvider(selector, p.symbols),
    vscode.languages.registerDocumentLinkProvider(selector, links),
    vscode.languages.registerCompletionItemProvider(selector, p.completion, ".", ":", "\\", "["),
    vscode.languages.registerHoverProvider(selector, p.hover),
    vscode.languages.registerDefinitionProvider(selector, p.definition),
    vscode.languages.registerReferenceProvider(selector, p.references),
    vscode.languages.registerDocumentHighlightProvider(selector, p.highlights),
    vscode.languages.registerRenameProvider(selector, p.rename),
    vscode.languages.registerSignatureHelpProvider(selector, p.signature, "(", ","),
    vscode.languages.registerWorkspaceSymbolProvider(p.workspaceSymbols),
    vscode.workspace.onDidOpenTextDocument((d) => {
      if (client) sendOpen(d);
      else scheduleCheck(d, 50);
    }),
    vscode.workspace.onDidSaveTextDocument((d) => {
      if (client && isBarqDoc(d)) client.notify("textDocument/didSave", { textDocument: { uri: d.uri.toString() } });
      else scheduleCheck(d, 0);
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (client && isBarqDoc(e.document)) {
        client.notify("textDocument/didChange", {
          textDocument: { uri: e.document.uri.toString(), version: e.document.version },
          contentChanges: [{ text: e.document.getText() }],
        });
      } else if (config().get("diagnostics.onType")) scheduleCheck(e.document, 500);
    }),
    vscode.workspace.onDidCloseTextDocument((d) => {
      if (client && isBarqDoc(d)) client.notify("textDocument/didClose", { textDocument: { uri: d.uri.toString() } });
      diagnostics.delete(d.uri);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("barq")) return;
      missingShown = false;
      if (e.affectsConfiguration("barq.path") || e.affectsConfiguration("barq.languageServer.enable")) {
        restartServer();
        return;
      }
      if (client) client.notify("workspace/didChangeConfiguration", { settings: { barq: serverSettings() } });
      if (!config().get("diagnostics.enable")) diagnostics.clear();
      vscode.workspace.textDocuments.forEach((d) => scheduleCheck(d, 0));
    }),
    { dispose: () => stopServer() },
    vscode.commands.registerCommand("barq.runFile", runFile),
    vscode.commands.registerCommand("barq.serve", () => projectCommand("Barq serve", ["serve"])),
    vscode.commands.registerCommand("barq.test", () => projectCommand("Barq test", ["test"])),
    vscode.commands.registerCommand("barq.repl", () => projectCommand("Barq REPL", ["repl"])),
    vscode.commands.registerCommand("barq.checkWorkspace", checkWorkspace),
    vscode.commands.registerCommand("barq.packages", showPackages),
    vscode.commands.registerCommand("barq.restartServer", async () => {
      const c = await restartServer();
      vscode.window.showInformationMessage(c ? "Barq: language server restarted." : "Barq: the language server could not start — see the Barq output.");
    })
  );
  if (vscode.workspace.onDidChangeWorkspaceFolders) {
    context.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders((e) => {
        if (!client) return;
        client.notify("workspace/didChangeWorkspaceFolders", {
          event: {
            added: e.added.map((f) => ({ uri: f.uri.toString(), name: f.name })),
            removed: e.removed.map((f) => ({ uri: f.uri.toString(), name: f.name })),
          },
        });
      })
    );
  }
  if (vscode.workspace.createFileSystemWatcher) {
    const w = vscode.workspace.createFileSystemWatcher("**/*.bq");
    const changed = () => client && client.notify("workspace/didChangeWatchedFiles", { changes: [] });
    context.subscriptions.push(w, w.onDidCreate(changed), w.onDidDelete(changed), w.onDidChange(changed));
  }
  let debugging = null;
  if (vscode.debug) {
    debugging = debug.register(vscode, context, {
      barqCommand,
      runArgs: () => config().get("run.args") || [],
      activeBarqFile: () => {
        const editor = vscode.window.activeTextEditor;
        return editor && editor.document.languageId === LANG && editor.document.uri.scheme === "file"
          ? editor.document.uri.fsPath : undefined;
      },
    });
  }
  if (config().get("languageServer.enable")) startServer();
  else vscode.workspace.textDocuments.forEach((d) => scheduleCheck(d, 0));
  return { startServer, stopServer, getClient: () => client, debugging };
}

function deactivate() {
  for (const t of timers.values()) clearTimeout(t);
  return stopServer();
}

module.exports = { activate, deactivate };
