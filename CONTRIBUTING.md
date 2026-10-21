# Contributing

## Setup

Use Node.js 26 and VS Code 1.142 or later, matching the versions in CI and `package.json`.

```sh
git clone https://github.com/fornwall/diagram.git
cd diagram
npm ci
npm run compile
```

Open this folder in VS Code and press <kbd>F5</kbd> to launch an Extension Development Host. The launch task starts `npm run watch` to rebuild changes. Reload the development host to load extension changes; close and reopen the diagram panel to load webview changes.

Chat features need a chat provider in the development host. You can exercise the panel without one by opening a Markdown file with a `mermaid` or `echarts` block and clicking **Open in Diagram**.

## Checks and tests

`npm run compile` checks TypeScript, runs Biome and builds the extension and webview. `npm run format` applies formatting and safe lint fixes.

```sh
npm test
```

This builds the code and tests, downloads the VS Code version in `.vscode-test.mjs` if needed, and runs the suites in `src/test`. Tests include parsers and chart generation, extension behavior and rendering in real webviews. They do not need a chat account.

To run a subset, pass a test name or regular expression:

```sh
npm test -- --grep '^data '
```

On headless Linux, use a display large enough for the rendering tests:

```sh
xvfb-run -a --server-args="-screen 0 1920x1080x24" npm test
```

If tests hang when launched from VS Code's integrated terminal, run them from an external terminal. Inherited `ELECTRON_RUN_AS_NODE` or `VSCODE_*` environment variables can interfere with the test instance.

For a bug fix, include a small input that reproduces the failure and a regression test in the relevant suite. For panel changes, check the development host in light and dark themes and with keyboard navigation. Describe the changed behavior and the checks you ran in the pull request.

## Reporting bugs

Include the extension and VS Code versions, the steps to reproduce, and what you expected to happen. For rendering or parsing problems, include the Mermaid/ECharts source or a small data sample; a screenshot alone usually isn't enough to reproduce them. For chat problems, also include the model name and prompt.

## Source map

| Area | Starting points |
| --- | --- |
| Extension registration and chat | `src/extension.ts`, `src/participant.ts`, `src/prompt.ts` |
| Tool schemas and implementations | `package.json`, `src/tools.ts`, `src/chartTools.ts`, `src/workspaceTools.ts` |
| Panel state and host/webview messages | `src/panel.ts`, `src/webviewChannel.ts`, `src/protocol.ts` |
| Data parsing and chart generation | `src/data.ts`, `src/dataSource.ts`, `src/charts.ts`, related `data*` and `chart*` modules |
| Rendering and panel controls | `src/webview/main.ts`, `src/webview/mermaidRenderer.ts`, `src/webview/echartsRenderer.ts` |
| Markdown integration | `src/markdownDiagrams.ts`, `src/documentDiagram.ts`, `src/fences.ts` |
| Tests and webview harness | `src/test`, `src/test/webviewHarness.ts` |
| Bundling and packaging | `esbuild.mjs`, `.vscodeignore`, `.github/workflows/ci.yml` |

The extension host runs in Node.js; the webview runs in a browser. They have separate TypeScript configurations and communicate through the messages in `src/protocol.ts`. Keep host APIs out of webview code.

## Packaging

```sh
npm run analyze      # production build with bundle sizes and contents
npm run vsix         # production build packaged as a .vsix
```

Install the package with **Extensions: Install from VSIX…**.

CI tests and packages every push and pull request, running the rendering tests against the minified production bundles. Download `diagram-chat-<commit SHA>.vsix` from the **CI** run's artifacts within 90 days. Packages contain minified bundles, without source maps, and the licenses of the bundled packages in `dist/THIRD_PARTY_NOTICES.txt`.

## Publishing to Visual Studio Marketplace

Push a tag such as `v0.0.6` to publish `fornwall.diagram-chat`. CI checks that the tag is exactly `v` followed by the version in `package.json`, builds the production VSIX, and runs the tests. Only after those pass does a separate job download and publish that same VSIX using Microsoft Entra ID and GitHub OIDC. Branch pushes and pull requests only build and test.

