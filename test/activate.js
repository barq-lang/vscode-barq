// Loads src/extension.js against a small stand-in for the `vscode` module and
// drives the formatter, diagnostics, outline and links with a real barq.
// Skipped when no barq is found (a barq checkout next to this repo, or BARQ=...).
//
//   node test/activate.js

"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
const barq = process.env.BARQ || path.join(ROOT, "..", "barq", "bin", process.platform === "win32" ? "barq.cmd" : "barq");
if (!fs.existsSync(barq)) {
  console.log("  skip  activation tests (no barq found; set BARQ=/path/to/bin/barq)");
  process.exit(0);
}

// -- the stand-in ---------------------------------------------------------------

class Position {
  constructor(line, character) { this.line = line; this.character = character; }
}
class Range {
  constructor(a, b, c, d) {
    if (a instanceof Position) { this.start = a; this.end = b; } else { this.start = new Position(a, b); this.end = new Position(c, d); }
  }
}
const registered = {};
const settings = { path: barq, "diagnostics.enable": true, "diagnostics.onType": true, "format.indentSize": 4, "format.sortImports": true, "run.args": [] };
const diagnosticsSet = new Map();
const vscode = {
  Position, Range,
  Uri: { file: (p) => ({ scheme: "file", fsPath: p, toString: () => "file://" + p }), parse: (s) => s },
  TextEdit: { replace: (range, newText) => ({ range, newText }) },
  Diagnostic: class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } },
  DiagnosticSeverity: { Error: 0 },
  DocumentSymbol: class { constructor(name, detail, kind, range, selectionRange) { Object.assign(this, { name, kind, range, selectionRange, children: [] }); } },
  DocumentLink: class { constructor(range, target) { Object.assign(this, { range, target }); } },
  SymbolKind: new Proxy({}, { get: (_, k) => k }),
  ProgressLocation: { Notification: 15 },
  languages: {
    createDiagnosticCollection: () => ({
      set: (uri, items) => diagnosticsSet.set(uri.toString(), items), get: (uri) => diagnosticsSet.get(uri.toString()),
      delete: (uri) => diagnosticsSet.delete(uri.toString()), clear: () => diagnosticsSet.clear(), dispose() {},
    }),
    registerDocumentFormattingEditProvider: (_, p) => (registered.format = p),
    registerDocumentSymbolProvider: (_, p) => (registered.symbols = p),
    registerDocumentLinkProvider: (_, p) => (registered.links = p),
  },
  window: {
    createOutputChannel: () => ({ appendLine() {}, clear() {}, show() {}, dispose() {} }),
    showWarningMessage: (msg) => { throw new Error("unexpected warning: " + msg); },
    terminals: [],
  },
  workspace: {
    getConfiguration: () => ({ get: (k) => settings[k] }),
    getWorkspaceFolder: () => undefined,
    textDocuments: [],
    onDidOpenTextDocument: () => ({}), onDidSaveTextDocument: () => ({}), onDidChangeTextDocument: () => ({}),
    onDidCloseTextDocument: () => ({}), onDidChangeConfiguration: () => ({}),
  },
  commands: { registerCommand: (name) => (registered[name] = true) },
  env: {},
};

const realLoad = Module._load;
Module._load = function (request, ...rest) {
  return request === "vscode" ? vscode : realLoad.call(this, request, ...rest);
};

function doc(file, text) {
  const lines = text.split("\n");
  const offsets = [0];
  for (const l of lines) offsets.push(offsets[offsets.length - 1] + l.length + 1);
  return {
    uri: vscode.Uri.file(file), fileName: file, languageId: "barq", lineCount: lines.length, isDirty: false,
    getText: () => text,
    lineAt: (i) => ({ text: lines[i], range: new Range(i, 0, i, lines[i].length) }),
    positionAt: (off) => {
      let line = 0;
      while (line + 1 < offsets.length && offsets[line + 1] <= off) line++;
      return new Position(line, off - offsets[line]);
    },
  };
}

// -- the tests --------------------------------------------------------------------

(async () => {
  const ext = require("../src/extension");
  const subs = [];
  ext.activate({ subscriptions: subs });
  for (const c of ["barq.runFile", "barq.serve", "barq.test", "barq.repl", "barq.checkWorkspace", "barq.packages"]) {
    assert.ok(registered[c], `${c} registered`);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "barq-ext-"));
  fs.mkdirSync(path.join(tmp, "app", "Models"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "routes"));
  fs.writeFileSync(path.join(tmp, "app", "Models", "Thing.bq"), "namespace App\\Models\n\nclass Thing\n    public int n = 1\n");

  const messy = doc(path.join(tmp, "main.bq"), "use App\\Models\\Thing\nkaro   f( int a ):int\n  return a*2\nprint(f(2))\n");
  const edits = await registered.format.provideDocumentFormattingEdits(messy);
  assert.strictEqual(edits.length, 1);
  assert.strictEqual(edits[0].newText, "use App\\Models\\Thing\n\nkaro f(int a): int\n    return a * 2\n\nprint(f(2))\n");
  console.log("  ok    formatter replaces the document with barq fmt's output");

  const clean = doc(path.join(tmp, "clean.bq"), "print(1)\n");
  assert.deepStrictEqual(await registered.format.provideDocumentFormattingEdits(clean), []);
  const broken = doc(path.join(tmp, "broken.bq"), "x = (1\n");
  assert.deepStrictEqual(await registered.format.provideDocumentFormattingEdits(broken), []);
  console.log("  ok    no edits for formatted or broken files");

  const bad = doc(path.join(tmp, "bad.bq"), 'int x = "a"\nprint(nope)\n');
  vscode.workspace.onDidOpenTextDocument = () => ({});
  // check() is internal; reach it through the save hook the extension registered.
  const hooks = {};
  vscode.workspace.onDidSaveTextDocument = (fn) => (hooks.save = fn);
  ext.activate({ subscriptions: [] });
  hooks.save(bad);
  await new Promise((r) => setTimeout(r, 1500));
  const found = diagnosticsSet.get(bad.uri.toString()) || [];
  assert.deepStrictEqual(found.map((d) => [d.range.start.line, d.range.start.character, d.code]), [[0, 8, "CompileError"], [1, 6, "CompileError"]]);
  assert.strictEqual(found[1].message, "'nope' is not defined");
  console.log("  ok    barq check errors become diagnostics on the right lines");

  const syms = registered.symbols.provideDocumentSymbols(messy);
  assert.deepStrictEqual(syms.map((s) => [s.name, s.kind]), [["f", "Function"]]);
  const links = registered.links.provideDocumentLinks(messy);
  assert.strictEqual(links.length, 1);
  assert.strictEqual(links[0].target.fsPath, path.join(tmp, "app", "Models", "Thing.bq"));
  console.log("  ok    outline and `use` links");
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((err) => {
  console.log("  FAIL  activation tests\n" + err.stack);
  process.exitCode = 1;
});
