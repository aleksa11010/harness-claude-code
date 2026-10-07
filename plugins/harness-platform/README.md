> **Full guide with screenshots:** see the [repository README](../../README.md). This file is the plugin's changelog and quick reference.

# harness-platform — Harness in Claude Code

A Claude Code mod (plugin) that gives you one pane for Harness, scoped to the repo and branch your session is in:

- **This branch:** has HEAD been built? Status, run number, link.
- **Pipelines:** recent runs for this repo, with what each built or deployed, the failing stage's error, and an **ask Claude** button on failures.
- **Deployed:** service × environment grid with the newest artifact, status and age (production marked ★).
- **Environments:** all environments in the project.

Also: a status line under the prompt, toasts when your runs finish/fail/wait for approval, 10-second polling for 15 minutes after Claude runs `git push`, and a `harness_status` tool Claude can call.

New in 0.11: **choose your starting screen** — Home, Your change, Deployments, Approvals, Service or Platform. Press `s` in any view ("Start here"), run `/harness start <view>`, or answer the installer; the choice is remembered and `/harness` reopens on it.

New in 0.10: **Home**
- The pane opens on **Home**: up to three **suggestions for right now** (a production deploy in progress, with its stages live; your failed commit; an incident or alerts on your service; an approval waiting; a degraded GitOps app; a critical security issue; a freeze; failing PR checks; a version ready to promote), and **every view** with a live badge: your change, deployments, approvals, service, security, operate, platform, all modules, project runs. `e` opens a suggestion straight on its item; `1`–`9` jump to a view; `o` comes back from anywhere.
- A production deploy starting is announced with a toast. `start_view` opens on runs, inventory or platform instead.

New in 0.9: **Harness Platform**
- **Renamed** from `harness-cicd` to `harness-platform`, because it now covers every Harness module.
- **14 platform modules** through Harness's MCP server: GitOps, Security (STO), Supply chain (SCS), Feature flags (FME), Alerts, Incidents, Artifact registry, Releases, Policies (OPA), Infrastructure (IaCM), Catalog (IDP), Cloud cost (CCM), Database DevOps, Chaos. A Platform hub (`m`, `/harness platform`), an attention line in the pane and band, GitOps health and owners in the inventory, critical security issues named in production confirmations, and feature flags referenced in your change.
- **Both connection modes:** the plugin bundles Harness's hosted MCP server (sign in) and a local `harness-mcp-v2` that Claude Code starts with your API key.
- **`/harness capture`:** an anonymized snapshot of real responses, to tighten every module against your account.

New in 0.8:
- **Deployment inventory** (`i`, `/harness inventory`): every service × environment × infrastructure in the project with the version live there (last successful deploy, from 90 days of CD history), newer running or failed deploys, split versions, and production drift. `e` opens a service down to each cluster: version, when, who, which run.
- **CD-only repos** (manifests here, no build in Harness): matched through the service's manifest store, including **repository-level Git connectors** (the connector's URL is read); **manifest changes not yet deployed** per environment; the push guard and "your change failed" work from deploys; the status line says "CD-only" instead of "not built".

New in 0.7:
- **`/harness doctor`:** read-only checks of every API the plugin uses (runs, services, environments, step details, logs, approvals, freeze windows, runtime inputs per pipeline, pull requests), each with a ✓ / ✗ / · verdict and what to do.
- **Runtime inputs:** rerun and retry resend the inputs the original run used; if none were recorded, the pipeline's runtime inputs are asked one by one (defaults and allowed values offered). More than six: it hands off to Harness or Claude instead.
- **Freeze windows:** an active freeze shows in the header, band and status line; production retries, reruns and approvals are blocked; other deploys say the freeze is on; Claude's production actions through the Harness MCP server are refused; pushes get a heads-up.
- **Sign in with Harness:** with no API key, everything goes through Harness's hosted MCP server (bundled in this plugin) using Claude Code's own OAuth connection: `/mcp` → `plugin:harness-platform:harness` → Authenticate.
- **Pull requests:** the open PR for your branch (Harness Code, or GitHub via `gh`) with its checks and review state, on the branch row, the band and the status line.

New in 0.6: **approvals**
- **Approvals waiting** section (every layout): runs in the project waiting on a Harness approval, with the approval message, who can approve (and how many are needed), the inputs it asks for, and when it expires. The band and status line show the count; a new approval is announced once with a toast.
- **approve / reject** on each approval (needs `allow_actions`): confirms first, asks for each approver input (default offered, or type your own), asks again when the run deploys to production, then posts the decision. If you're not an approver, Harness's own message is shown.
- Jira, ServiceNow and custom approvals are shown with where to decide them; they can't be approved through this API.
- `harness_status` tells Claude what's waiting. If Claude approves through the Harness MCP server, the production guardrail asks you first when that run deploys to production.

New in 0.5 (from the design review):
- **Layout is a preference:** `stacked` (default), `focus` (one headline about your commit), `dock` (sidebar beside the transcript in wide fullscreen terminals), `strip` (band only; the pane opens when your commit fails). Press `v` in the pane or `/harness layout <name>`; your choice is remembered.
- **Diagnosis card:** failed runs expand into Cause / Evidence / Likely fix with *fix with Claude*, *diagnose again* and *open in Harness*. `e` collapses or expands.
- **Select a row, then act:** `j`/`k` select, `a` opens that run's actions: diagnose (d), fix with Claude (f), retry failed stages (t), rerun (u), abort (x), approve (p), reject (n). Write actions need `allow_actions`, always ask first, and ask twice for production.
- **When your commit fails:** the question now offers **Always auto-fix**, which switches to auto mode and remembers it (`/harness autofix off` to go back).
- **Band above the prompt:** your commit's status, a sparkline of the last 20 runs, and prod lag; `h` opens the pane.
- **Promotion lanes:** each service from dev to prod, with how many commits each stage is behind HEAD.

