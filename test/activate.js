// Loads src/extension.js against a small stand-in for the `vscode` module and
// drives it with a real barq: first with the language server off (barq fmt /
// barq check per file), then with `barq lsp` (completion, hover, definition,
// rename, diagnostics...).
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
const hooks = {};
const settings = { path: barq, "languageServer.enable": false, "diagnostics.enable": true, "diagnostics.onType": true, "format.indentSize": 4, "format.sortImports": true, "run.args": [] };
const diagnosticsSet = new Map();
const plain = (fields) => class { constructor(...args) { fields.forEach((f, i) => (this[f] = args[i])); } };
const fileUri = (p) => ({ scheme: "file", fsPath: p, toString: () => "file://" + p });
const vscode = {
  Position, Range,
  Uri: { file: fileUri, parse: (s) => (s.startsWith("file://") ? fileUri(decodeURIComponent(s.slice(7))) : s) },
  TextEdit: { replace: (range, newText) => ({ range, newText }) },
  Diagnostic: class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  DocumentSymbol: class { constructor(name, detail, kind, range, selectionRange) { Object.assign(this, { name, kind, range, selectionRange, children: [] }); } },
  DocumentLink: class { constructor(range, target) { Object.assign(this, { range, target }); } },
  CompletionItem: plain(["label", "kind"]),
  CompletionList: plain(["items", "isIncomplete"]),
  MarkdownString: plain(["value"]),
  SnippetString: plain(["value"]),
  Hover: plain(["contents", "range"]),
  Location: plain(["uri", "range"]),
  DocumentHighlight: plain(["range", "kind"]),
  SymbolInformation: plain(["name", "kind", "containerName", "location"]),
  SignatureHelp: plain([]),
  SignatureInformation: plain(["label", "documentation"]),
  ParameterInformation: plain(["label", "documentation"]),
  WorkspaceEdit: class { constructor() { this.edits = []; } replace(uri, range, newText) { this.edits.push({ uri, range, newText }); } },
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
    registerCompletionItemProvider: (_, p) => (registered.completion = p),
    registerHoverProvider: (_, p) => (registered.hover = p),
    registerDefinitionProvider: (_, p) => (registered.definition = p),
    registerReferenceProvider: (_, p) => (registered.references = p),
    registerDocumentHighlightProvider: (_, p) => (registered.highlights = p),
    registerRenameProvider: (_, p) => (registered.rename = p),
    registerSignatureHelpProvider: (_, p) => (registered.signature = p),
    registerWorkspaceSymbolProvider: (p) => (registered.workspaceSymbols = p),
  },
  window: {
    createOutputChannel: () => ({ appendLine(l) { if (process.env.DEBUG) console.log("    [out] " + l); }, clear() {}, show() {}, dispose() {} }),
    showWarningMessage: (msg) => { throw new Error("unexpected warning: " + msg); },
    terminals: [],
  },
  workspace: {
    getConfiguration: () => ({ get: (k) => settings[k] }),
    getWorkspaceFolder: () => undefined,
    textDocuments: [],
    onDidOpenTextDocument: (fn) => (hooks.open = fn), onDidSaveTextDocument: (fn) => (hooks.save = fn),
    onDidChangeTextDocument: (fn) => (hooks.change = fn), onDidCloseTextDocument: (fn) => (hooks.close = fn),
    onDidChangeConfiguration: () => ({}),
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
    uri: vscode.Uri.file(file), fileName: file, languageId: "barq", lineCount: lines.length, isDirty: false, version: 1,
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
  for (const c of ["barq.runFile", "barq.serve", "barq.test", "barq.repl", "barq.checkWorkspace", "barq.packages", "barq.restartServer"]) {
    assert.ok(registered[c], `${c} registered`);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "barq-ext-"));
  fs.mkdirSync(path.join(tmp, "app", "Models"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "routes"));
  fs.writeFileSync(path.join(tmp, "app", "Models", "Thing.bq"), "namespace App\\Models\n\nclass Thing\n    public int n = 1\n");

  const messy = doc(path.join(tmp, "main.bq"), "use App\\Models\\Thing\nkaro   f( int a ):int\n  return a*2\nprint(f(2))\n");
  const edits = await registered.format.provideDocumentFormattingEdits(messy, { tabSize: 4 });
  assert.strictEqual(edits.length, 1);
  assert.strictEqual(edits[0].newText, "use App\\Models\\Thing\n\nkaro f(int a): int\n    return a * 2\n\nprint(f(2))\n");
  console.log("  ok    formatter replaces the document with barq fmt's output");

  const clean = doc(path.join(tmp, "clean.bq"), "print(1)\n");
  assert.deepStrictEqual(await registered.format.provideDocumentFormattingEdits(clean, { tabSize: 4 }), []);
  const broken = doc(path.join(tmp, "broken.bq"), "x = (1\n");
  assert.deepStrictEqual(await registered.format.provideDocumentFormattingEdits(broken, { tabSize: 4 }), []);
  console.log("  ok    no edits for formatted or broken files");

  const bad = doc(path.join(tmp, "bad.bq"), 'int x = "a"\nprint(nope)\n');
  // check() is internal; reach it through the save hook the extension registered.
  hooks.save(bad);
  await new Promise((r) => setTimeout(r, 1500));
  const found = diagnosticsSet.get(bad.uri.toString()) || [];
  assert.deepStrictEqual(found.map((d) => [d.range.start.line, d.range.start.character, d.code]), [[0, 8, "CompileError"], [1, 6, "CompileError"]]);
  assert.strictEqual(found[1].message, "'nope' is not defined");
  console.log("  ok    barq check errors become diagnostics on the right lines");

  const syms = await registered.symbols.provideDocumentSymbols(messy);
  assert.deepStrictEqual(syms.map((s) => [s.name, s.kind]), [["f", "Function"]]);
  const links = registered.links.provideDocumentLinks(messy);
  assert.strictEqual(links.length, 1);
  assert.strictEqual(links[0].target.fsPath, path.join(tmp, "app", "Models", "Thing.bq"));
  console.log("  ok    outline and `use` links");

  // -- with the language server --------------------------------------------------
  settings["languageServer.enable"] = true;
  diagnosticsSet.clear();
  const api = ext.activate({ subscriptions: [] });
  const client = await api.startServer();
  if (!client) throw new Error("barq lsp did not start");
  const thingFile = path.join(tmp, "app", "Models", "Thing.bq");
  const main = doc(path.join(tmp, "main.bq"), "use App\\Models\\Thing\n\nThing t = new Thing()\nprint(t.n)\nt.\n");
  hooks.open(main);
  const waitFor = async (fn) => {
    for (let i = 0; i < 100; i++) {
      const v = fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("timed out");
  };
  const diag = await waitFor(() => diagnosticsSet.get(main.uri.toString()));
  assert.strictEqual(diag.length, 1);
  assert.strictEqual(diag[0].range.start.line, 4);
  console.log("  ok    the server's errors become diagnostics");

  const list = await registered.completion.provideCompletionItems(main, new Position(4, 2), {});
  assert.deepStrictEqual(list.items.map((i) => i.label), ["n"]);
  const hover = await registered.hover.provideHover(main, new Position(3, 8), {});
  assert.ok(hover.contents.value.includes("int n = 1"), hover.contents.value);
  const def = await registered.definition.provideDefinition(main, new Position(2, 1), {});
  assert.strictEqual(def.uri.fsPath, thingFile);
  assert.strictEqual(def.range.start.line, 2);
  console.log("  ok    completion, hover and go to definition");

  const refs = await registered.references.provideReferences(main, new Position(2, 6), { includeDeclaration: true }, {});
  assert.deepStrictEqual(refs.map((r) => [r.range.start.line, r.range.start.character]), [[2, 6], [3, 6], [4, 0]]);
  const edit = await registered.rename.provideRenameEdits(main, new Position(2, 6), "thing", {});
  assert.strictEqual(edit.edits.length, 3);
  await assert.rejects(registered.rename.prepareRename(main, new Position(2, 1), {}));
  const sigDoc = doc(path.join(tmp, "s.bq"), "print(");
  hooks.open(sigDoc);
  const sig = await registered.signature.provideSignatureHelp(sigDoc, new Position(0, 6), {});
  assert.ok(sig === undefined || sig.signatures.length === 1);
  const thingDoc = doc(thingFile, fs.readFileSync(thingFile, "utf8"));
  hooks.open(thingDoc);
  const outline = await registered.symbols.provideDocumentSymbols(thingDoc, {});
  assert.deepStrictEqual(outline.map((s) => [s.name, s.children.map((c) => c.name)]), [["Thing", ["n"]]]);
  const ws = await registered.workspaceSymbols.provideWorkspaceSymbols("Thi", {});
  assert.ok(ws.some((s) => s.name === "Thing"));
  console.log("  ok    references, rename, outline and workspace symbols");

  hooks.open(messy);
  const fmt = await registered.format.provideDocumentFormattingEdits(messy, { tabSize: 4 });
  assert.strictEqual(fmt[0].newText, "use App\\Models\\Thing\n\nkaro f(int a): int\n    return a * 2\n\nprint(f(2))\n");
  console.log("  ok    formatting through the server");

  hooks.change({ document: Object.assign(doc(main.fileName, "use App\\Models\\Thing\n\nThing t = new Thing()\nprint(t.n)\n"), { version: 2 }) });
  await waitFor(() => (diagnosticsSet.get(main.uri.toString()) || [1]).length === 0);
  console.log("  ok    edits are sent and the errors clear");
  await ext.deactivate();
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch(async (err) => {
  console.log("  FAIL  activation tests\n" + err.stack);
  process.exitCode = 1;
  await require("../src/extension").deactivate(); // stop barq lsp so node can exit
});
