// VS Code providers backed by `barq lsp`: completion, hover, definition,
// references, highlights, rename, signature help, outline, workspace symbols,
// formatting and diagnostics. LSP kinds are VS Code kinds + 1.

"use strict";

function make(vscode) {
  const pos = (p) => new vscode.Position(p.line, p.character);
  const range = (r) => new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);
  const toPos = (p) => ({ line: p.line, character: p.character });
  const md = (v) => {
    if (!v) return undefined;
    const value = typeof v === "string" ? v : v.value;
    return new vscode.MarkdownString(value);
  };
  const uri = (u) => vscode.Uri.parse(u);
  const location = (l) => new vscode.Location(uri(l.uri), range(l.range));

  function completionItem(it) {
    const item = new vscode.CompletionItem(it.label, Math.max((it.kind || 1) - 1, 0));
    if (it.detail) item.detail = it.detail;
    if (it.documentation) item.documentation = md(it.documentation);
    if (it.sortText) item.sortText = it.sortText;
    if (it.filterText) item.filterText = it.filterText;
    if (it.insertText !== undefined) {
      item.insertText = it.insertTextFormat === 2 ? new vscode.SnippetString(it.insertText) : it.insertText;
    }
    if (it.additionalTextEdits) {
      item.additionalTextEdits = it.additionalTextEdits.map((e) => vscode.TextEdit.replace(range(e.range), e.newText));
    }
    return item;
  }

  function documentSymbol(s) {
    const sym = new vscode.DocumentSymbol(s.name, s.detail || "", Math.max(s.kind - 1, 0), range(s.range), range(s.selectionRange));
    sym.children = (s.children || []).map(documentSymbol);
    return sym;
  }

  function signatureHelp(h) {
    const help = new vscode.SignatureHelp();
    help.signatures = (h.signatures || []).map((s) => {
      const info = new vscode.SignatureInformation(s.label, md(s.documentation));
      info.parameters = (s.parameters || []).map((p) => new vscode.ParameterInformation(p.label, md(p.documentation)));
      if (s.activeParameter !== undefined) info.activeParameter = s.activeParameter;
      return info;
    });
    help.activeSignature = h.activeSignature || 0;
    help.activeParameter = h.activeParameter || 0;
    return help;
  }

  function diagnostic(d) {
    const sev = { 1: "Error", 2: "Warning", 3: "Information", 4: "Hint" }[d.severity || 1];
    const item = new vscode.Diagnostic(range(d.range), d.message, vscode.DiagnosticSeverity[sev]);
    item.source = d.source || "barq";
    if (d.code !== undefined) item.code = d.code;
    return item;
  }

  function workspaceEdit(e) {
    const edit = new vscode.WorkspaceEdit();
    for (const [u, edits] of Object.entries(e.changes || {})) {
      for (const x of edits) edit.replace(uri(u), range(x.range), x.newText);
    }
    return edit;
  }

  return { pos, range, toPos, md, uri, location, completionItem, documentSymbol, signatureHelp, diagnostic, workspaceEdit };
}

/**
 * Providers that ask `getClient()` (a running Client, or null). With no server,
 * they fall back to `fallback` (the barq fmt / barq check versions) or return nothing.
 */
function providers(vscode, getClient, fallback) {
  const c = make(vscode);
  const td = (document) => ({ uri: document.uri.toString() });
  const at = (document, position) => ({ textDocument: td(document), position: c.toPos(position) });
  const ask = async (method, params, token) => {
    const client = getClient();
    if (!client) return undefined;
    try {
      return await client.request(method, params, token);
    } catch (err) {
      // -32803: the server refused (e.g. rename of something it can't rename) — show it
      if (err.code === -32803) throw err;
      return undefined;
    }
  };

  return {
    convert: c,
    completion: {
      async provideCompletionItems(document, position, token) {
        const r = await ask("textDocument/completion", at(document, position), token);
        if (!r) return undefined;
        const items = (Array.isArray(r) ? r : r.items || []).map(c.completionItem);
        return new vscode.CompletionList(items, Boolean(r.isIncomplete));
      },
    },
    hover: {
      async provideHover(document, position, token) {
        const r = await ask("textDocument/hover", at(document, position), token);
        if (!r || !r.contents) return undefined;
        return new vscode.Hover(c.md(r.contents), r.range ? c.range(r.range) : undefined);
      },
    },
    definition: {
      async provideDefinition(document, position, token) {
        const r = await ask("textDocument/definition", at(document, position), token);
        if (!r) return undefined;
        return Array.isArray(r) ? r.map(c.location) : c.location(r);
      },
    },
    references: {
      async provideReferences(document, position, context, token) {
        const p = { ...at(document, position), context: { includeDeclaration: context.includeDeclaration } };
        const r = await ask("textDocument/references", p, token);
        return r ? r.map(c.location) : undefined;
      },
    },
    highlights: {
      async provideDocumentHighlights(document, position, token) {
        const r = await ask("textDocument/documentHighlight", at(document, position), token);
        return r ? r.map((h) => new vscode.DocumentHighlight(c.range(h.range), Math.max((h.kind || 1) - 1, 0))) : undefined;
      },
    },
    rename: {
      async prepareRename(document, position, token) {
        const r = await ask("textDocument/prepareRename", at(document, position), token);
        if (!r) throw new Error("Barq: nothing to rename here.");
        return { range: c.range(r.range), placeholder: r.placeholder };
      },
      async provideRenameEdits(document, position, newName, token) {
        const r = await ask("textDocument/rename", { ...at(document, position), newName }, token);
        return r ? c.workspaceEdit(r) : undefined;
      },
    },
    signature: {
      async provideSignatureHelp(document, position, token) {
        const r = await ask("textDocument/signatureHelp", at(document, position), token);
        return r && r.signatures && r.signatures.length ? c.signatureHelp(r) : undefined;
      },
    },
    symbols: {
      async provideDocumentSymbols(document, token) {
        if (!getClient()) return fallback.symbols ? fallback.symbols(document) : undefined;
        const r = await ask("textDocument/documentSymbol", { textDocument: td(document) }, token);
        return r ? r.map(c.documentSymbol) : undefined;
      },
    },
    workspaceSymbols: {
      async provideWorkspaceSymbols(query, token) {
        const r = await ask("workspace/symbol", { query }, token);
        return r
          ? r.map((s) => new vscode.SymbolInformation(s.name, Math.max(s.kind - 1, 0), s.containerName || "", c.location(s.location)))
          : undefined;
      },
    },
    formatting: {
      async provideDocumentFormattingEdits(document, options, token) {
        if (!getClient()) return fallback.format ? fallback.format(document) : [];
        const r = await ask(
          "textDocument/formatting",
          {
            textDocument: td(document),
            // barq.format.indentSize wins over the editor's tab size
            options: { tabSize: fallback.indentSize ? fallback.indentSize() : options.tabSize, insertSpaces: true },
          },
          token
        );
        return (r || []).map((e) => vscode.TextEdit.replace(c.range(e.range), e.newText));
      },
    },
  };
}

module.exports = { make, providers };
