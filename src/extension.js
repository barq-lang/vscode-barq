// Barq for VS Code: formatting (barq fmt), inline errors (barq check), outline,
// `use` links and run commands. Everything goes through the barq command, so the
// extension always matches the installed language version.

"use strict";

const vscode = require("vscode");
const cp = require("child_process");
const fs = require("fs");
const path = require("path");
const lib = require("./lib");

const LANG = "barq";
let diagnostics;
let output;
const timers = new Map();
let missingShown = false;

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
  if (document.languageId !== LANG || !config().get("diagnostics.enable")) return;
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
  if (document.languageId !== LANG) return;
  const key = document.uri.toString();
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => check(document), delay));
}

async function checkWorkspace() {
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
  context.subscriptions.push(
    diagnostics,
    output,
    vscode.languages.registerDocumentFormattingEditProvider(selector, formatter),
    vscode.languages.registerDocumentSymbolProvider(selector, symbols),
    vscode.languages.registerDocumentLinkProvider(selector, links),
    vscode.workspace.onDidOpenTextDocument((d) => scheduleCheck(d, 50)),
    vscode.workspace.onDidSaveTextDocument((d) => scheduleCheck(d, 0)),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (config().get("diagnostics.onType")) scheduleCheck(e.document, 500);
    }),
    vscode.workspace.onDidCloseTextDocument((d) => diagnostics.delete(d.uri)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("barq")) {
        missingShown = false;
        if (!config().get("diagnostics.enable")) diagnostics.clear();
        vscode.workspace.textDocuments.forEach((d) => scheduleCheck(d, 0));
      }
    }),
    vscode.commands.registerCommand("barq.runFile", runFile),
    vscode.commands.registerCommand("barq.serve", () => projectCommand("Barq serve", ["serve"])),
    vscode.commands.registerCommand("barq.test", () => projectCommand("Barq test", ["test"])),
    vscode.commands.registerCommand("barq.repl", () => projectCommand("Barq REPL", ["repl"])),
    vscode.commands.registerCommand("barq.checkWorkspace", checkWorkspace),
    vscode.commands.registerCommand("barq.packages", showPackages)
  );
  vscode.workspace.textDocuments.forEach((d) => scheduleCheck(d, 0));
}

function deactivate() {
  for (const t of timers.values()) clearTimeout(t);
}

module.exports = { activate, deactivate };
