# Barq VS Code Extension — design

> **Status (v0.1.0):** built — highlighting (code and `views/` templates), snippets, format on save (`barq fmt`), inline errors (`barq check`), outline, `use` links, file icon, and the Run / Serve / Test / REPL / Check workspace / Packages commands. Not yet: IntelliSense, hover, go to definition beyond `use` lines, inlay hints, the debugger, `barq new` (they need the language server). Settings that exist: `barq.path`, `barq.diagnostics.enable`, `barq.diagnostics.onType`, `barq.format.indentSize`, `barq.format.sortImports`, `barq.run.args`. The snippets below are from the early design; the shipped ones use today's syntax (`Route.get("/path", #[Controller, "method"])`). This page is the full plan.

> Official VS Code extension for the Barq programming language.  
> Provides syntax highlighting, IntelliSense, snippets, diagnostics, and debugging support.

---

## Installation

```
ext install barq-lang.barq-vscode
```

Or search **"Barq"** in the VS Code Extensions panel.

---

## Features

| Feature | Status |
|---------|--------|
| Syntax highlighting | ✅ |
| IntelliSense / autocomplete | ✅ |
| Code snippets | ✅ |
| Inline error diagnostics | ✅ |
| Go to definition | ✅ |
| Hover type information | ✅ |
| Auto-formatting (`barq fmt`) | ✅ |
| Debugger (breakpoints, step, inspect) | ✅ |
| Integrated terminal (`barq run`) | ✅ |
| File icons (`.bq`, `.bqc`) | ✅ |

---

## Syntax Highlighting

The extension colors Barq code using the standard VS Code token API, fully compatible with any VS Code theme (One Dark, Dracula, Catppuccin, etc.).

**Tokens highlighted:**
- Keywords: `karo`, `kr`, `class`, `enum`, `case`, `namespace`, `use`, `return`, `if`, `else`, `for`, `while`, `new`, `true`, `false`, `null`
- Types: `string`, `int`, `float`, `bool`, `void`, `list`, `dict`, `set`
- Attributes: `#[Public]`, `#[Private]`, `#[int]`, `#[void]`, etc.
- Collections: `#[]` list, `#{}` dict, `#()` set
- String interpolation: `"{variable}"` highlighted inside strings
- ORM query chains, Route definitions, namespace paths

---

## Snippets

Type a trigger and press `Tab` to expand.

| Trigger | Expands to |
|---------|-----------|
| `barqfn` | `#[Public]\n#[void]\nkaro name()\n    ` |
| `barqpub` | `#[Public]\n#[int]\nkaro name(params)\n    return ` |
| `barqclass` | `class Name\n\n    ` |
| `barqctor` | `#[Public]\n#[void]\nkaro __construct(params)\n    ` |
| `barqanon` | `karo(params): type\n    ` |
| `barqkr` | `kr(params): type => ` |
| `barqif` | `if (condition)\n    ` |
| `barqfor` | `for item in collection\n    ` |
| `barqeach` | `foreach item in items\n    ` |
| `barqtry` | `try\n    \nexcept Exception as e\n    Log.error(e.message)` |
| `barqroute` | `Route::get("/path", [Controller::class, "method"])->name("route.name")` |
| `barqmodel` | Full model class scaffold with `fillable`, `hidden`, `casts` |
| `barqmig` | Migration scaffold with `up()` and `down()` |
| `barqtest` | Test class scaffold |

---

## IntelliSense

The extension's language server provides:

- **Autocomplete** for methods, properties, and namespaces as you type
- **Parameter hints** — shows argument names and types when calling a function
- **Type inference** — infers the type of variables from assignment
- **Namespace resolution** — resolves `use App\Models\User` and jumps to the file

---

## Diagnostics (Inline Errors)

The extension runs the Barq type-checker in the background and shows errors inline without running the code.

```barq
#[string]
karo greet(string name)
    return name + 42   // ← squiggle: TypeError — cannot add string + int
```

