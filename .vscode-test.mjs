import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
  files: "out/test/**/*.test.js",
  // The oldest VS Code that engines in package.json allows.
  version: "1.140.0",
  workspaceFolder: "src/test/workspace",
  launchArgs: ["--disable-workspace-trust"],
});