New in 0.4:
- **Failure diagnosis:** a small model reads the failed stages/steps (and the step log tail when available) and writes a one-line cause and likely fix. `diagnose` button on failed rows, `/harness diagnose [id]`, or automatic (`diagnose` setting).
- **When your commit fails** (`on_failure`): `notify` (toast), `ask` (offer to let Claude fix it — default), or `auto` (Claude fixes and pushes, up to `auto_fix_attempts`, then hands back).
- **Push guard** (`push_guard`): when Claude is about to `git push` onto a red branch — `hold` asks first (default), `warn` toasts, `off`.
- **Production guardrail** (`prod_guard`): any Harness MCP write action (execute/create/update/delete) that targets a production environment asks you first, in every permission mode; with nobody to ask it is denied.
- **Commits behind prod:** how far the last successful prod deploy is behind your HEAD (pane, tool, context).
- **Automatic context** (`add_context`): prompts about builds/deploys/releases get one line of current Harness state.

The pane itself is still read-only: it never runs, approves, or rolls back anything. Per-shell overrides: `HARNESS_CICD_ON_FAILURE`, `HARNESS_CICD_PUSH_GUARD`, `HARNESS_CICD_DIAGNOSE`.

## Requirements

- Claude Code **v2.1.287+** (`claude --version`). Tested on 2.1.289.
- A Harness API key (PAT or service-account token) with **view** permission on pipelines/executions, services and environments in the project.

## Try it

```bash
export HARNESS_API_KEY=pat.xxxxx            # account ID is read from the key
export HARNESS_DEFAULT_ORG_ID=your_org      # same env vars as the Harness MCP server
export HARNESS_DEFAULT_PROJECT_ID=your_project
cd /path/to/a/repo/that/harness/builds
claude --plugin-dir /path/to/harness-platform
```

Type `/harness` (or wait: the pane opens at start in terminals ≥144 columns). Keys: `1` this repo, `2` whole project, `r` refresh, `v` layout, `j`/`k` select, `e` expand, `a` actions, `f` fix, `d` diagnose, Esc closes.
`/harness all` opens on the whole project; `/harness refresh` forces a refresh.

Instead of env vars you can set the values in `/config` (the API key is stored in your OS credential store, not settings.json).

## Settings (`userConfig`)

| Setting | Default | Notes |
| - | - | - |
| api_key | — | sensitive; or `HARNESS_API_KEY` |
| project_id | — | or `HARNESS_DEFAULT_PROJECT_ID` |
| org_id | `default` | or `HARNESS_DEFAULT_ORG_ID` |
| account_id | from key | or `HARNESS_ACCOUNT_ID` |
| base_url | `https://app.harness.io` | or `HARNESS_BASE_URL` (SMP / regional) |
| repo_name | git origin | override when the remote name differs from Harness's repo name |
| poll_seconds | 60 | 10 s while watching a push; backs off to 5 min on errors |
| max_runs | 50 | executions fetched per refresh |
| auto_open | true | open the pane at session start |
| skip_user_lookup | false | set true for service-account keys |
| on_failure | ask | notify · ask · auto |
| auto_fix_attempts | 2 | 1–5, for on_failure = auto |
| push_guard | hold | hold · warn · off |
| prod_guard | true | confirm Harness write actions that target production |
| diagnose | auto | auto · on_demand · off (uses a small model on your plan) |
| add_context | true | one line of Harness state on CI/deploy prompts |
| layout | stacked | stacked · focus · dock · strip (press v to switch) |
| band | true | band above the prompt with sparkline |
| allow_actions | false | retry / rerun / abort / approve / reject from the actions menu |

## Harness API calls (per refresh)

- `POST /pipeline/api/pipelines/execution/summary` (`{"filterType":"PipelineExecution"}`)
- `GET /ng/api/servicesV2`
- `GET /ng/api/environmentsV2`
- `GET /ng/api/user/currentUser` (once; lets "mine" fall back to runs you triggered)
- Write actions (only with `allow_actions`, after you confirm): `POST /pipeline/api/pipeline/execute/retry/{pipeline}`, `POST …/execute/rerun/{id}/{pipeline}`, `PUT …/execute/interrupt/{id}?interruptType=AbortAll`, `POST /pipeline/api/approvals/{approvalId}/harness/activity` (`{action, comments, approverInputs}`)
- For runs waiting on approval: `GET /pipeline/api/v1/orgs/{org}/projects/{project}/approvals/execution/{id}?approval_status=WAITING` (documented Approvals API; up to 5 runs per refresh)
- For a diagnosis only: `GET /pipeline/api/pipelines/execution/v2/{id}?renderFullBottomGraph=true`, and best-effort `GET /gateway/log-service/token` + `/gateway/log-service/blob` for the failed step's log

## How "this repo" is matched

The git `origin` remote's last path segment (e.g. `guest_flow` → `guest-flow`) is compared with the CI repo name / repo URL / SCM URL on each execution, plus the `repoName` in service manifests. If nothing matches it falls back to runs you triggered, then the whole project — and the pane says so.

## Where it draws

Terminal and the Desktop app's Code tab draw the pane. In `claude -p` and the VS Code chat panel, `/harness` prints a text report instead.

## Develop

```bash
claude plugin validate .   # static check: events hooked, API calls made
claude plugin test         # 120 tests, no network or sign-in needed
```