### One-time identity setup

The workflows use the GitHub environment `marketplace`. In [the repository's environment settings](https://github.com/fornwall/diagram/settings/environments), allow the branch `main` (for the identity setup workflow) and tags matching `v*`. Leave required reviewers unset for automatic publishing.

1. In [Microsoft Entra app registrations](https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade), create a single-tenant app named `vs-code-marketplace-publisher`, with no redirect URI. Record the **Application (client) ID** and **Directory (tenant) ID** from its overview. Do not create a client secret. This app can be reused for other extensions under the same publisher; each repository needs its own federated credential.
2. Open the app's **Certificates & secrets → Federated credentials → Add credential**. Choose **Other issuer** and enter the values below, with a name such as `github-diagram-marketplace`:

   | Field | Value |
   | --- | --- |
   | Issuer | `https://token.actions.githubusercontent.com` |
   | Subject identifier | `repo:fornwall@277251/diagram@1400624323:environment:marketplace` |
   | Audience | `api://AzureADTokenExchange` |

   The subject includes immutable owner and repository IDs, as this repository's OIDC settings require. Use that exact value rather than the older `repo:fornwall/diagram:environment:marketplace` format. Scope the credential to the environment so it works for every release tag. See [GitHub's OIDC reference](https://docs.github.com/en/actions/reference/security/oidc#immutable-subject-claims) and [Microsoft's federation guide](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-create-trust).
3. Add environment **variables** (not secrets) named `AZURE_CLIENT_ID` and `AZURE_TENANT_ID` to `marketplace`, using the IDs from step 1. With GitHub CLI:

   ```sh
   gh variable set AZURE_CLIENT_ID --env marketplace --repo fornwall/diagram --body '<application-client-id>'
   gh variable set AZURE_TENANT_ID --env marketplace --repo fornwall/diagram --body '<directory-tenant-id>'
   ```

4. Once the workflow files are committed and pushed to `main`, run **Actions → Marketplace identity → Run workflow**, selecting `main`. Its log and run summary show the app's **Marketplace identity ID**, which is different from the Entra client and object IDs. The final **Verify publisher access** step will fail until step 5 is done. This workflow retrieves the ID and checks access; it does not publish. You can also start it with `gh workflow run marketplace-identity.yml --repo fornwall/diagram --ref main`.
5. In [the `fornwall` Marketplace publisher](https://marketplace.visualstudio.com/manage/publishers/fornwall), open **Members → Add**, enter that Marketplace identity ID, and give it the **Contributor** role. This grants publishing access to the publisher's extensions. Rerun **Marketplace identity** and confirm **Verify publisher access** passes. See [Microsoft's publisher identity instructions](https://learn.microsoft.com/en-us/azure/devops/extend/publish/command-line#publish-with-a-microsoft-entra-token).

The workflows use `azure/login` with `allow-no-subscriptions: true`, then `vsce publish --azure-credential`. They require an Entra tenant and permission to register an app, but no Azure subscription ID, client secret, or `VSCE_PAT` in GitHub. See [Azure Login's subscription-free login support](https://github.com/Azure/login#login-without-subscription).

### Release a version

Start with a clean working tree on `main` that includes the publishing workflows. For the next patch release:

```sh
npm version patch
git push origin main
git push origin "v$(node -p 'require("./package.json").version')"
```

`npm version patch` updates both package files, commits the version, and creates the matching tag. To release a version already committed in `package.json`, create that tag yourself with `git tag "v$(node -p 'require("./package.json").version')"`, then push it. Only tag a version that has not already been published. Versions must use `major.minor.patch` without prerelease suffixes.

Monitor the **CI** workflow's **Publish to Visual Studio Marketplace** job. If authentication fails, fix the identity configuration and rerun the failed job; the tested VSIX is retained for 90 days. Published versions cannot be overwritten: if the upload succeeded, use a new version for further changes.

[Open VSX](https://open-vsx.org/user-settings/extensions) remains a manual upload of the same VSIX.
