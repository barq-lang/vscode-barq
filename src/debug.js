// Debugging: VS Code runs `barq dap` (Barq 0.24.0+), the Barq debug adapter,
// and talks the Debug Adapter Protocol with it. The adapter runs the program
// itself, so all the extension does is say where barq is and fill in a launch
// configuration when there is no launch.json.

"use strict";

const path = require("path");

const TYPE = "barq";

/** The configuration F5 uses on a .bq file with no launch.json. */
function defaultConfig(file) {
  return {
    type: TYPE,
    request: "launch",
    name: "Barq: Debug current file",
    program: file || "${file}",
    stopOnEntry: false,
  };
}

/** Fill in what a launch configuration leaves out. Returns undefined (cancel)
 *  when there is nothing to run. */
function resolveConfig(config, activeFile, runArgs) {
  config = Object.assign({}, config || {});
  if (!config.type && !config.request && !config.name) {
    if (!activeFile) return undefined;
    Object.assign(config, defaultConfig(activeFile));
  }
  config.type = config.type || TYPE;
  config.request = config.request || "launch";
  config.name = config.name || "Barq: Debug";
  if (!config.program) {
    if (!activeFile) return undefined;
    config.program = activeFile;
  }
  if (!config.cwd && config.program && !config.program.includes("${")) config.cwd = path.dirname(config.program);
  if (config.args === undefined && runArgs && runArgs.length) config.args = runArgs.slice();
  return config;
}

function register(vscode, context, { barqCommand, activeBarqFile, runArgs }) {
  const factory = {
    createDebugAdapterDescriptor(session) {
      const program = session.configuration && session.configuration.program;
      const cwd = session.configuration.cwd || (program ? path.dirname(program) : undefined);
      return new vscode.DebugAdapterExecutable(barqCommand(), ["dap"], cwd ? { cwd } : {});
    },
  };
  const provider = {
    provideDebugConfigurations() {
      return [defaultConfig("${file}")];
    },
    resolveDebugConfiguration(folder, config) {
      const resolved = resolveConfig(config, activeBarqFile(), runArgs());
      if (!resolved) {
        vscode.window.showWarningMessage("Barq: open a .bq file to debug it, or set \"program\" in launch.json.");
      }
      return resolved;
    },
  };
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory(TYPE, factory),
    vscode.debug.registerDebugConfigurationProvider(TYPE, provider),
    vscode.commands.registerCommand("barq.debugFile", async () => {
      const file = activeBarqFile();
      if (!file) {
        vscode.window.showWarningMessage("Barq: open a .bq file to debug it.");
        return;
      }
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document.isDirty) await editor.document.save();
      const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file));
      await vscode.debug.startDebugging(folder, resolveConfig(defaultConfig(file), file, runArgs()));
    })
  );
  return { factory, provider };
}

module.exports = { register, resolveConfig, defaultConfig, TYPE };
