// Helpers with no VS Code dependency, so they can be tested with plain Node (test/run.js).

"use strict";

const path = require("path");

/** Parse `barq check --json` output: one JSON object per line. Lines that are not JSON are skipped. */
function parseCheckOutput(stdout) {
  const rows = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    try {
      const row = JSON.parse(text);
      if (typeof row.line === "number" && typeof row.message === "string") {
        rows.push({
          line: Math.max(row.line, 1),
          col: Math.max(row.col || 1, 1),
          endCol: Math.max(row.endCol || (row.col || 1) + 1, (row.col || 1) + 1),
          kind: row.kind || "Error",
          message: row.message,
        });
      }
    } catch (_) {
      // not a diagnostic line
    }
  }
  return rows;
}

/** Arguments for `barq fmt` reading stdin. */
function fmtArgs(indentSize, sortImports) {
  const args = ["fmt"];
  if (indentSize && indentSize !== 4) args.push("--indent", String(indentSize));
  if (sortImports === false) args.push("--no-sort");
  args.push("-");
  return args;
}

/** Arguments for `barq check` on an editor buffer. */
function checkArgs(filePath) {
  return ["check", "--json", "--path", filePath, "-"];
}

const SYMBOL_PATTERNS = [
  { re: /^(\s*)(?:abstract\s+)?class\s+([A-Za-z_]\w*)/, kind: "Class" },
  { re: /^(\s*)interface\s+([A-Za-z_]\w*)/, kind: "Interface" },
  { re: /^(\s*)trait\s+([A-Za-z_]\w*)/, kind: "Class" },
  { re: /^(\s*)enum\s+([A-Za-z_]\w*)/, kind: "Enum" },
  { re: /^(\s*)karo\s+([A-Za-z_]\w*)\s*\(/, kind: "Function" },
  { re: /^(\s*)case\s+([A-Z]\w*)\s*(?:=|$)/, kind: "EnumMember" },
  { re: /^(\s*)(?:(?:public|private|protected|static|const)\s+)+(?:\??[\w\\]+(?:<[^>]*>)?\s+)?([A-Za-z_]\w*)\s*(?:=|$)/, kind: "Property" },
];

/**
 * Outline of a Barq file: classes, enums, interfaces, traits, functions and
 * properties, nested by indentation. Strings and comments that span lines are skipped.
 */
function documentSymbols(text) {
  const lines = String(text).split(/\r?\n/);
  const roots = [];
  const stack = []; // {indent, symbol}
  let inBlock = false;
  let inTriple = null;
  lines.forEach((line, i) => {
    if (inTriple) {
      if (line.includes(inTriple)) inTriple = null;
      return;
    }
    if (inBlock) {
      if (line.includes("*/")) inBlock = false;
      return;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith("/*") && !trimmed.includes("*/")) {
      inBlock = true;
      return;
    }
    const triple = (line.match(/"""|'''/g) || []);
    if (triple.length % 2 === 1) inTriple = triple[triple.length - 1];
    if (!trimmed || trimmed.startsWith("//")) return;
    for (const { re, kind } of SYMBOL_PATTERNS) {
      const m = re.exec(line);
      if (!m) continue;
      const indent = m[1].replace(/\t/g, "    ").length;
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      const parent = stack.length ? stack[stack.length - 1].symbol : null;
      let realKind = kind;
      if (kind === "Function" && parent && parent.kind !== "Function") realKind = m[2] === "__construct" ? "Constructor" : "Method";
      if (kind === "Property" && !parent) break; // top-level `const X = 1` is shown as a constant below
      const symbol = { name: m[2], kind: realKind, line: i, col: line.indexOf(m[2]), endLine: i, children: [] };
      (parent ? parent.children : roots).push(symbol);
      stack.push({ indent, symbol });
      break;
    }
    if (/^const\s+([A-Za-z_]\w*)/.test(line)) {
      const name = /^const\s+([A-Za-z_]\w*)/.exec(line)[1];
      roots.push({ name, kind: "Constant", line: i, col: line.indexOf(name), endLine: i, children: [] });
    }
  });
  // A symbol ends where the next one at the same or a lower level starts.
  const close = (list, end) => {
    list.forEach((s, k) => {
      s.endLine = k + 1 < list.length ? Math.max(s.line, list[k + 1].line - 1) : end;
      close(s.children, s.endLine);
    });
  };
  close(roots, Math.max(lines.length - 1, 0));
  trimEnds(roots, lines);
  return roots;
}

function trimEnds(list, lines) {
  for (const s of list) {
    // Blank lines and the #[...] attributes of the next declaration are not part of this one.
    while (s.endLine > s.line && (!lines[s.endLine].trim() || /^\s*#\[[^\]]*\]\s*$/.test(lines[s.endLine]))) s.endLine--;
    trimEnds(s.children, lines);
  }
}

/**
 * For `use App\Models\User` (or `use App\Models\User as U`), the files that
 * could hold it, relative to the project root — the same lookup barq does.
 */
function useTargets(line) {
  const m = /^\s*use\s+([A-Za-z_][\w\\]*)/.exec(line);
  if (!m) return null;
  const parts = m[1].split("\\").filter(Boolean);
  if (parts[0] === "Barq") return null; // standard library
  const start = line.indexOf(m[1]);
  const candidates = [path.join(...parts) + ".bq"];
  if (parts.length > 1) candidates.push(path.join(parts[0].toLowerCase(), ...parts.slice(1)) + ".bq");
  return { start, end: start + m[1].length, candidates };
}

/** The project root for a file: the nearest folder up with app/, routes/, .env or main.bq. */
function findProjectRoot(filePath, exists) {
  let dir = path.dirname(filePath);
  for (;;) {
    for (const marker of [".env", "routes", "app", "main.bq", "barq.json"]) {
      if (exists(path.join(dir, marker))) return dir;
    }
    const up = path.dirname(dir);
    if (up === dir) return path.dirname(filePath);
    dir = up;
  }
}

module.exports = { parseCheckOutput, fmtArgs, checkArgs, documentSymbols, useTargets, findProjectRoot };
