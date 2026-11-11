# Barq for VS Code

Language support for [Barq (برق)](https://github.com/barq-lang/barq) `.bq` files.

- **Syntax highlighting** for code — keywords, `#[Public]` / `#[int]` attributes, `#[ #{ #(` collections, `"{name}"` interpolation, `?int` nullable types, `~int()` casts — and for templates in `views/` (`{expr}`, `{!raw!}`, `{-- --}`, `<if>` / `<each>` / `<extends>` tags).
- **IntelliSense** from the Barq language server (`barq lsp`): variables, members after `.` and `::`, project classes (the `use` line is added for you), built-in functions, modules and classes, `use` paths, attributes after `#[`.
- **Hover** shows a declaration as written and the `//` comment above it. **Signature help** shows the parameters while you type a call.
- **Go to definition**, **Find all references**, highlights, and **Rename** for variables and parameters.
- **Format on save** with `barq fmt`.
- **Inline errors** as you type: undefined names, type mismatches, wrong argument counts, syntax errors.
- **Outline, breadcrumbs and Go to Symbol in Workspace** (Ctrl+T): classes, enums, interfaces, traits, functions, methods, properties.
- **`use` links**: Ctrl+click `use App\Models\User` to open `app/Models/User.bq`.
- **Snippets**: `barqfn`, `barqpub`, `barqclass`, `barqctor`, `barqanon`, `barqkr`, `barqif`, `barqifelse`, `barqfor`, `barqeach`, `barqwhile`, `barqtry`, `barqswitch`, `barqenum`, `barqroute`, `barqmodel`, `barqcontroller`, `barqmig`, `barqtest`.
- **Commands**: *Barq: Run current file* (also the ▶ button), *Serve project*, *Run project tests*, *Check every file in the workspace*, *Open REPL*, *Show installed packages*, *Restart language server*.

## Requirements

Barq 0.19.0-alpha or later (it has `barq lsp`). With 0.18.0 only formatting, errors and the outline work — through `barq fmt` and `barq check` — and the Barq output panel says the language server is not available.

```bash
git clone https://github.com/barq-lang/barq
```

Then either put `barq/bin` on your `PATH`, or set **`barq.path`** to the full path of `barq/bin/barq` (`barq\bin\barq.cmd` on Windows).

## Settings

| Setting | Default | |
|---------|---------|---|
| `barq.path` | `barq` | The barq command |
| `barq.languageServer.enable` | `true` | Use `barq lsp`; when off, formatting, errors and the outline use `barq fmt` / `barq check` |
| `barq.diagnostics.enable` | `true` | Show errors |
| `barq.diagnostics.onType` | `true` | Check while typing, not only on save |
| `barq.format.indentSize` | `4` | `barq fmt --indent` |
| `barq.format.sortImports` | `true` | Sort `use` lines (`--no-sort` when off) |
| `barq.run.args` | `[]` | Extra arguments for *Run current file* |

Format on save is on for Barq files; turn it off with `"[barq]": {"editor.formatOnSave": false}`.

## Not yet

The debugger, renaming classes and methods, quick fixes, and completion after built-in methods (they have no declared return types yet) — see [docs/design.md](docs/design.md) for the full design.

## Development

```bash
git clone https://github.com/barq-lang/barq          # next to this repo; the tests use ../barq/bin/barq
git clone https://github.com/barq-lang/vscode-barq
cd vscode-barq
npm test                  # helpers, grammar, snippets, and the extension against a real barq
npm run package           # builds barq-vscode-0.2.0.vsix
code --install-extension barq-vscode-0.2.0.vsix
```

Press F5 in VS Code with this folder open to start an Extension Development Host. The extension has no npm dependencies.

## License

MIT