Error categories shown inline:
- `TypeError` — wrong type passed or returned
- `UndefinedVariable` — variable used before assignment
- `MissingReturn` — function with return type has no `return` in all paths
- `NamespaceNotFound` — `use` path does not resolve to a file
- `AttributeConflict` — incompatible attributes on a class member

---

## Formatter

Runs `barq fmt` on save (enabled by default).

> **Status (v0.18.0-alpha):** `barq fmt` is built. The extension can pipe the open file through `barq fmt -` (stdin → stdout) and `barq fmt --indent N --no-sort` maps the two settings below. The extension itself is not built yet.

**VS Code setting to disable:**
```json
{
  "editor.formatOnSave": false
}
```

**Barq-specific formatter settings** (in `.vscode/settings.json`):
```json
{
  "barq.format.indentSize": 4,
  "barq.format.trailingNewline": true,
  "barq.format.sortImports": true
}
```

---

## Debugger

The extension integrates VS Code's debug UI with the Barq bytecode VM.

### Launch config (`.vscode/launch.json`)

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "barq",
      "request": "launch",
      "name": "Run Barq App",
      "program": "${workspaceFolder}/app/main.bq",
      "args": [],
      "stopOnEntry": false,
      "env": {
        "APP_ENV": "local"
      }
    }
  ]
}
```

### Debugger features

| Feature | Supported |
|---------|-----------|
| Breakpoints | ✅ |
| Conditional breakpoints | ✅ |
| Step over / into / out | ✅ |
| Variable inspection | ✅ |
| Watch expressions | ✅ |
| Call stack | ✅ |
| Hot reload on save | ✅ (web server mode) |

---

## Commands

Access via `Ctrl+Shift+P` (or `⌘+Shift+P` on Mac):

| Command | Description |
|---------|-------------|
| `Barq: Run current file` | Runs the open `.bq` file |
| `Barq: Run project` | Runs `barq run` from project root |
| `Barq: Format document` | Formats the current file |
| `Barq: Show type info` | Shows full type info at cursor |
| `Barq: Restart language server` | Restarts the background checker |
| `Barq: Open REPL` | Opens an interactive Barq REPL |
| `Barq: Create new project` | Runs `barq new` in a chosen folder |

---

## File Icons

The extension registers custom icons for Barq files in VS Code's file explorer:

| File type | Icon |
|-----------|------|
| `.bq` | Green lightning bolt |
| `.bqc` | Blue bytecode icon |
| `barq.json` | Config gear icon |
| `tailwind.config.bq` | Tailwind icon |

---

## Extension Settings

All settings are prefixed `barq.*` and configurable in VS Code settings or `.vscode/settings.json`.

| Setting | Default | Description |
|---------|---------|-------------|
| `barq.languageServer.enable` | `true` | Enable IntelliSense + diagnostics |
| `barq.format.onSave` | `true` | Auto-format on save |
| `barq.format.sortImports` | `true` | Sort `use` statements on format |
| `barq.run.args` | `[]` | Extra args passed to `barq run` |
| `barq.debug.hotReload` | `true` | Enable hot reload in debug mode |
| `barq.snippets.enable` | `true` | Enable code snippets |
| `barq.inlayHints.types` | `true` | Show inferred type hints inline |
| `barq.inlayHints.params` | `true` | Show param names in calls |

---

## Requirements

| Requirement | Version |
|-------------|---------|
| VS Code | ≥ 1.85 |
| Barq runtime | ≥ 0.1.0 |
| Node.js (for language server) | ≥ 18 |

---

## Open Decisions

| # | Question | Options |
|---|----------|---------|
| ⚠️ 90 | **Language server protocol** | Built-in LSP / External LSP daemon |
| ⚠️ 91 | **Extension store name** | `barq` / `barq-lang` / `barq-vscode` |
| ⚠️ 92 | **JetBrains support** | Official plugin / Community only |
| ⚠️ 93 | **Neovim / tree-sitter grammar** | Official / Community |

---

*Back to: [Step 11 — Versioning & Roadmap](https://github.com/barq-lang/barq/blob/main/docs/step-11-versioning-roadmap.md)*
