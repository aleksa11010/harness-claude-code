# harness-tools — Claude Code marketplace

Contains one plugin: **harness-cicd**, a Harness pane for Claude Code (your branch's builds, pipeline runs, what's deployed where, environments). See `plugins/harness-cicd/README.md`.

## Two ways to connect

- **Sign in with Harness (no API key):** press Enter at the installer's key prompt. Then, once, in Claude Code: `/mcp` → `plugin:harness-cicd:harness` → **Authenticate**. The plugin uses Harness's hosted MCP server through Claude Code's own OAuth connection. (Hosted MCP must be enabled for your Harness account.)
- **API key:** a PAT or service-account token with view access. Needed today for Harness Code pull requests and step logs.

Run `/harness doctor` any time: it checks every Harness API the plugin uses, read-only, and says what works.

## Install (macOS / Linux)

```bash
unzip harness-tools-marketplace.zip
./harness-tools/install.sh
```

It asks for your Harness org ID, project ID and API key (hidden input), then:
1. checks Claude Code is v2.1.287+,
2. copies this folder to `~/.claude-plugins/harness-tools` (Claude Code reads the plugin from there — you can delete the zip),
3. registers the marketplace and installs `harness-cicd@harness-tools`,
4. saves the key to your OS credential store (never `settings.json`, never on a command line),
5. tests the connection to Harness and tells you if the key or project is wrong.

Re-run it any time to update the plugin or change settings. Non-interactive:
`HARNESS_API_KEY=… HARNESS_DEFAULT_ORG_ID=… HARNESS_DEFAULT_PROJECT_ID=… ./harness-tools/install.sh --yes`

## Install (Windows, or by hand)

```
claude plugin marketplace add C:\path\to\harness-tools
claude plugin install harness-cicd@harness-tools --config org_id=YOUR_ORG --config project_id=YOUR_PROJECT
```
Then in a Claude Code session: `/plugin configure harness-cicd@harness-tools` and paste the API key.

## Use

Start Claude Code in a repo Harness builds and type `/harness`.

## Uninstall

`claude plugin marketplace remove harness-tools` (removes the plugin too).

## Hosted in Harness, with CI

- **Repo:** `harness-tools` in default / Playground_Aleksa — clone URL `https://git.harness.io/8INL1LHjRmmrZQKdYtlvKA/default/Playground_Aleksa/harness-tools.git`
- **Install from the repo:** `claude plugin marketplace add https://git.harness.io/8INL1LHjRmmrZQKdYtlvKA/default/Playground_Aleksa/harness-tools.git` then `claude plugin install harness-cicd@harness-tools` (or clone it and run `./install.sh`).
- **CI:** pipeline `harness_cicd_plugin_ci` (`.harness/harness-cicd-ci.yaml`) runs `claude plugin validate --strict` and `claude plugin test` on Harness Cloud; trigger `on_push_main` runs it on every push to main.
- **Ship a change:** bump `version` in `plugins/harness-cicd/.claude-plugin/plugin.json`, push to main, wait for green; teammates run `claude plugin marketplace update harness-tools && claude plugin update harness-cicd@harness-tools`.
