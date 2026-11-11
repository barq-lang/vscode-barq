// Tests that need no VS Code: the helpers in src/lib.js, the JSON files, the
// grammar's regexes, and (when a barq checkout sits next to this repo, or BARQ
// points at bin/barq) the real `barq fmt` / `barq check` round trip.
//
//   node test/run.js

"use strict";

const assert = require("assert");
const cp = require("child_process");
const fs = require("fs");
const path = require("path");
const lib = require("../src/lib");

const ROOT = path.join(__dirname, "..");
let passed = 0;
let skipped = 0;

function test(name, fn) {
  try {
    const result = fn();
    if (result === "skip") {
      skipped++;
      console.log(`  skip  ${name}`);
      return;
    }
    passed++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    console.log(`  FAIL  ${name}\n${err.stack}`);
    process.exitCode = 1;
  }
}

test("JSON files parse", () => {
  for (const f of ["package.json", "language-configuration.json", "template-configuration.json",
                   "snippets/barq.json", "syntaxes/barq.tmLanguage.json",
                   "syntaxes/barq-template.tmLanguage.json", "syntaxes/barq-template-injection.tmLanguage.json"]) {
    JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8"));
  }
});

test("package.json points at files that exist", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const files = [pkg.main, pkg.icon];
  for (const l of pkg.contributes.languages) files.push(l.configuration, l.icon.light, l.icon.dark);
  for (const g of pkg.contributes.grammars) files.push(g.path);
  for (const s of pkg.contributes.snippets) files.push(s.path);
  for (const f of files) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
  const commands = pkg.contributes.commands.map((c) => c.command);
  const srcDir = path.join(ROOT, "src");
  const src = fs.readdirSync(srcDir).map((f) => fs.readFileSync(path.join(srcDir, f), "utf8")).join("\n");
  for (const c of commands) assert.ok(src.includes(`"${c}"`), `command ${c} is not registered`);
  for (const d of pkg.contributes.debuggers) assert.ok(src.includes(`TYPE = "${d.type}"`), `debugger ${d.type} has no adapter`);
});

