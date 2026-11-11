# Changelog

## 0.2.0 — 2026-11-11

Language features from the Barq language server (`barq lsp`, Barq 0.19.0-alpha): completion, hover, go to definition, references, highlights, rename of variables and parameters, signature help, workspace symbols; formatting, errors and the outline also come from it. The extension starts it, restarts it if it stops, and falls back to `barq fmt` / `barq check` when it is not available. New setting `barq.languageServer.enable`, new command *Barq: Restart language server*. Still no npm dependencies: the LSP client is in `src/client.js`.

## 0.1.0 — 2026-11-11

First release: syntax highlighting for code and `views/` templates, formatting with `barq fmt`, inline errors from `barq check`, outline, `use` links, snippets, and run / serve / test / REPL commands.
