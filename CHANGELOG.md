# Changelog

## 0.3.0 — 2026-11-11

Debugging, through `barq dap` (Barq 0.24.0-alpha): press F5 on a `.bq` file, or use *Barq: Debug current file*. Breakpoints with conditions, hit counts and log messages, step over / into / out, the call stack, variables, watch, hover and the debug console, uncaught / all exception breakpoints, pause. A `barq` launch configuration type with `program`, `args`, `cwd`, `env` and `stopOnEntry`.

## 0.2.1 — 2026-11-11

Barq 0.23.0-alpha: `karo` is highlighted as a type (`karo kr`, `list<karo>`), and `kr` as a keyword only when it starts a lambda (`kr(int n): int => ...`), not in calls like `kr(value)`.

## 0.2.0 — 2026-11-11

Language features from the Barq language server (`barq lsp`, Barq 0.19.0-alpha): completion, hover, go to definition, references, highlights, rename of variables and parameters, signature help, workspace symbols; formatting, errors and the outline also come from it. The extension starts it, restarts it if it stops, and falls back to `barq fmt` / `barq check` when it is not available. New setting `barq.languageServer.enable`, new command *Barq: Restart language server*. Still no npm dependencies: the LSP client is in `src/client.js`.

## 0.1.0 — 2026-11-11

First release: syntax highlighting for code and `views/` templates, formatting with `barq fmt`, inline errors from `barq check`, outline, `use` links, snippets, and run / serve / test / REPL commands.