test("grammar regexes compile", () => {
  const walk = (node, where) => {
    if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${where}[${i}]`));
    if (node && typeof node === "object") {
      for (const key of ["match", "begin", "end"]) {
        if (typeof node[key] === "string") {
          try {
            new RegExp(node[key]);
          } catch (err) {
            throw new Error(`${where}.${key}: ${err.message}`);
          }
        }
      }
      for (const [k, v] of Object.entries(node)) walk(v, `${where}.${k}`);
    }
  };
  for (const f of fs.readdirSync(path.join(ROOT, "syntaxes"))) {
    walk(JSON.parse(fs.readFileSync(path.join(ROOT, "syntaxes", f), "utf8")), f);
  }
});

test("attribute lines and lists are told apart", () => {
  const g = JSON.parse(fs.readFileSync(path.join(ROOT, "syntaxes/barq.tmLanguage.json"), "utf8"));
  const re = new RegExp(g.repository["attribute-line"].match);
  assert.ok(re.test("    #[Public]"));
  assert.ok(re.test('#[Controller, "method"]  // handler'));
  assert.ok(!re.test("list<int> xs = #[1, 2]"));
});

test("parseCheckOutput", () => {
  const rows = lib.parseCheckOutput(
    'noise\n{"path": "a.bq", "line": 2, "col": 7, "endCol": 8, "kind": "CompileError", "message": "\'y\' is not defined"}\n{bad json\n'
  );
  assert.deepStrictEqual(rows, [{ line: 2, col: 7, endCol: 8, kind: "CompileError", message: "'y' is not defined" }]);
  assert.deepStrictEqual(lib.parseCheckOutput('{"line": 0, "message": "x"}')[0].line, 1);
});

test("fmtArgs and checkArgs", () => {
  assert.deepStrictEqual(lib.fmtArgs(4, true), ["fmt", "-"]);
  assert.deepStrictEqual(lib.fmtArgs(2, false), ["fmt", "--indent", "2", "--no-sort", "-"]);
  assert.deepStrictEqual(lib.checkArgs("/p/a.bq"), ["check", "--json", "--path", "/p/a.bq", "-"]);
});

test("documentSymbols", () => {
  const src = [
    "namespace App\\Models",
    "",
    "const LIMIT = 3",
    "",
    "class User extends Model",
    "    protected list<string> fillable = #[]",
    "    public static int count = 0",
    "",
    "    #[Public]",
    "    #[void]",
    "    karo __construct(string name)",
    '        string s = """',
    "            class NotAClass",
    '            """',
    "",
    "    karo greet()",
    "        return 1",
    "",
    "#[String]",
    "enum Status",
    '    case Active = "active"',
    "",
    "karo main()",
    "    print(1)",
  ].join("\n");
  const syms = lib.documentSymbols(src);
  const flat = (list, depth = 0) => list.flatMap((s) => [`${"  ".repeat(depth)}${s.kind} ${s.name} ${s.line}-${s.endLine}`, ...flat(s.children, depth + 1)]);
  assert.deepStrictEqual(flat(syms), [
    "Constant LIMIT 2-2",
    "Class User 4-16",
    "  Property fillable 5-5",
    "  Property count 6-6",
    "  Constructor __construct 10-13",
    "  Method greet 15-16",
    "Enum Status 19-20",
    "  EnumMember Active 20-20",
    "Function main 22-23",
  ]);
});

test("useTargets", () => {
  const t = lib.useTargets("use App\\Models\\User as U");
  assert.strictEqual(t.start, 4);
  assert.strictEqual(t.end, 4 + "App\\Models\\User".length);
  assert.deepStrictEqual(t.candidates, [path.join("App", "Models", "User.bq"), path.join("app", "Models", "User.bq")]);
  assert.strictEqual(lib.useTargets("use Barq\\Json"), null);
  assert.strictEqual(lib.useTargets("print(1)"), null);
});

test("findProjectRoot", () => {
  const have = new Set([path.join("/p", "routes")]);
  assert.strictEqual(lib.findProjectRoot("/p/app/Models/User.bq", (f) => have.has(f)), "/p");
  assert.strictEqual(lib.findProjectRoot("/x/y/z.bq", () => false), "/x/y");
});

// -- against a real barq -------------------------------------------------------------

function findBarq() {
  if (process.env.BARQ) return process.env.BARQ;
  const sibling = path.join(ROOT, "..", "barq", "bin", process.platform === "win32" ? "barq.cmd" : "barq");
  return fs.existsSync(sibling) ? sibling : null;
}

const barq = findBarq();

function run(args, input) {
  return cp.spawnSync(barq, args, { input, encoding: "utf8", shell: process.platform === "win32", env: { ...process.env, NO_COLOR: "1" } });
}

test("barq fmt through fmtArgs", () => {
  if (!barq) return "skip";
  const res = run(lib.fmtArgs(4, true), "if(x>1)\n  print( x )\n");
  assert.strictEqual(res.status, 0, res.stderr);
  assert.strictEqual(res.stdout, "if (x > 1)\n    print(x)\n");
});

test("barq check through checkArgs and parseCheckOutput", () => {
  if (!barq) return "skip";
  const res = run(lib.checkArgs("/tmp/t.bq"), 'int x = "a"\n');
  assert.strictEqual(res.status, 1);
  const rows = lib.parseCheckOutput(res.stdout);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].line, 1);
  assert.match(rows[0].message, /expects int/);
});

test("language server client reads framed messages split across chunks", () => {
  const { Client } = require("../src/client");
  const c = new Client({ command: "barq" });
  const got = [];
  c.on("note", (p) => got.push(p.text));
  let answer = null;
  c.waiting.set(7, { resolve: (r) => (answer = r), reject: () => {} });
  const frame = (msg) => {
    const body = Buffer.from(JSON.stringify(msg), "utf8");
    return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
  };
  const all = Buffer.concat([frame({ jsonrpc: "2.0", method: "note", params: { text: "برق 🙂" } }),
                             frame({ jsonrpc: "2.0", id: 7, result: { ok: true } })]);
  for (let i = 0; i < all.length; i += 5) c.receive(all.slice(i, i + 5)); // split mid-header and mid-character
  assert.deepStrictEqual(got, ["برق 🙂"]);
  assert.deepStrictEqual(answer, { ok: true });
});

test("every snippet expands to code barq check accepts", () => {
  if (!barq) return "skip";
  const snippets = JSON.parse(fs.readFileSync(path.join(ROOT, "snippets/barq.json"), "utf8"));
  // Snippets are fragments; give each the context it needs to be a whole program.
  const before = {
    Constructor: "class P\n    public string name\n", For: "list<int> collection = #[]\n",
    Foreach: "list<int> items = #[]\n", Switch: 'string value = "a"\n',
    Route: "class Controller\n    #[Public]\n    #[any]\n    karo method()\n        return 1\n\n",
    "Anonymous function": "any f = ", Lambda: "any f = ",
  };
  const after = {
    Function: "    print(1)", Class: "public int x = 0", "Anonymous function": "    return n",
    For: "    print(item)", Foreach: "    print(item)", If: "    print(1)", While: "    print(1)",
  };
  for (const [name, s] of Object.entries(snippets)) {
    let code = s.body.join("\n").replace(/\$\{\d+\}/g, "");
    for (let k = 0; k < 4; k++) {
      code = code.replace(/\$\{\d+\|([^,|]+)[^}]*\|\}/g, "$1").replace(/\$\{\d+:((?:[^{}]|\{[^{}]*\})*)\}/g, "$1");
    }
    code = code.replace(/\$\d+/g, "").replace(/\\\}/g, "}").replace(/condition/g, "true");
    code = code.replace(/\n    \n(else|except)/g, "\n    print(1)\n$1").replace(/^try\n    \n/m, "try\n    print(1)\n");
    code = code.replace(/:\n        \n    default:\n        $/, ":\n        print(1)\n    default:\n        print(2)");
    if (name === "Constructor") code = code.replace(/^#\[/gm, "    #[").replace(/^karo/m, "    karo").replace(/^    this/m, "        this");
    if (name === "If / else") code += "print(2)";
    const program = (before[name] || "") + code + (after[name] || "");
    const res = run(["check", "--json", "-"], program + "\n");
    assert.strictEqual(res.status, 0, `snippet ${name}:\n${program}\n${res.stdout}${res.stderr}`);
  }
});

console.log(`\n${passed} passed, ${skipped} skipped${process.exitCode ? ", some FAILED" : ""}`);
