// harness-platform — a single pane of glass for Harness inside Claude Code.
//
//   /harness            open the pane (scoped to the repo/branch you're in)
//   /harness all        open it showing the whole project
//   /harness refresh    refresh now
//
// Also: a status line under the prompt, toasts when your runs finish, faster polling
// after Claude runs `git push`, and a `harness_status` tool Claude can call.

import {
  statusKind, ICON, COLOR, isTerminal, ago, short, fit, pad, accountFromKey, repoKey,
  execCi, cdTargets, failureMessage, execUrl, projectUrl, buildView, toolSummary, textReport,
  failedSteps, logTail, DIAGNOSIS_SYSTEM, diagnosisPrompt, parseDiagnosis,
  isGitPush, isHarnessWrite, prodTargets, prodCommit, wantsContext, contextLine, autoFixPrompt,
  envCommits, SPARK, sparkRuns, failedStageIds, actionsFor,
  isApprovalWaiting, parseApprovals, expiresIn, approvalWhere, approvalBody,
  parseTemplateInputs, fillTemplate, parseFreeze, freezeText, harnessCodeRef, isGithubRemote,
  parseHarnessPr, parseGhPr, prLine, summarizeChecks, mcpJson, mcpItems, accountFromUrl,
  buildInventory, mergeRuns, inventoryCell, inventoryText, servicesInRepo, execRepoKeys,
  parseManifests, connectorScope, repoManifestPaths,
  MODULES, moduleItems, moduleSummary, attentionLine, flagsInDiff, anonymize,
} from './lib.js'

const PANE = 'harness'
const TOOL = 'mcp__harness-platform__harness_status'
const BURST_MS = 15 * 60 * 1000 // after a git push, poll fast for 15 minutes
const BURST_EVERY_MS = 10 * 1000

let cfg = {}
let scope = 'mine'
let data = { executions: [], services: [], environments: [], git: null, me: null }
let error = null
let updatedAt = 0
let pending = null
let lastAttempt = 0 // when the last refresh started, success or not
let failures = 0 // consecutive failed refreshes, for backoff
const MAX_BACKOFF_MS = 5 * 60 * 1000
let burstUntil = 0
let prevKinds = null // planExecutionId → status kind, for "finished" toasts
const diagnoses = new Map() // planExecutionId → { state: 'done'|'error', cause, evidence, fix, confidence, fromLogs }
const diagRuns = new Map() // planExecutionId → in-flight diagnosis promise
const fixAttempts = new Map() // "pipeline@branch" → auto-fix attempts so far
let behind = null // commits between the last good prod deploy and HEAD
let behindByCommit = new Map() // deployed commit → commits behind HEAD
const approvals = new Map() // planExecutionId → waiting approval instances
let seenApprovals = null // approval ids already announced
let freeze = null // { active, upcoming, frozen } from the freeze APIs
let freezeAt = 0
let pr = null // the open pull request for this branch, if any
let prAt = 0
let prBranch = ''
let prError = ''
const SIGN_IN = 'Harness sign-in needed: run /mcp, choose the Harness server, Authenticate — or set an API key in /plugin configure'
const LAYOUTS = ['stacked', 'focus', 'dock', 'strip']
let layout = 'stacked'
// Pane interaction state: selected run, expanded diagnosis cards, actions menu, dock tab
const view = { selected: null, expanded: new Set(), collapsed: new Set(), menu: false, tab: 'runs', mode: 'runs', invSel: null, invOpen: new Set(), homeSel: 0, svcIdx: 0, modFilter: null, modFilterLabel: '' }
let seenProdRuns = null // production deploys already announced as started
// Starting screens: setting < saved choice (s in the pane, /harness start) < HARNESS_PLATFORM_START
const START_VIEWS = ['home', 'runs', 'inventory', 'approvals', 'service', 'platform']
const START_LABEL = { home: 'Home', runs: 'Your change', inventory: 'Deployments', approvals: 'Approvals', service: 'Service', platform: 'Platform' }
const modeFor = (v) => (v === 'platform' ? 'modules' : v)
const startOf = (mode) => (mode === 'modules' ? 'platform' : START_VIEWS.includes(mode) ? mode : null)
// Deployment inventory: CD runs from the last `inventory_days`, scanned only while someone uses it
const inv = { store: new Map(), scannedAt: 0, usedAt: 0, scanning: null, runs: 0, error: '' }
const INV_RESCAN_MS = 10 * 60 * 1000
// CD-only repos: Git connectors behind service manifests, and manifest changes not yet deployed
const connectors = new Map() // connectorRef → { url, type: 'Repo' | 'Account' } | null (unreadable)
let connectorsAt = 0
let pendingChanges = new Map() // service \0 env → commits touching the service's manifests since its last good deploy
const pendingCache = new Map() // "paths|since" → count
// Platform modules (GitOps, security, flags, alerts, …) through the Harness MCP server
const mods = { results: new Map(), at: 0, fetching: null, usedAt: 0, raw: new Map() }
let changeFlags = { head: '', names: [] } // feature flags referenced in your change
const pick = (v, allowed, dflt) => (allowed.includes(v) ? v : dflt)

// ---- Harness REST -----------------------------------------------------------

async function harness($, method, path, params, body) {
  return (await harnessJson($, method, path, params, body))?.data
}

// Most Harness APIs wrap results in { data }; Harness Code answers bare JSON
async function harnessJson($, method, path, params, body) {
  const all = { routingId: cfg.account_id, accountIdentifier: cfg.account_id, orgIdentifier: cfg.org_id, projectIdentifier: cfg.project_id, ...params }
  for (const k of Object.keys(all)) if (all[k] === null || all[k] === undefined) delete all[k]
  const qs = new URLSearchParams(all)
  const res = await $.http.fetch(cfg.base_url + path + '?' + qs.toString(), {
    method,
    headers: { 'x-api-key': cfg.api_key, 'Content-Type': typeof body === 'string' ? 'application/yaml' : 'application/json', Accept: 'application/json' },
    body: typeof body === 'string' ? body : body ? JSON.stringify(body) : undefined,
  })
  let msg = ''
  if (!res.ok) { try { msg = JSON.parse(res.text)?.message ?? '' } catch { msg = '' } }
  if (res.status === 401 || (res.status === 403 && !msg)) throw new Error(`Harness refused the API key (HTTP ${res.status}) — check scope and permissions`)
  if (!res.ok) {
    throw new Error(msg ? `${msg} (HTTP ${res.status})` : `${path} → HTTP ${res.status}`)
  }
  return res.text ? JSON.parse(res.text) : null
}

// Sign-in mode: Harness's MCP server through Claude Code's own (OAuth) connection
async function mcp($, tool, args) {
  let result
  try {
    result = await $.mcp.call(cfg.mcp_server, tool, { org_id: cfg.org_id, project_id: cfg.project_id, ...args })
  } catch (err) {
    // The call itself failing means the server isn't connected or signed in; keep the detail for the doctor
    throw new Error(`${SIGN_IN} [${fit(String(err?.message ?? err), 100)}]`)
  }
  return mcpJson(result)
}

async function whoAmI($) {
  // Best effort: lets "mine" include runs you triggered. Service-account keys have no user.
  try {
    const d = await harness($, 'GET', '/ng/api/user/currentUser', {})
    return d?.email ?? null
  } catch {
    return null
  }
}

// ---- Git context (what you're working on) ---------------------------------------

async function readGit($) {
  let repo = null
  try { repo = await $.session.repo() } catch { repo = null }
  if (!repo && !cfg.repo_name) return null
  let branch = null
  let head = null
  let headTime = 0
  try {
    const b = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 5000 })
    if (b.exitCode === 0) branch = b.stdout.trim()
    const h = await $.process.run(['git', 'rev-parse', 'HEAD'], { timeoutMs: 5000 })
    if (h.exitCode === 0) head = h.stdout.trim()
    const ht = await $.process.run(['git', 'log', '-1', '--format=%ct', 'HEAD'], { timeoutMs: 5000 })
    if (ht.exitCode === 0 && /^\d+$/.test(ht.stdout.trim())) headTime = Number(ht.stdout.trim()) * 1000
  } catch {
    // $.process is CLI-only; in the Desktop app fall back to reading .git/HEAD
    try {
      const txt = await $.fs.read(repo.root + '/.git/HEAD')
      const m = /ref: refs\/heads\/(.+)/.exec(String(txt))
      if (m) branch = m[1].trim()
    } catch { /* not a plain checkout */ }
  }
  return {
    root: repo?.root ?? '', remote: repo?.remote ?? '',
    name: repoKey(cfg.repo_name || repo?.remote || repo?.root),
    branch: branch === 'HEAD' ? null : branch, head, headTime,
  }
}

// ---- Refresh ------------------------------------------------------------------

// Callers that arrive mid-refresh wait for the same refresh instead of reading stale data
function refresh($) {
  if (!pending) pending = doRefresh($).finally(() => { pending = null })
  return pending
}

async function doRefresh($) {
  lastAttempt = await $.clock.now()
  try {
    if (!cfg.project_id || (cfg.auth === 'key' && !cfg.account_id)) {
      error = 'not configured'
      $.ui.status('harness: not configured — run /harness for setup')
      $.ui.invalidate('ui.render')
      return
    }
    let git, execs, svcs, envs
    if (cfg.auth === 'mcp') {
      ;[git, execs, svcs, envs] = await Promise.all([
        readGit($),
        mcp($, 'harness_list', { resource_type: 'execution', size: cfg.max_runs, compact: false }).then(mcpItems),
        mcp($, 'harness_list', { resource_type: 'service', size: 100, compact: false }).then(mcpItems),
        mcp($, 'harness_list', { resource_type: 'environment', size: 100, compact: false }).then(mcpItems),
      ])
      if (!cfg.account_id) cfg.account_id = accountFromUrl(execs.find((x) => x?.openInHarness)?.openInHarness)
      if (data.me === null) data.me = ''
    } else {
      const lookupUser = data.me === null && !cfg.skip_user_lookup
      let me
      ;[git, execs, svcs, envs, me] = await Promise.all([
        readGit($),
        harness($, 'POST', '/pipeline/api/pipelines/execution/summary', { page: '0', size: String(cfg.max_runs) }, { filterType: 'PipelineExecution' }).then((d) => d?.content ?? []),
        harness($, 'GET', '/ng/api/servicesV2', { page: '0', size: '100' }).then((d) => d?.content ?? []),
        harness($, 'GET', '/ng/api/environmentsV2', { page: '0', size: '100' }).then((d) => d?.content ?? []),
        lookupUser ? whoAmI($) : Promise.resolve(data.me),
      ])
      if (lookupUser) data.me = me ?? ''
    }
    data = {
      ...data,
      git,
      executions: execs,
      services: svcs.map((x) => x.service ?? x),
      environments: envs.map((x) => x.environment ?? x),
    }
    error = null
    failures = 0
    updatedAt = await $.clock.now()
    await fetchConnectors($)
    data.connectors = connectors
    behind = await countBehind($)
    mergeRuns(inv.store, data.executions)
    await countPendingChanges($)
    const modsInUse = cfg.module_attention || view.mode === 'home' || updatedAt - mods.usedAt < 30 * 60_000
    if (modsInUse && updatedAt - mods.at >= cfg.modules_poll_ms) fetchModules($) // background
    const inUse = updatedAt - inv.usedAt < 30 * 60_000
    if (inUse && updatedAt - inv.scannedAt >= INV_RESCAN_MS) scanInventory($) // background; the pane redraws when done
    await Promise.all([fetchApprovals($), fetchFreeze($), fetchPr($)])
    notify($)
  } catch (err) {
    failures++
    error = String(err?.message ?? err)
    $.ui.status('harness: ' + fit(error, 80))
  } finally {
    $.ui.invalidate('ui.render')
  }
}

// ---- Freeze windows (every 5 minutes) --------------------------------------------------

async function fetchFreeze($) {
  const now = await $.clock.now()
  if (freezeAt && now - freezeAt < 5 * 60_000) return
  freezeAt = now
  let g = null
  let l = null
  if (cfg.auth === 'mcp') {
    ;[g, l] = await Promise.all([
      mcp($, 'harness_get', { resource_type: 'global_freeze' }).catch(() => null),
      mcp($, 'harness_list', { resource_type: 'freeze_window', filters: { freeze_status: 'Enabled' }, compact: false }).then((j) => ({ content: mcpItems(j) })).catch(() => null),
    ])
  } else {
    ;[g, l] = await Promise.all([
      harness($, 'GET', '/ng/api/freeze/getGlobalFreeze', {}).catch(() => null),
      harness($, 'POST', '/ng/api/freeze/list', { page: '0', size: '50' }, { filterType: 'FreezeSetup', freezeStatus: 'Enabled' }).catch(() => null),
    ])
  }
  freeze = g || l ? parseFreeze(g, l, now) : null
}

// ---- Pull request for this branch (every 2 minutes): Harness Code, or GitHub via gh ------

function codePrUrl(ref, n) {
  const p = ref.replace(/\/\+$/, '').split('/')
  const [acc, org] = p
  const repo = p.at(-1)
  const proj = p.length === 4 ? p[2] : ''
  return `${cfg.base_url}/ng/account/${acc}/module/code/orgs/${org}${proj ? `/projects/${proj}` : ''}/repos/${repo}/pulls/${n}`
}

async function fetchPr($) {
  const g = data.git
  if (!g?.branch || !g.remote) { pr = null; return }
  const now = await $.clock.now()
  if (prAt && now - prAt < 2 * 60_000 && prBranch === g.branch) return
  prAt = now
  prBranch = g.branch
  const ref = harnessCodeRef(g.remote)
  try {
    if (ref && cfg.auth === 'key') {
      const list = await harnessJson($, 'GET', `/code/api/v1/repos/${ref}/pullreq`, { state: 'open', source_branch: g.branch, limit: '20' })
      const open = (Array.isArray(list) ? list : []).find((p) => p?.source_branch === g.branch && (!p.state || p.state === 'open'))
      if (!open) { pr = null; prError = ''; return }
      const [checks, reviewers] = await Promise.all([
        harnessJson($, 'GET', `/code/api/v1/repos/${ref}/pullreq/${open.number}/checks`, {}).catch(() => []),
        harnessJson($, 'GET', `/code/api/v1/repos/${ref}/pullreq/${open.number}/reviewers`, {}).catch(() => []),
      ])
      pr = parseHarnessPr([open], g.branch, checks, reviewers)
      if (pr) pr.url = codePrUrl(ref, open.number)
    } else if (isGithubRemote(g.remote)) {
      const r = await $.process.run(['gh', 'pr', 'view', '--json', 'number,title,state,isDraft,reviewDecision,statusCheckRollup,url,baseRefName'], { timeoutMs: 8000 })
      pr = r.exitCode === 0 ? parseGhPr(JSON.parse(r.stdout)) : null
      if (r.exitCode !== 0 && !/no pull requests found/i.test(r.stderr)) prError = fit(r.stderr.trim() || 'gh failed', 120)
    } else {
      pr = null
    }
    prError = pr || !prError ? '' : prError
  } catch (err) {
    pr = null
    prError = fit(String(err?.message ?? err), 120)
  }
}

// ---- CD-only repos ------------------------------------------------------------------------

// Read the Git connectors behind service manifests (every 30 min): repo-level connectors hold the repo URL
async function fetchConnectors($) {
  if (!data.git?.name) return
  const now = await $.clock.now()
  if (connectorsAt && now - connectorsAt < 30 * 60_000) return
  connectorsAt = now
  const refs = [...new Set(data.services.flatMap((x) => parseManifests(x.yaml).map((m) => m.connectorRef)).filter(Boolean))].slice(0, 15)
  await Promise.all(refs.map(async (ref) => {
    const { id, scope: sc } = connectorScope(ref)
    try {
      const d = cfg.auth === 'mcp'
        ? await mcp($, 'harness_get', { resource_type: 'connector', resource_id: id, resource_scope: sc, ...(sc === 'account' ? { org_id: undefined, project_id: undefined } : sc === 'org' ? { project_id: undefined } : {}) })
        : await harness($, 'GET', '/ng/api/connectors/' + encodeURIComponent(id), sc === 'account' ? { orgIdentifier: null, projectIdentifier: null } : sc === 'org' ? { projectIdentifier: null } : {})
      const spec = (d?.connector ?? d)?.spec ?? {}
      connectors.set(ref, spec.url ? { url: String(spec.url), type: spec.type === 'Repo' ? 'Repo' : 'Account' } : null)
    } catch {
      connectors.set(ref, null)
    }
  }))
}

const repoServiceIds = () => servicesInRepo(data.services, data.git?.name || '', connectors)
// A repo Harness deploys from but never builds: no run carries this repo as its codebase
function isCdOnly() {
  const key = data.git?.name || ''
  if (!key || !repoServiceIds().size) return false
  return ![...data.executions, ...inv.store.values()].some((x) => execRepoKeys(x).has(key))
}
const deploysRepoService = (x) => { const ids = repoServiceIds(); return cdTargets(x).some((t) => ids.has(t.service)) }

// Newest successful deploy per service × environment, across recent runs and the inventory
function lastGoodDeploys() {
  const out = new Map()
  for (const x of [...data.executions, ...inv.store.values()]) {
    for (const t of cdTargets(x)) {
      if (t.status !== 'Success' || !t.env) continue
      const k = t.service + '\u0000' + t.env
      if (!out.has(k) || out.get(k).at < t.startTs) out.set(k, { at: t.startTs, run: x })
    }
  }
  return out
}

// Commits on your branch that touched a service's manifest paths since its last good deploy, per environment
async function countPendingChanges($) {
  pendingChanges = new Map()
  const key = data.git?.name
  if (!key || !data.git?.head) return
  const good = lastGoodDeploys()
  let calls = 0
  for (const svc of data.services) {
    const paths = repoManifestPaths(svc, key, connectors)
    if (!paths.length) continue
    for (const [k, g] of good) {
      if (!k.startsWith(svc.identifier + '\u0000') || calls >= 16) continue
      const since = Math.floor(g.at / 1000)
      const ck = paths.join(',') + '|' + since
      if (!pendingCache.has(ck)) {
        calls++
        try {
          const r = await $.process.run(['git', 'rev-list', '--count', `--since=${since}`, 'HEAD', '--', ...paths], { timeoutMs: 5000 })
          if (r.exitCode === 0) pendingCache.set(ck, Number(r.stdout.trim()))
        } catch {
          return // CLI-only
        }
      }
      if (pendingCache.has(ck)) pendingChanges.set(k, pendingCache.get(ck))
    }
  }
}

// The deploy of one of this repo's services that is currently red (newest attempt per service/env failed)
function cdRedDeploy() {
  const ids = repoServiceIds()
  const newest = new Map()
  for (const x of [...data.executions, ...inv.store.values()]) {
    for (const t of cdTargets(x)) {
      if (!ids.has(t.service) || !t.env) continue
      const k = t.service + '\u0000' + t.env
      if (!newest.has(k) || newest.get(k).t.startTs < t.startTs) newest.set(k, { x, t })
    }
  }
  return [...newest.values()].filter((v) => statusKind(v.t.status) === 'fail').sort((a, b) => b.t.startTs - a.t.startTs)[0] ?? null
}

const pendingText = (n) => (n === 0 ? 'up to date' : `${n} change${n === 1 ? '' : 's'} pending`)

// ---- Platform modules ---------------------------------------------------------------------

function fetchModules($) {
  if (!mods.fetching) mods.fetching = doFetchModules($).finally(() => { mods.fetching = null; $.ui.invalidate('ui.render') })
  return mods.fetching
}

async function doFetchModules($) {
  mods.at = await $.clock.now()
  const enabled = MODULES.filter((m) => cfg.modules.includes(m.id))
  await Promise.all(enabled.map(async (m) => {
    try {
      const j = await mcp($, 'harness_list', { compact: false, ...m.args })
      const raw = moduleItems(j)
      mods.raw.set(m.id, raw.slice(0, 2))
      mods.results.set(m.id, { items: raw.map(m.item).filter((x) => x.name), at: mods.at, error: '' })
    } catch (err) {
      mods.results.set(m.id, { items: null, at: mods.at, error: fit(String(err?.message ?? err).replace(/^Harness sign-in needed.*?\[/, '[').replace(/^\[|\]$/g, ''), 120) })
    }
  }))
  await findChangeFlags($)
}

// Feature flags named in the lines your branch adds (vs its upstream), matched against FME's flags
async function findChangeFlags($) {
  const flags = mods.results.get('flags')?.items
  if (!flags?.length || !data.git?.head || changeFlags.head === data.git.head) return
  let diff = ''
  for (const range of ['@{upstream}...HEAD', 'origin/HEAD...HEAD', 'HEAD~1..HEAD']) {
    try {
      const r = await $.process.run(['git', 'diff', '--unified=0', range], { timeoutMs: 8000 })
      if (r.exitCode === 0) { diff = r.stdout; break }
    } catch {
      return // CLI-only
    }
  }
  changeFlags = { head: data.git.head, names: flagsInDiff(diff, flags.map((f) => f.name)) }
}

// Security issues on targets that look like this repo or its services
function repoSecurity() {
  const items = mods.results.get('security')?.items ?? []
  const names = new Set([data.git?.name, ...data.services.filter((x) => repoServiceIds().has(x.identifier)).flatMap((x) => [x.identifier, x.name])].filter(Boolean).map((x) => repoKey(x)))
  const mine = items.filter((i) => i.target && names.has(repoKey(i.target)))
  return { critical: mine.filter((i) => i.kind === 'fail').length, high: mine.filter((i) => i.kind === 'warn').length, targets: [...new Set(mine.map((i) => i.target))] }
}
const securityNote = () => { const sec = repoSecurity(); return sec.critical ? ` ⚠ ${sec.critical} critical security issue${sec.critical === 1 ? '' : 's'} open on ${sec.targets.join(', ')}.` : '' }

// ---- Deployment inventory scan ---------------------------------------------------------------

function scanInventory($) {
  if (!inv.scanning) inv.scanning = doScanInventory($).finally(() => { inv.scanning = null; $.ui.invalidate('ui.render') })
  return inv.scanning
}

async function doScanInventory($) {
  const now = await $.clock.now()
  const cutoff = now - cfg.inventory_days * 86400_000
  let fetched = 0
  try {
    for (let page = 0; fetched < cfg.inventory_max_runs; page++) {
      const batch = cfg.auth === 'mcp'
        ? mcpItems(await mcp($, 'harness_list', { resource_type: 'execution', filters: { module: 'CD' }, page, size: 100, compact: false }))
        : (await harness($, 'POST', '/pipeline/api/pipelines/execution/summary', { module: 'CD', page: String(page), size: '100' }, { filterType: 'PipelineExecution' }))?.content ?? []
      if (!batch.length) break
      mergeRuns(inv.store, batch)
      fetched += batch.length
      if (batch.length < 100 || Math.min(...batch.map((x) => x.startTs || now)) < cutoff) break
    }
    for (const [id, x] of inv.store) if ((x.startTs || 0) < cutoff) inv.store.delete(id)
    inv.runs = fetched
    inv.scannedAt = now
    inv.error = ''
  } catch (err) {
    inv.error = fit(String(err?.message ?? err), 140)
  }
}

// Services related to this repo: manifests in it, or deployed by runs that built it
function repoServices() {
  const key = data.git?.name || ''
  const out = servicesInRepo(data.services, key, connectors) // same matching as the pane, connectors included
  for (const x of inv.store.values()) if (key && execRepoKeys(x).has(key)) for (const t of cdTargets(x)) out.add(t.service)
  return out
}

function currentInventory() {
  const all = buildInventory([...inv.store.values()], data.services, data.environments)
  if (scope !== 'mine') return { ...all, scopeLabel: 'whole project' }
  const mine = repoServices()
  return mine.size ? { ...all, rows: all.rows.filter((r) => mine.has(r.id)), scopeLabel: 'this repo' } : { ...all, scopeLabel: 'whole project (no services found for this repo)' }
}

async function openInventory($) {
  inv.usedAt = await $.clock.now()
  if (view.mode !== 'inventory') scope = 'all' // the inventory is project-wide; 1 narrows it to this repo
  view.mode = 'inventory'
  if (!inv.scannedAt && !inv.scanning) scanInventory($)
  $.ui.invalidate('ui.render')
}

// ---- Runtime inputs: reuse what the run used; otherwise ask for each (null = cancelled) ----

async function runInputs($, x) {
  let yaml = ''
  try {
    const j = cfg.auth === 'mcp'
      ? await mcp($, 'harness_get', { resource_type: 'execution_inputs', resource_id: x.planExecutionId })
      : await harness($, 'GET', `/pipeline/api/pipelines/execution/${encodeURIComponent(x.planExecutionId)}/inputsetV2`, {})
    yaml = String(j?.inputSetYaml ?? j?.data?.inputSetYaml ?? '').trim()
  } catch { yaml = '' }
  if (yaml) return { yaml, from: 'original' }
  let tpl = ''
  try {
    const j = cfg.auth === 'mcp'
      ? await mcp($, 'harness_get', { resource_type: 'runtime_input_template', resource_id: x.pipelineIdentifier })
      : await harness($, 'POST', '/pipeline/api/inputSets/template', { pipelineIdentifier: x.pipelineIdentifier }, {})
    tpl = String(j?.inputSetTemplateYaml ?? j?.data?.inputSetTemplateYaml ?? '')
  } catch { tpl = '' }
  const inputs = parseTemplateInputs(tpl)
  if (!inputs.length) return { yaml: '', from: 'none' }
  if (inputs.length > 6) return { yaml: '', from: 'too many', count: inputs.length }
  const values = []
  for (const i of inputs) {
    const opts = i.allowed.length ? i.allowed.slice(0, 3) : i.default ? [i.default] : ['Leave empty']
    const v = await $.ui.ask(`Runtime input "${i.label}"${i.where ? ` (${i.where})` : ''}?`, [...opts, 'Cancel'])
    if (v === 'Cancel') return null
    values.push(v === 'Leave empty' ? '' : v)
  }
  return { yaml: fillTemplate(tpl, inputs, values), from: 'asked' }
}

// ---- Approvals ----------------------------------------------------------------------

async function fetchApprovalsFor($, x) {
  const id = x.planExecutionId
  if (cfg.auth === 'mcp') {
    try {
      const list = parseApprovals(mcpItems(await mcp($, 'harness_list', { resource_type: 'approval_instance', filters: { execution_id: id, approval_status: 'WAITING' }, compact: false })))
      approvals.set(id, list)
      return list
    } catch {
      approvals.set(id, [])
      return []
    }
  }
  try {
    const res = await $.http.fetch(
      `${cfg.base_url}/pipeline/api/v1/orgs/${encodeURIComponent(cfg.org_id)}/projects/${encodeURIComponent(cfg.project_id)}/approvals/execution/${encodeURIComponent(id)}` +
        `?approval_status=WAITING&accountIdentifier=${encodeURIComponent(cfg.account_id)}`,
      { headers: { 'x-api-key': cfg.api_key, 'Harness-Account': cfg.account_id, Accept: 'application/json' } },
    )
    const list = res.ok ? parseApprovals(JSON.parse(res.text)) : []
    approvals.set(id, list)
    return list
  } catch {
    approvals.set(id, [])
    return []
  }
}

// Waiting approvals across the project (not just this repo): an approval may be yours to give anywhere
async function fetchApprovals($) {
  const waiting = data.executions.filter(isApprovalWaiting).slice(0, 5)
  const keep = new Set(waiting.map((x) => x.planExecutionId))
  for (const id of [...approvals.keys()]) if (!keep.has(id)) approvals.delete(id)
  await Promise.all(waiting.map((x) => fetchApprovalsFor($, x)))
}

const waitingList = () => data.executions.flatMap((x) => (approvals.get(x.planExecutionId) ?? []).map((a) => ({ x, a })))

async function decideApproval($, x, a, action) {
  const name = runName(x)
  if (!cfg.allow_actions) {
    $.ui.toast('Actions are off. Turn on "allow_actions" in /plugin configure harness-platform@harness-tools.', { timeoutMs: 8000 })
    return
  }
  if (a.type !== 'HarnessApproval') {
    $.ui.toast(`${name} is waiting on a ${approvalWhere(a.type)} approval: decide it there.`, { timeoutMs: 8000 })
    return
  }
  const verb = action === 'APPROVE' ? 'Approve' : 'Reject'
  const prod = [...new Set(cdTargets(x).filter((t) => t.envType === 'Production').map((t) => t.envName))]
  if (action === 'APPROVE' && prod.length && freeze?.frozen) {
    $.ui.toast(`${freezeText(freeze)}: not approving ${name} to deploy to production. Harness blocks it unless you can override the freeze.`, { timeoutMs: 10000 })
    return
  }
  const inputs = []
  try {
    const msg = fit(a.message.replace(/\s+/g, ' ').replace(/[?.!\s]+$/, ''), 100) // the question adds its own "?"
    if ((await $.ui.ask(`${verb} ${name}${msg ? `: "${msg}"` : ''}?`, [verb, 'Cancel'])) !== verb) return
    if (action === 'APPROVE') {
      for (const i of a.inputs.slice(0, 5)) {
        // Pick the default, or type a value under "Other"
        const v = await $.ui.ask(`Value for "${i.name}"?`, i.default ? [i.default, 'Cancel'] : ['Leave empty', 'Cancel'])
        if (v === 'Cancel') return
        inputs.push({ name: i.name, value: v === 'Leave empty' ? '' : v })
      }
      if (prod.length && (await $.ui.ask(`This lets ${name} deploy to production (${prod.join(', ')}).${securityNote()} Approve it?`, ['Yes, approve for production', 'Cancel'])) !== 'Yes, approve for production') return
    }
  } catch {
    return // dismissed, or nobody to ask
  }
  try {
    if (cfg.auth === 'mcp') {
      const b = approvalBody(action, inputs)
      await mcp($, 'harness_execute', { resource_type: 'approval_instance', action: action === 'APPROVE' ? 'approve' : 'reject', params: { approval_id: a.id }, body: { comments: b.comments, ...(inputs.length ? { approver_inputs: inputs } : {}) }, confirm: true })
    } else {
      await harness($, 'POST', `/pipeline/api/approvals/${encodeURIComponent(a.id)}/harness/activity`, {}, approvalBody(action, inputs))
    }
    $.ui.toast(`✓ ${action === 'APPROVE' ? 'Approved' : 'Rejected'} ${name}`, { timeoutMs: 6000 })
    approvals.set(x.planExecutionId, (approvals.get(x.planExecutionId) ?? []).filter((y) => y.id !== a.id))
    burstUntil = (await $.clock.now()) + BURST_MS
    $.clock.after(3000, () => { refresh($) })
  } catch (err) {
    $.ui.toast(`✗ Couldn't ${verb.toLowerCase()} ${name}: ${fit(String(err?.message ?? err), 140)}`, { timeoutMs: 10000 })
  }
  $.ui.invalidate('ui.render')
}

// From the actions menu: the run's waiting approval (asks which, if several)
async function approveFromMenu($, x, action) {
  let list = approvals.get(x.planExecutionId)
  if (!list) list = await fetchApprovalsFor($, x)
  if (!list.length) { $.ui.toast(`No approval is waiting on ${runName(x)} right now.`); return }
  let a = list[0]
  if (list.length > 1) {
    const labels = list.slice(0, 3).map((y, i) => `${i + 1}. ${fit(y.message || approvalWhere(y.type) + ' approval', 50)}`)
    let pick = ''
    try { pick = await $.ui.ask(`Which approval of ${runName(x)}?`, [...labels, 'Cancel']) } catch { return }
    const i = labels.indexOf(pick)
    if (i === -1) return
    a = list[i]
  }
  await decideApproval($, x, a, action)
}

// How far each deployed commit is behind HEAD (for lanes); returns prod's
async function countBehind($) {
  behindByCommit = new Map()
  if (!data.git?.head) return null
  const commits = [...new Set(envCommits(data.executions, data.git.name).values())].slice(0, 8)
  for (const c of commits) {
    if (c === data.git.head) { behindByCommit.set(c, 0); continue }
    try {
      const r = await $.process.run(['git', 'rev-list', '--count', c + '..HEAD'], { timeoutMs: 5000 })
      if (r.exitCode === 0) behindByCommit.set(c, Number(r.stdout.trim()))
    } catch {
      break // CLI-only: no git on this surface
    }
  }
  const pc = prodCommit(data.executions, data.git.name)
  return pc ? behindByCommit.get(pc.commit) ?? null : null
}

function openPane($, focus) {
  // `focus` only takes true; pass it only when wanted
  return $.ui.open({ id: PANE, title: 'Harness', closeOnEscape: true, ...(focus ? { focus: true } : {}), ...(layout === 'dock' ? { columns: 72 } : {}) })
}

async function setLayout($, next) {
  const wasDock = layout === 'dock'
  layout = next
  try { await $.store.set('layout', layout) } catch { /* not persisted */ }
  if (wasDock !== (layout === 'dock')) {
    // A docked pane needs reopening at its new width
    await $.ui.close({ id: PANE })
    await openPane($, true)
  }
  $.ui.invalidate('ui.render')
}

async function setStartView($, v) {
  cfg.start_view = v
  try { await $.store.set('start_view', v) } catch { /* not persisted */ }
  $.ui.toast(`Harness will open on ${START_LABEL[v]}${v === 'home' ? '' : ' (o for Home)'}.`, { timeoutMs: 6000 })
  $.ui.invalidate('ui.render')
}

async function setAutoFix($, on) {
  cfg.on_failure = on ? 'auto' : 'ask'
  try { await $.store.set('on_failure', cfg.on_failure) } catch { /* not persisted */ }
  $.ui.toast(on ? `Auto-fix is on: Claude fixes and pushes up to ${cfg.auto_fix_attempts} times. /harness autofix off to stop.` : 'Auto-fix is off: you\'ll be asked each time.', { timeoutMs: 8000 })
  $.ui.invalidate('ui.render')
}

// ---- Failure diagnosis --------------------------------------------------------

async function fetchLogTail($, steps) {
  const step = steps.find((x) => x.logKey)
  if (!step) return ''
  try {
    const acct = encodeURIComponent(cfg.account_id)
    const tok = await $.http.fetch(`${cfg.base_url}/gateway/log-service/token?accountID=${acct}`, { headers: { 'x-api-key': cfg.api_key } })
    if (!tok.ok) return ''
    const blob = await $.http.fetch(`${cfg.base_url}/gateway/log-service/blob?accountID=${acct}&key=${encodeURIComponent(step.logKey)}`, { headers: { 'X-Harness-Token': tok.text.trim() } })
    return blob.ok ? logTail(blob.text) : ''
  } catch {
    return ''
  }
}

async function doDiagnose($, x) {
  try {
    let graph = null
    let tail = ''
    if (cfg.auth === 'mcp') {
      try { tail = fit(JSON.stringify(await mcp($, 'harness_diagnose', { resource_type: 'pipeline', options: { execution_id: x.planExecutionId, include_logs: true, log_snippet_lines: 60, summary: true } })), 6000) } catch { tail = '' }
    } else {
      try { graph = await harness($, 'GET', '/pipeline/api/pipelines/execution/v2/' + encodeURIComponent(x.planExecutionId), { renderFullBottomGraph: 'true' }) } catch { graph = null }
    }
    const steps = failedSteps(x, graph)
    if (cfg.auth !== 'mcp') tail = await fetchLogTail($, steps)
    const r = await $.model.complete({ model: 'haiku', system: DIAGNOSIS_SYSTEM, prompt: diagnosisPrompt(x, steps, tail, data.git), maxTokens: 400, timeoutMs: 25000 })
    const d = r.isAnswered ? parseDiagnosis(r.text) : null
    const out = d ? { state: 'done', ...d, fromLogs: Boolean(tail) } : { state: 'error', error: r.reason || 'the model gave no answer' }
    diagnoses.set(x.planExecutionId, out)
    return out
  } catch (err) {
    const out = { state: 'error', error: String(err?.message ?? err) }
    diagnoses.set(x.planExecutionId, out)
    return out
  } finally {
    $.ui.invalidate('ui.render')
  }
}

// One diagnosis per run; callers that arrive while it's running share it
function diagnose($, x) {
  const done = diagnoses.get(x.planExecutionId)
  if (done?.state === 'done') return Promise.resolve(done)
  if (!diagRuns.has(x.planExecutionId)) {
    diagRuns.set(x.planExecutionId, doDiagnose($, x).finally(() => { diagRuns.delete(x.planExecutionId) }))
    $.ui.invalidate('ui.render')
  }
  return diagRuns.get(x.planExecutionId)
}

const doneDiag = (id) => (diagnoses.get(id)?.state === 'done' ? diagnoses.get(id) : null)

// Your HEAD commit just failed: notify, ask, or auto-fix (setting: on_failure)
function manifestHint(x, manifestChange) {
  if (!manifestChange) return ''
  const ids = repoServiceIds()
  const paths = data.services.filter((y) => ids.has(y.identifier) && cdTargets(x).some((t) => t.service === y.identifier)).flatMap((y) => repoManifestPaths(y, data.git?.name, connectors))
  return `\nThis repo holds the deployment manifests (no build in Harness)${paths.length ? `: ${[...new Set(paths)].join(', ')}` : ''}. Look at what changed there since the last successful deploy.`
}

async function onYourFailure($, x, manifestChange = false) {
  const key = x.pipelineIdentifier + '@' + (data.git?.branch ?? '')
  view.selected = x.planExecutionId
  view.expanded.add(x.planExecutionId)
  view.collapsed.delete(x.planExecutionId)
  if (layout === 'strip') await openPane($, false) // strip-first: the pane appears when it matters
  const diag = cfg.diagnose !== 'off' ? await diagnose($, x) : null
  const d = diag?.state === 'done' ? diag : null
  if (cfg.on_failure === 'notify') return
  if (cfg.on_failure === 'auto') {
    const n = (fixAttempts.get(key) ?? 0) + 1
    if (n > cfg.auto_fix_attempts) {
      $.ui.toast(`Auto-fix stopped after ${cfg.auto_fix_attempts} attempts on ${x.name ?? x.pipelineIdentifier}. Over to you.`, { timeoutMs: 10000 })
      return
    }
    fixAttempts.set(key, n)
    $.prompt.submit({ text: autoFixPrompt(x, d, n, cfg.auto_fix_attempts, execUrl(cfg, x)) + manifestHint(x, manifestChange) })
    return
  }
  let answer = ''
  try {
    const t = cdTargets(x).find((y) => repoServiceIds().has(y.service)) ?? cdTargets(x)[0]
    const what = manifestChange && t ? `failed deploying ${t.serviceName} to ${t.envName} after your latest manifest change` : 'failed on your commit'
    answer = await $.ui.ask(`${x.name ?? x.pipelineIdentifier} #${x.runSequence} ${what}: ${fit(d?.cause || failureMessage(x) || x.status, 150)}. What now?`, ['Let Claude fix it', 'Always auto-fix', 'Show the failure', 'Ignore'])
  } catch {
    return // dismissed, or nobody to ask
  }
  if (answer === 'Always auto-fix') {
    await setAutoFix($, true)
    fixAttempts.set(key, 1)
    $.prompt.submit({ text: autoFixPrompt(x, d, 1, cfg.auto_fix_attempts, execUrl(cfg, x)) + manifestHint(x, manifestChange) })
  } else if (answer === 'Let Claude fix it') {
    $.prompt.submit({ asUser: true, text: autoFixPrompt(x, d, 1, 1, execUrl(cfg, x)).replace('Auto-fix attempt 1 of 1: f', 'F') + manifestHint(x, manifestChange) })
  } else if (answer === 'Show the failure') {
    await openPane($, true)
  }
}

// Status line + toasts for runs in your scope that just finished or appeared failed
function notify($) {
  const v = buildView(data, 'mine')
  const parts = []
  if (v.branch) {
    const h = v.branch.headRun
    if (!h && !v.branch.latest && isCdOnly()) {
      // CD-only: no builds to report; say what isn't deployed yet instead
      const pend = [...pendingChanges].filter(([, n]) => n > 0).map(([k, n]) => `${k.split('\u0000')[1]} ${n} pending`)
      parts.push(`${v.branch.name}@${short(v.branch.head)} CD-only${pend.length ? ' · ' + pend.join(', ') : ' · manifests deployed'}`)
    } else {
      parts.push(`${v.branch.name}@${short(v.branch.head)} ${h ? ICON[statusKind(h.status)] + ' ' + h.status : 'not built'}`)
    }
  }
  if (v.counts.running) parts.push(`${v.counts.running} running`)
  // Runs waiting on an approval are counted once, as approvals (below)
  const otherWaiting = v.executions.filter((x) => statusKind(x.status) === 'wait' && !isApprovalWaiting(x)).length
  if (otherWaiting) parts.push(`${otherWaiting} waiting`)
  if (v.counts.failed) parts.push(`${v.counts.failed} failed`)
  if (pr) { const c = summarizeChecks(pr.checks); parts.push(`PR #${pr.number} ${c.fail ? `✗ ${c.fail} failing` : c.run ? '● checks' : '✓'}`) }
  if (freeze?.frozen) parts.unshift(freezeText(freeze))
  const waiting = waitingList()
  if (waiting.length) parts.push(`${waiting.length} approval${waiting.length === 1 ? '' : 's'} waiting`)
  const ids = new Set(waiting.map((w) => w.a.id))
  if (seenApprovals) {
    for (const { x, a } of waiting) {
      if (seenApprovals.has(a.id)) continue
      const to = cdTargets(x).map((t) => t.envName).filter(Boolean)
      $.ui.toast(`◆ ${x.name ?? x.pipelineIdentifier} #${x.runSequence} is waiting for approval${to.length ? ' to deploy to ' + [...new Set(to)].join(', ') : ''}`, { timeoutMs: 10000 })
    }
  }
  seenApprovals = ids
  $.ui.status('harness: ' + (parts.join(' · ') || 'all clear') + (v.scopeFellBack ? (v.mineBasis === 'me' ? ' (your runs)' : ' (project)') : ''))

  const prodRunning = data.executions.filter((x) => statusKind(x.status) === 'run' && cdTargets(x).some((t) => t.envType === 'Production'))
  if (seenProdRuns) for (const x of prodRunning) if (!seenProdRuns.has(x.planExecutionId)) $.ui.toast(`● Production deploy started: ${runName(x)} → ${[...new Set(cdTargets(x).filter((t) => t.envType === 'Production').map((t) => t.serviceName))].join(', ')} (o to watch)`, { timeoutMs: 10000 })
  seenProdRuns = new Set(prodRunning.map((x) => x.planExecutionId))
  const kinds = new Map(v.executions.map((x) => [x.planExecutionId, statusKind(x.status)]))
  if (prevKinds) {
    for (const x of v.executions) {
      const before = prevKinds.get(x.planExecutionId)
      const now = kinds.get(x.planExecutionId)
      const finished = before && !isTerminal(before) && isTerminal(now)
      const newFailure = !before && now === 'fail'
      const nowWaiting = before !== 'wait' && now === 'wait' && !isApprovalWaiting(x) // approvals get their own toast
      if (finished || newFailure || nowWaiting) {
        $.ui.toast(`${ICON[now]} ${x.name ?? x.pipelineIdentifier} #${x.runSequence ?? ''} ${x.status}`, { timeoutMs: 8000 })
      }
      if ((finished || newFailure) && now === 'fail') {
        const yours = data.git?.head && execCi(x)?.commit === data.git.head
        // CD-only: a deploy of this repo's services that started after your latest commit carries your manifest change
        const yourDeploy = !yours && isCdOnly() && deploysRepoService(x) && data.git?.headTime && (x.startTs || 0) >= data.git.headTime
        if (yours) $.clock.after(0, () => { onYourFailure($, x) })
        else if (yourDeploy) $.clock.after(0, () => { onYourFailure($, x, true) })
        else if (cfg.diagnose === 'auto') $.clock.after(0, () => { diagnose($, x) })
      }
      if (finished && now === 'ok') fixAttempts.delete(x.pipelineIdentifier + '@' + (data.git?.branch ?? ''))
    }
  }
  prevKinds = kinds
}

// ---- Hooks --------------------------------------------------------------------

export function register(on, options) {
  const key = String(options.api_key || '')
  cfg = {
    base_url: String(options.base_url || 'https://app.harness.io').replace(/\/+$/, ''),
    api_key: key,
    account_id: String(options.account_id || accountFromKey(key)),
    org_id: String(options.org_id || 'default'),
    project_id: String(options.project_id || ''),
    repo_name: String(options.repo_name || ''),
    poll_ms: Math.max(15, Number(options.poll_seconds) || 60) * 1000,
    max_runs: Math.min(100, Math.max(10, Number(options.max_runs) || 50)),
    auto_open: options.auto_open !== false,
    skip_user_lookup: options.skip_user_lookup === true,
    on_failure: pick(options.on_failure, ['notify', 'ask', 'auto'], 'ask'),
    auto_fix_attempts: Math.min(5, Math.max(1, Number(options.auto_fix_attempts) || 2)),
    push_guard: pick(options.push_guard, ['hold', 'warn', 'off'], 'hold'),
    prod_guard: options.prod_guard !== false,
    diagnose: pick(options.diagnose, ['auto', 'on_demand', 'off'], 'auto'),
    add_context: options.add_context !== false,
    layout: pick(options.layout, LAYOUTS, 'stacked'),
    start_view: pick(options.start_view, START_VIEWS, 'home'),
    mcp_server: String(options.mcp_server || ''),
    modules: (Array.isArray(options.modules) && options.modules.length ? options.modules : MODULES.map((m) => m.id)).map(String),
    module_attention: options.module_attention !== false,
    modules_poll_ms: Math.max(1, Number(options.modules_poll_minutes) || 5) * 60_000,
    inventory_days: Math.min(365, Math.max(7, Number(options.inventory_days) || 90)),
    inventory_max_runs: Math.min(2000, Math.max(100, Number(options.inventory_max_runs) || 500)),
    band: options.band !== false,
    allow_actions: options.allow_actions === true,
    org_explicit: Boolean(options.org_id) && options.org_id !== 'default',
    url_explicit: Boolean(options.base_url) && options.base_url !== 'https://app.harness.io',
  }

  on('session.start', async ($, e, next) => {
    // Fall back to the same env vars the Harness MCP server reads
    if (!cfg.api_key) cfg.api_key = String((await $.env.get('HARNESS_API_KEY')) ?? '')
    if (!cfg.account_id) cfg.account_id = String((await $.env.get('HARNESS_ACCOUNT_ID')) ?? '') || accountFromKey(cfg.api_key)
    if (!cfg.project_id) cfg.project_id = String((await $.env.get('HARNESS_DEFAULT_PROJECT_ID')) ?? '')
    if (!cfg.org_explicit) cfg.org_id = String((await $.env.get('HARNESS_DEFAULT_ORG_ID')) ?? '') || cfg.org_id
    if (!cfg.url_explicit) {
      const envUrl = String((await $.env.get('HARNESS_BASE_URL')) ?? '')
      if (envUrl) cfg.base_url = envUrl.replace(/\/+$/, '')
    }
    // First load, unless a command or tool call already started one
    // No API key: sign in with Harness through the bundled MCP server instead
    cfg.auth = cfg.api_key ? 'key' : 'mcp'
    // Modules use the bundled server that matches how you connect: local with your key, hosted when signed in
    if (!cfg.mcp_server) cfg.mcp_server = cfg.auth === 'key' ? 'plugin:harness-platform:harness-local' : 'plugin:harness-platform:harness'
    // Preferences saved from the pane (layout, auto-fix) win over the settings defaults…
    layout = cfg.layout
    try {
      const savedLayout = await $.store.get('layout')
      if (LAYOUTS.includes(savedLayout)) layout = savedLayout
      const savedOnFailure = await $.store.get('on_failure')
      if (['notify', 'ask', 'auto'].includes(savedOnFailure)) cfg.on_failure = savedOnFailure
    } catch { /* no saved preferences */ }
    // …and per-shell env overrides win over both
    if (String((await $.env.get('HARNESS_CICD_ALLOW_ACTIONS')) ?? '') === '1') cfg.allow_actions = true
    try {
      const savedStart = await $.store.get('start_view')
      if (START_VIEWS.includes(savedStart)) cfg.start_view = savedStart
    } catch { /* no saved choice */ }
    cfg.start_view = pick(String((await $.env.get('HARNESS_PLATFORM_START')) ?? ''), START_VIEWS, cfg.start_view)
    view.mode = modeFor(cfg.start_view)
    if (view.mode === 'inventory') { scope = 'all'; $.clock.after(1500, () => { openInventory($) }) } // project-wide; the scan needs the first refresh
    const envLayout = String((await $.env.get('HARNESS_CICD_LAYOUT')) ?? '')
    if (LAYOUTS.includes(envLayout)) layout = envLayout
    cfg.on_failure = pick(String((await $.env.get('HARNESS_CICD_ON_FAILURE')) ?? ''), ['notify', 'ask', 'auto'], cfg.on_failure)
    cfg.push_guard = pick(String((await $.env.get('HARNESS_CICD_PUSH_GUARD')) ?? ''), ['hold', 'warn', 'off'], cfg.push_guard)
    cfg.diagnose = pick(String((await $.env.get('HARNESS_CICD_DIAGNOSE')) ?? ''), ['auto', 'on_demand', 'off'], cfg.diagnose)
    $.clock.after(500, () => { if (!lastAttempt && !pending) refresh($) })
    $.clock.every(5000, async () => {
      if (error === 'not configured') return // options only change on reload
      const now = await $.clock.now()
      const wait = failures
        ? Math.min(MAX_BACKOFF_MS, cfg.poll_ms * 2 ** (failures - 1)) // back off on errors, even mid-push
        : now < burstUntil ? BURST_EVERY_MS : cfg.poll_ms
      if (now - lastAttempt >= wait) await refresh($)
    })
    await $.tool.register({
      name: 'harness_status',
      description:
        'Live Harness CI/CD state for the configured project, scoped to the git repo and branch of this session: ' +
        'whether HEAD has been built, recent pipeline runs (status, branch, commit, failure reason, link), ' +
        'what version of each service is deployed to each environment, and the environments. ' +
        'Call it before or after pushing, deploying, or when the user asks about builds, pipelines or deployments.',
      inputSchema: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['mine', 'all'], description: '"mine" (default): this repo/branch; "all": whole project' },
          diagnose: { type: 'string', description: 'Optional planExecutionId of a failed run to diagnose from its failed steps and log tail' },
          view: { type: 'string', enum: ['status', 'inventory', 'modules'], description: '"inventory": the live version of every service in every environment and infrastructure, with drift and in-flight deploys. "modules": GitOps apps, security issues, feature flags, alerts, incidents, releases, IaCM workspaces, cost anomalies, catalog, chaos and more' },
        },
      },
    })
    await $.command.register({ name: 'harness', description: 'Harness pipelines, deployments & environments', argumentHint: '[start|platform|inventory|doctor|capture|all|mine|refresh|diagnose|layout|autofix]', immediate: true })
    if (cfg.auto_open && layout !== 'strip') await openPane($, false)
    return next(e)
  })

  on('command.run', { command: 'harness' }, async ($, e) => {
    const raw = String(e.args || '').trim()
    const arg = raw.toLowerCase()
    if (arg === 'all' || arg === 'mine') scope = arg
    if (!arg) {
      view.mode = modeFor(cfg.start_view)
      view.modFilter = null
      if (view.mode === 'inventory') { scope = 'all'; await openInventory($) }
      $.ui.invalidate('ui.render')
    }
    if (arg === 'start' || arg.startsWith('start ')) {
      const want = arg.split(/\s+/)[1]
      const alias = { change: 'runs', deployments: 'inventory', modules: 'platform' }[want] ?? want
      if (!START_VIEWS.includes(alias)) return { text: `Starting screen: ${START_LABEL[cfg.start_view]}. Choose one with /harness start <${START_VIEWS.join('|')}>, or press s in any view.` }
      await setStartView($, alias)
      return { text: `Harness will open on ${START_LABEL[alias]}.` }
    }
    if (arg === 'doctor') return { text: await doctor($) }
    if (arg === 'modules' || arg === 'platform') {
      if (!lastAttempt || pending) await refresh($)
      mods.usedAt = await $.clock.now()
      await fetchModules($)
      view.mode = 'modules'
      const surfaces = await $.session.surfaces()
      if (!surfaces.some((x) => x === 'terminal' || x === 'desktop')) return { text: modulesText() }
      await openPane($, true)
      return {}
    }
    if (arg === 'doctor --capture' || arg === 'capture') return { text: await capture($) }
    if (arg === 'inventory' || arg === 'deployments') {
      if (!lastAttempt || pending) await refresh($)
      if (scope === 'mine' && !arg.includes('mine')) scope = 'all' // the inventory is project-wide unless you narrow it
      await openInventory($)
      const surfaces = await $.session.surfaces()
      if (!surfaces.some((x) => x === 'terminal' || x === 'desktop')) {
        await scanInventory($)
        return { text: error ? 'Harness: ' + error : inventoryText(currentInventory(), await $.clock.now(), currentInventory().scopeLabel) + `\n(live = last successful deploy per service/environment/infrastructure, from ${inv.runs} CD runs over ${cfg.inventory_days} days)` }
      }
      await openPane($, true)
      return {}
    }
    if (arg === 'autofix on' || arg === 'autofix off') {
      await setAutoFix($, arg === 'autofix on')
      return { text: `Auto-fix ${arg === 'autofix on' ? 'on' : 'off'}.` }
    }
    if (arg.startsWith('layout')) {
      const next = arg.split(/\s+/)[1]
      if (!LAYOUTS.includes(next)) return { text: `Layouts: ${LAYOUTS.join(', ')} (now: ${layout}). Use /harness layout <name>, or press v in the pane.` }
      await setLayout($, next)
      return { text: `Layout: ${next}.` }
    }
    if (arg === 'diagnose' || arg.startsWith('diagnose ')) {
      if (!lastAttempt || pending) await refresh($)
      if (error) return { text: 'Harness: ' + (error === 'not configured' ? 'not configured — set the API key and project ID in /config' : error) }
      const id = raw.split(/\s+/)[1]
      const x = id ? data.executions.find((r) => r.planExecutionId === id) : buildView(data, scope).executions.find((r) => statusKind(r.status) === 'fail')
      if (!x) return { text: id ? `No recent run with id ${id}.` : 'No failed runs to diagnose.' }
      const d = await diagnose($, x)
      return { text: d.state === 'done'
        ? `${x.name ?? x.pipelineIdentifier} #${x.runSequence} ${x.status}\nCause: ${d.cause}${d.evidence ? `\nEvidence: ${d.evidence}` : ''}${d.fix ? `\nLikely fix: ${d.fix}` : ''}\n(${d.confidence} confidence${d.fromLogs ? ', from the step log' : ', from failure messages only'}) ${execUrl(cfg, x)}`
        : `Couldn't diagnose ${x.name ?? x.pipelineIdentifier} #${x.runSequence}: ${d.error}` }
    }
    // Refresh on request or first use; otherwise join a refresh already running
    if (arg === 'refresh' || !lastAttempt || pending) await refresh($)
    // Only the terminal and the Desktop app draw panes; elsewhere answer in text
    const surfaces = await $.session.surfaces()
    if (!surfaces.some((s) => s === 'terminal' || s === 'desktop')) {
      if (error) return { text: 'Harness: ' + (error === 'not configured' ? 'not configured — set the API key and project ID in /config, or HARNESS_API_KEY and HARNESS_DEFAULT_PROJECT_ID' : error) }
      return { text: textReport(buildView(data, scope), cfg, await $.clock.now(), { diagnoses, behind }) }
    }
    await openPane($, true)
    return {}
  })

  // Claude's tool
  on('tool.call', { tool: TOOL }, async ($, e) => {
    if (!lastAttempt || pending) await refresh($)
    if (error) return { result: 'Harness status unavailable: ' + error }
    if (e.view === 'modules') {
      mods.usedAt = await $.clock.now()
      if (!mods.at || mods.fetching) await fetchModules($)
      return { result: JSON.stringify({
        project: `${cfg.org_id}/${cfg.project_id}`,
        attention: attentionLine(mods.results).map((a) => a.text),
        modules: MODULES.filter((m) => cfg.modules.includes(m.id)).map((m) => {
          const r = mods.results.get(m.id)
          return r?.items ? { module: m.title, summary: moduleSummary(m, r.items).text, items: r.items.slice(0, 20).map((x) => ({ name: x.name, status: x.kind, detail: x.detail || undefined })) } : { module: m.title, unavailable: r?.error || 'not loaded' }
        }),
        flags_in_your_change: changeFlags.names.length ? changeFlags.names : undefined,
      }) }
    }
    if (e.view === 'inventory') {
      inv.usedAt = await $.clock.now()
      if (!inv.scannedAt || inv.scanning) await scanInventory($)
      const prev = scope
      scope = e.scope === 'mine' ? 'mine' : 'all'
      const iv = currentInventory()
      scope = prev
      return { result: JSON.stringify({
        project: `${cfg.org_id}/${cfg.project_id}`, scope: iv.scopeLabel, basis: `last successful deploy per service/environment/infrastructure, from ${inv.runs} CD runs over ${cfg.inventory_days} days`,
        environments: iv.envs.map((x) => ({ id: x.id, name: x.name, type: x.type })),
        services: iv.rows.map((r) => ({
          service: r.name, deployed: r.deployed, drift: r.drift.map((d) => `${d.to} differs from ${d.from}`),
          environments: Object.fromEntries(Object.entries(r.cells).filter(([, c]) => c).map(([env, c]) => [env, {
            live: c.live ? { version: c.live.artifact || null, deployed_at: new Date(c.live.at).toISOString(), by: c.live.by || undefined, run: `${c.live.pipeline} #${c.live.run}` } : null,
            infrastructures: c.infras.length > 1 ? c.infras.map((i) => ({ infra: i.infra, version: i.live?.artifact ?? null })) : undefined,
            newer_attempt: c.attempt ? { version: c.attempt.artifact || null, status: c.attempt.status, at: new Date(c.attempt.at).toISOString() } : undefined,
            manifest_changes_not_deployed: pendingChanges.get(r.id + '\u0000' + env),
          }])),
        })),
      }) }
    }
    if (e.diagnose) {
      const x = data.executions.find((r) => r.planExecutionId === e.diagnose)
      if (!x) return { result: `No recent run with id ${e.diagnose} in ${cfg.org_id}/${cfg.project_id}.` }
      if (cfg.diagnose === 'off') return { result: 'Diagnosis is turned off (diagnose setting).' }
      return { result: JSON.stringify({ run: e.diagnose, failure: failureMessage(x), diagnosis: await diagnose($, x), url: execUrl(cfg, x) }) }
    }
    const v = buildView(data, e.scope === 'all' ? 'all' : 'mine')
    const now = await $.clock.now()
    const summary = toolSummary(v, cfg, now, { diagnoses, behind })
    summary.cd_only_repo = isCdOnly() || undefined
    summary.platform_attention = attentionLine(mods.results).map((a) => a.text)
    summary.flags_in_your_change = changeFlags.names.length ? changeFlags.names : undefined
    summary.manifest_changes_pending = pendingChanges.size ? Object.fromEntries([...pendingChanges].map(([k, n]) => [k.replace('\u0000', '→'), n])) : undefined
    summary.freeze = freeze?.frozen ? { active: freeze.active.map((f) => ({ name: f.name, until: f.until ? new Date(f.until).toISOString() : null })) } : { active: [] }
    summary.pull_request = pr ? { number: pr.number, title: pr.title, draft: pr.draft, target: pr.target, review: pr.review, checks: pr.checks.map((c) => `${c.name}: ${c.status}`), url: pr.url || undefined } : null
    summary.approvals_waiting = waitingList().map(({ x, a }) => ({
      run: runName(x), execution_id: x.planExecutionId, approval_id: a.id, type: a.type, message: a.message || undefined,
      approvers: a.approvers, minimum: a.minimumCount, inputs: a.inputs.map((i) => i.name), expires: expiresIn(a.deadline, now) || undefined,
      deploys_to: [...new Set(cdTargets(x).map((t) => t.envName))], url: execUrl(cfg, x),
    }))
    return { result: JSON.stringify(summary) }
  })

  // Watch Claude's pushes: poll fast so the pane and toasts follow the pipeline it triggers
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const pushing = isGitPush(e.command)
    if (pushing && freeze?.frozen) $.ui.toast(`Heads up: ${freezeText(freeze)}. The build will run; deployments may be blocked.`, { timeoutMs: 8000 })
    // Push guard: hold (ask first), warn (toast), off
    if (pushing && cfg.push_guard !== 'off' && updatedAt && !error) {
      const v = buildView(data, 'mine')
      let last = v.branch?.latest && statusKind(v.branch.latest.status) === 'fail' ? v.branch.latest : null
      let why = ''
      if (last) {
        const msg = failureMessage(last)
        why = `${v.branch.name} is red in Harness: ${last.name ?? last.pipelineIdentifier} #${last.runSequence} ${last.status}` + (msg ? ` (${fit(msg, 120)})` : '')
      } else if (!v.branch?.latest && isCdOnly()) {
        // CD-only: your push changes manifests; hold it while the last deploy of one of this repo's services is failing
        const red = cdRedDeploy()
        if (red) {
          last = red.x
          const msg = failureMessage(red.x)
          why = `the last deploy of ${red.t.serviceName} to ${red.t.envName} failed in Harness (${red.x.name ?? red.x.pipelineIdentifier} #${red.x.runSequence}${msg ? `: ${fit(msg, 100)}` : ''})`
        }
      }
      if (last) {
        if (cfg.push_guard === 'warn') {
          $.ui.toast('Pushing while ' + why, { timeoutMs: 8000 })
        } else {
          let answer = 'Push anyway'
          try {
            answer = await $.ui.ask(`Claude wants to push, but ${why}. Push anyway?`, ['Push anyway', "Don't push", 'Show the failure'])
          } catch {
            $.ui.log('push guard: nobody to ask, so the push goes ahead')
          }
          if (answer !== 'Push anyway') {
            if (answer === 'Show the failure') await openPane($, true)
            const d = doneDiag(last.planExecutionId)
            const said = answer && !["Don't push", 'Show the failure'].includes(answer) ? ` The user said: "${fit(answer, 200)}".` : ''
            return { deny: `The user chose not to push yet: ${why}.${d ? ` Diagnosis: ${d.cause}${d.fix ? ` Likely fix: ${d.fix}` : ''}` : ''}${said} Fix the failing build first, or ask the user how to proceed.` }
          }
        }
      }
    }
    const result = await next(e)
    if (pushing) {
      burstUntil = (await $.clock.now()) + BURST_MS
      $.ui.toast('Watching Harness for the pipeline this push triggers…')
      $.clock.after(8000, () => refresh($))
    }
    return result
  })

  // Production guardrail: Harness write actions that target production always ask a human,
  // whatever the permission mode. No one to ask (claude -p) means no.
  on('tool.call', async ($, e, next) => {
    if (!cfg.prod_guard || !isHarnessWrite(e.tool)) return next(e)
    const { tool, ...args } = e
    let targets = prodTargets(args, data.environments)
    // Approving through the Harness MCP server names only an approval id: check where that run deploys
    const apprId = args.approval_id ?? args.resource_id ?? args.params?.approval_id ?? args.body?.approval_id
    if (!targets.length && apprId) {
      const hit = waitingList().find((w) => w.a.id === String(apprId))
      if (hit) targets = [...new Set(cdTargets(hit.x).filter((t) => t.envType === 'Production').map((t) => t.envName))]
    }
    if (!targets.length) return next(e)
    if (freeze?.frozen) return { deny: `A deployment freeze is active (${freezeText(freeze).replace(/^❄ /, '')}). This Harness action targets production (${targets.join(', ')}), so it was not run. Tell the user; don't retry it.` }
    let answer = ''
    try {
      answer = await $.ui.ask(`Claude wants to run ${String(tool).replace(/^mcp__.+?__/, '')} against production (${targets.join(', ')}). Allow it?`, ['Allow', 'Cancel'])
    } catch {
      return { deny: 'This Harness action targets production and needs the user to confirm it, but nobody could be asked. Ask the user to run it, or to confirm in an interactive session.' }
    }
    if (answer !== 'Allow') return { deny: 'The user did not allow this production action' + (answer && answer !== 'Cancel' ? `: "${fit(answer, 200)}"` : '') + '.' }
    return next(e)
  })

  // Automatic context: one short line of Harness state on CI/deploy prompts
  on('prompt.submit', async ($, e, next) => {
    if (!cfg.add_context || !updatedAt || error || !wantsContext(e.text)) return next(e)
    const pend = [...pendingChanges].filter(([, n]) => n > 0).map(([k, n]) => { const [svc, env] = k.split('\u0000'); return `${data.services.find((x) => x.identifier === svc)?.name ?? svc}→${env}: ${n} manifest change${n === 1 ? '' : 's'} not deployed` })
    const line = contextLine(buildView(data, 'mine'), { behind, diagnoses, pr: [pr ? prLine(pr) : '', isCdOnly() ? 'CD-only repo (manifests here, no build in Harness)' : '', ...pend].filter(Boolean).join('; '), freeze: freeze?.frozen ? freezeText(freeze) : '' })
    return line ? next({ ...e, context: [...(e.context ?? []), line] }) : next(e)
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const el = $.ui.resolve(e)
    return renderPane($, el, e.props ?? {}, await $.clock.now())
  })

  // The band above the prompt: your commit, a sparkline of recent runs, prod lag
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!cfg.band || e.props?.hasSurvey || !updatedAt || error) return next(e)
    const el = $.ui.resolve(e)
    const own = await next(e)
    const line = renderBand($, el, e.props ?? {}, await $.clock.now())
    return line ? el.Box({ flexDirection: 'column', children: [line, own] }) : own
  })
}

// ---- Rendering --------------------------------------------------------------------
// Pure helpers that build elements from the surface's element table (`el`); the ones that
// wire presses take `$` too, which is fine for top-level functions in this file.

function mkT(Text) {
  // Text with only defined props (the renderer refuses unknown or undefined values)
  return (s, style = {}) => {
    const p = { children: [String(s)] }
    for (const [k, val] of Object.entries(style)) if (val !== undefined && val !== false) p[k] = val
    return Text(p)
  }
}

function wrapLines(text, width, max = 2) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean)
  const lines = ['']
  for (const w of words) {
    const cur = lines.at(-1)
    if (!cur) lines[lines.length - 1] = w
    else if (Array.from(cur + ' ' + w).length <= width) lines[lines.length - 1] = cur + ' ' + w
    else if (lines.length < max) lines.push(w)
    else { lines[lines.length - 1] = fit(cur + ' ' + w, width); break }
  }
  return lines.filter(Boolean)
}

const section = (T, W, title) => {
  const head = fit('── ' + title + ' ', W)
  return T(head + '─'.repeat(Math.max(0, W - Array.from(head).length)), { dimColor: true })
}
const kindText = (T, status, label) => T(ICON[statusKind(status)] + (label ? ' ' + label : ''), { color: COLOR[statusKind(status)] })
const runName = (x) => `${x.name ?? x.pipelineIdentifier} #${x.runSequence ?? ''}`

function selectedRun(runs) {
  if (!runs.length) return null
  let x = runs.find((r) => r.planExecutionId === view.selected)
  if (!x) {
    x = runs.find((r) => statusKind(r.status) === 'fail') ?? runs[0]
    view.selected = x.planExecutionId
  }
  return x
}

function isExpanded(x, newestFailedId) {
  const id = x.planExecutionId
  if (statusKind(x.status) !== 'fail' || view.collapsed.has(id)) return false
  return view.expanded.has(id) || id === newestFailedId
}

function toggleExpand(x) {
  if (!x) return
  const id = x.planExecutionId
  const open = view.expanded.has(id) || (!view.collapsed.has(id) && statusKind(x.status) === 'fail')
  if (open) { view.expanded.delete(id); view.collapsed.add(id) } else { view.collapsed.delete(id); view.expanded.add(id) }
}

function askFix($, x) {
  const msg = failureMessage(x)
  const d = doneDiag(x.planExecutionId)
  $.prompt.submit({
    asUser: true,
    text: `Harness run "${x.name ?? x.pipelineIdentifier}" #${x.runSequence} ended ${x.status}` +
      (msg ? ` (${msg})` : '') + `. Execution: ${execUrl(cfg, x)}\n` +
      (d ? `Diagnosis: ${d.cause}${d.fix ? `\nLikely fix: ${d.fix}` : ''}\n` : '') +
      'Find out why it failed — use the Harness MCP tools (e.g. harness_diagnose) if they are connected — and propose a fix in this repo.',
  })
}

function rediagnose($, x) {
  diagnoses.delete(x.planExecutionId)
  view.expanded.add(x.planExecutionId)
  view.collapsed.delete(x.planExecutionId)
  diagnose($, x)
}

const ACTION = {
  diagnose: { key: 'd', label: 'Diagnose' },
  fix: { key: 'f', label: 'Fix with Claude' },
  retry: { key: 't', label: 'Retry failed stages', write: true, ask: 'Retry the failed stages', ok: 'Retry', done: 'Retrying' },
  rerun: { key: 'u', label: 'Rerun pipeline', write: true, ask: 'Rerun the whole pipeline', ok: 'Rerun', done: 'Rerunning' },
  abort: { key: 'x', label: 'Abort', write: true, ask: 'Abort', ok: 'Abort', done: 'Aborted' },
  approve: { key: 'p', label: 'Approve', write: true, ask: 'Approve the waiting approval', ok: 'Approve', done: 'Approved' },
  reject: { key: 'n', label: 'Reject', write: true, ask: 'Reject the waiting approval', ok: 'Reject', done: 'Rejected' },
}

function runAction($, kind, x) {
  view.menu = false
  if (kind === 'diagnose') rediagnose($, x)
  else if (kind === 'fix') askFix($, x)
  else act($, kind, x)
  $.ui.invalidate('ui.render')
}

// Write actions: off unless allow_actions; always confirmed; production confirmed twice
async function act($, kind, x) {
  const a = ACTION[kind]
  const name = runName(x)
  if (!cfg.allow_actions) {
    $.ui.toast('Actions are off. Turn on "allow_actions" in /plugin configure harness-platform@harness-tools.', { timeoutMs: 8000 })
    return
  }
  if (kind === 'approve' || kind === 'reject') return approveFromMenu($, x, kind === 'approve' ? 'APPROVE' : 'REJECT')
  const stages = kind === 'retry' ? failedStageIds(x) : []
  if (kind === 'retry' && !stages.length) { $.ui.toast(`${name} has no failed stages to retry.`); return }
  const prod = [...new Set(cdTargets(x).filter((t) => t.envType === 'Production').map((t) => t.envName))]
  const deploys = kind === 'retry' || kind === 'rerun'
  if (deploys && prod.length && freeze?.frozen) {
    $.ui.toast(`${freezeText(freeze)}: not running ${name}, it deploys to production. Harness blocks it unless you can override the freeze.`, { timeoutMs: 10000 })
    return
  }
  let answer = ''
  let inp = { yaml: '', from: 'none' }
  try {
    answer = await $.ui.ask(`${a.ask} of ${name}${stages.length ? ` (${stages.join(', ')})` : ''}${deploys && freeze?.frozen ? ` (${freezeText(freeze)} is active)` : ''}?`, [a.ok, 'Cancel'])
    if (answer === a.ok && deploys) {
      inp = await runInputs($, x)
      if (!inp) return
      if (inp.from === 'too many') {
        $.ui.toast(`${name} needs ${inp.count} runtime inputs: run it from Harness, or ask Claude to run it with the inputs.`, { timeoutMs: 10000 })
        return
      }
    }
    if (answer === a.ok && prod.length && ['retry', 'rerun', 'approve'].includes(kind)) {
      answer = await $.ui.ask(`This deploys to production (${prod.join(', ')}).${securityNote()} Are you sure?`, ['Yes, deploy to production', 'Cancel'])
      if (answer === 'Yes, deploy to production') answer = a.ok
    }
  } catch {
    return
  }
  if (answer !== a.ok) return
  try {
    const id = encodeURIComponent(x.planExecutionId)
    const pipe = encodeURIComponent(x.pipelineIdentifier)
    const withInputs = inp.yaml ? { inputs: inp.yaml } : {}
    if (cfg.auth === 'mcp') {
      if (kind === 'retry') await mcp($, 'harness_execute', { resource_type: 'pipeline', action: 'retry', resource_id: x.pipelineIdentifier, params: { execution_id: x.planExecutionId, retry_stages: stages.join(','), run_all_stages: false }, ...withInputs, confirm: true })
      else if (kind === 'rerun') await mcp($, 'harness_execute', { resource_type: 'pipeline', action: 'run', resource_id: x.pipelineIdentifier, ...withInputs, confirm: true })
      else if (kind === 'abort') await mcp($, 'harness_execute', { resource_type: 'execution', action: 'interrupt', resource_id: x.planExecutionId, params: { interrupt_type: 'AbortAll' }, confirm: true })
    } else if (kind === 'retry') await harness($, 'POST', '/pipeline/api/pipeline/execute/retry/' + pipe, { planExecutionId: x.planExecutionId, retryStages: stages.join(','), runAllStages: 'false' }, inp.yaml)
    else if (kind === 'rerun') await harness($, 'POST', `/pipeline/api/pipeline/execute/rerun/${id}/${pipe}`, {}, inp.yaml)
    else if (kind === 'abort') await harness($, 'PUT', '/pipeline/api/pipeline/execute/interrupt/' + id, { interruptType: 'AbortAll' })
    $.ui.toast(`✓ ${a.done} ${name}${inp.from === 'original' ? ' with the inputs it used' : inp.from === 'asked' ? ' with your inputs' : ''}`, { timeoutMs: 6000 })
    burstUntil = (await $.clock.now()) + BURST_MS
    $.clock.after(3000, () => { refresh($) })
  } catch (err) {
    $.ui.toast(`✗ Couldn't ${a.label.toLowerCase()} ${name}: ${fit(String(err?.message ?? err), 140)}`, { timeoutMs: 10000 })
  }
}

function renderPane($, el, props, now) {
  const { Box, Button, Link } = el
  const T = mkT(el.Text)
  const W = Math.max(40, Number(props.bodyColumns) || 80) - 2
  const docked = props.placement === 'dock'
  const narrow = W < 70
  const right = `${freeze?.frozen ? freezeText(freeze) + ' · ' : ''}${cfg.on_failure === 'auto' ? 'auto-fix on · ' : ''}` +
    (error === 'not configured' ? 'setup needed' : updatedAt ? `${narrow ? '' : 'updated '}${ago(updatedAt, now)}${now < burstUntil ? ' · watching' : ''}` : 'loading…')
  const header = Box({
    flexDirection: 'row', justifyContent: 'space-between',
    children: [
      T(fit(`Harness · ${cfg.org_id}/${cfg.project_id}`, Math.max(12, W - Array.from(right).length - 2)), { bold: true }),
      T(right, { dimColor: true }),
    ],
  })
  if (error === 'not configured') {
    return Box({
      flexDirection: 'column',
      children: [
        header,
        T('Not configured yet.', { color: 'yellow' }),
        T('Set these in /config (or /plugin → harness-platform → configure):'),
        T('  • Project ID (and Org ID if not "default")'),
        T('  • Then either sign in with Harness (/mcp → the Harness server → Authenticate)'),
        T('    or set an API key (PAT or service-account token, read access)'),
        T('Account ID is read from the key. Env vars HARNESS_API_KEY, HARNESS_DEFAULT_PROJECT_ID', { dimColor: true }),
        T('and HARNESS_DEFAULT_ORG_ID (same as the Harness MCP server) also work.', { dimColor: true }),
      ],
    })
  }
  const v = buildView(data, scope)
  const budget = docked ? Math.max(6, (Number(props.scroll?.bodyRows) || 30) - 12) : 8
  const runs = v.executions.slice(0, budget)
  const effective = layout === 'dock' && !docked ? 'stacked' : layout === 'strip' ? 'stacked' : layout
  const sel = effective === 'focus' ? (v.branch?.headRun ?? v.branch?.latest ?? selectedRun(runs)) : selectedRun(runs)
  if (effective === 'focus' && sel) view.selected = sel.planExecutionId
  const redraw = () => $.ui.invalidate('ui.render')

  const controls = Box({
    flexDirection: 'row', columnGap: narrow ? 2 : 3,
    children: [
      // Compact labels when docked or narrow, so the row never overflows
      Button({ key: 'scope-mine', label: narrow ? 'Repo' : 'This repo', hotkey: '1', plain: true, dimColor: scope !== 'mine', onPress: () => { scope = 'mine'; redraw() } }),
      Button({ key: 'scope-all', label: narrow ? 'Project' : 'Whole project', hotkey: '2', plain: true, dimColor: scope !== 'all', onPress: () => { scope = 'all'; redraw() } }),
      Button({ key: 'refresh', label: 'Refresh', hotkey: 'r', plain: true, onPress: () => { refresh($) } }),
      Button({ key: 'modules', label: view.mode === 'modules' ? (narrow ? 'Runs' : 'Back to runs') : 'Platform', hotkey: 'm', plain: true, onPress: () => { if (view.mode === 'modules') { view.mode = 'runs' } else { view.mode = 'modules'; view.modFilter = null; mods.usedAt = updatedAt; if (!mods.at) fetchModules($) } redraw() } }),
      Button({ key: 'inventory', label: view.mode === 'inventory' ? (narrow ? 'Runs' : 'Back to runs') : 'Inventory', hotkey: 'i', plain: true, onPress: () => { if (view.mode === 'inventory') { view.mode = 'runs'; redraw() } else { openInventory($) } } }),
      Button({ key: 'layout', label: narrow ? layout : `Layout: ${layout}`, hotkey: 'v', plain: true, onPress: () => { setLayout($, LAYOUTS[(LAYOUTS.indexOf(layout) + 1) % LAYOUTS.length]) } }),
      ...(projectUrl(cfg) ? [Link({ href: projectUrl(cfg), label: narrow ? 'Harness' : 'open in Harness' })] : []),
    ],
  })
  const homeBtn = Button({ key: 'home', label: 'Home', hotkey: 'o', plain: true, onPress: () => { view.mode = 'home'; view.modFilter = null; redraw() } })
  if (view.mode === 'home') {
    const startHere = Button({ key: 'start-here', label: cfg.start_view === 'home' ? '★ start screen' : 'Start here', hotkey: 's', plain: true, dimColor: cfg.start_view === 'home', onPress: () => { setStartView($, 'home') } })
    const homeControls = Box({ flexDirection: 'row', columnGap: 3, children: [
      startHere,
      Button({ key: 'refresh', label: 'Refresh', hotkey: 'r', plain: true, onPress: () => { refresh($); mods.at = 0; fetchModules($) } }),
      Button({ key: 'layout', label: narrow ? layout : `Layout: ${layout}`, hotkey: 'v', plain: true, onPress: () => { setLayout($, LAYOUTS[(LAYOUTS.indexOf(layout) + 1) % LAYOUTS.length]) } }),
      ...(projectUrl(cfg) ? [Link({ href: projectUrl(cfg), label: narrow ? 'Harness' : 'open in Harness' })] : []),
    ] })
    return Box({ flexDirection: 'column', children: [header, homeControls, ...(error ? [T(fit('⚠ ' + error, W), { color: 'red' })] : []), ...renderHome($, el, T, W, now)] })
  }
  const here = startOf(view.mode)
  const startBtn = here && !(view.mode === 'modules' && view.modFilter)
    ? [Button({ key: 'start-here', label: cfg.start_view === here ? '★ start' : 'Start here', hotkey: 's', plain: true, dimColor: cfg.start_view === here, onPress: () => { setStartView($, here) } })]
    : []
  const children = [header, Box({ flexDirection: 'row', columnGap: 3, children: [homeBtn, ...startBtn, controls] })]
  if (error) children.push(T(fit('⚠ ' + error, W), { color: 'red' }))
  if (scope === 'mine' && v.scopeFellBack) {
    const why = v.git ? `No runs found for repo "${v.git.name}"` : 'Not in a git repo'
    children.push(T(fit(`${why} — showing ${v.mineBasis === 'me' ? 'runs you triggered' : 'the whole project'}.`, W), { dimColor: true }))
  }
  if (view.mode === 'inventory') {
    children.push(...renderInventory($, el, T, W, now, docked))
    return Box({ flexDirection: 'column', children })
  }
  if (view.mode === 'modules') {
    children.push(...renderModules($, el, T, W, now))
    return Box({ flexDirection: 'column', children })
  }
  if (view.mode === 'approvals') {
    const a = renderApprovals($, el, T, W, now)
    children.push(...(a.length ? a : [section(T, W, 'APPROVALS'), T('No approvals waiting.', { dimColor: true })]))
    return Box({ flexDirection: 'column', children })
  }
  if (view.mode === 'service') {
    children.push(...renderServicePage($, el, T, W, now))
    return Box({ flexDirection: 'column', children })
  }
  const att = attentionLine(mods.results)
  if (att.length) children.push(Box({ flexDirection: 'row', columnGap: 1, children: [...att.slice(0, 4).map((a, i) => T((i ? '· ' : '') + a.text, { color: COLOR[a.k] })), ...(att.length > 4 ? [T(`+${att.length - 4}`, { dimColor: true })] : []), T('(m)', { dimColor: true })] }))
  if (changeFlags.names.length) {
    const flags = mods.results.get('flags')?.items ?? []
    children.push(T(fit('⚑ flags in your change: ' + changeFlags.names.map((n) => { const f = flags.find((x) => x.name === n); return f?.detail ? `${n} (${f.detail})` : n }).join(', '), W), { color: 'magenta' }))
  }
  children.push(...renderApprovals($, el, T, W, now))
  if (effective === 'focus') children.push(...renderFocus($, el, T, W, v, sel, now))
  else if (effective === 'dock') children.push(...renderDock($, el, T, W, v, runs, sel, now))
  else {
    children.push(...renderBranch(el, T, W, v, now))
    children.push(...renderRuns($, el, T, W, v, runs, sel, now, false))
    children.push(...renderLanes(el, T, W, v, now, false))
    children.push(...renderEnvs(T, W, v))
  }
  children.push(renderHints($, el, T, sel, effective))
  return Box({ flexDirection: 'column', children })
}

// Approvals waiting anywhere in the project, with what they ask and who can give them
function renderApprovals($, el, T, W, now) {
  const items = waitingList()
  if (!items.length) return []
  const { Box, Button, Link } = el
  const out = [section(T, W, `APPROVALS WAITING · ${items.length}`)]
  for (const { x, a } of items.slice(0, 4)) {
    const to = [...new Set(cdTargets(x).map((t) => `${t.serviceName}→${t.envName}`))].join(', ')
    const when = [expiresIn(a.deadline, now), a.created ? `waiting ${ago(a.created, now)}` : ''].filter(Boolean).join(' · ')
    const canAct = a.type === 'HarnessApproval'
    const controls = canAct
      ? cfg.allow_actions
        ? [Button({ key: 'appr-' + a.id, label: 'approve', plain: true, onPress: () => { decideApproval($, x, a, 'APPROVE') } }),
           Button({ key: 'rej-' + a.id, label: 'reject', plain: true, onPress: () => { decideApproval($, x, a, 'REJECT') } })]
        : [T('approve/reject: turn on allow_actions', { dimColor: true })]
      : [T(`decide in ${approvalWhere(a.type)}`, { dimColor: true })]
    out.push(Box({
      key: 'appr-row-' + a.id, flexDirection: 'row', columnGap: 1,
      children: [T('◆', { color: 'magenta' }), T(fit(`${runName(x)}${to ? '  ' + to : ''}${when ? '  ' + when : ''}`, Math.max(20, W - (canAct && cfg.allow_actions ? 26 : 46)))), ...controls, Link({ href: execUrl(cfg, x), label: 'open' })],
    }))
    if (a.message) for (const l of wrapLines(a.message.replace(/\s+/g, ' '), W - 6, 2)) out.push(T('    ' + l))
    const meta = [
      a.approvers.length ? `approvers: ${a.approvers.join(', ')}${a.minimumCount > 1 ? ` (${a.minimumCount} needed)` : ''}` : '',
      a.inputs.length ? `asks for: ${a.inputs.map((i) => i.name).join(', ')}` : '',
    ].filter(Boolean).join(' · ')
    if (meta) out.push(T(fit('    ' + meta, W), { dimColor: true }))
  }
  if (items.length > 4) out.push(T(`  … ${items.length - 4} more`, { dimColor: true }))
  return out
}

function renderBranch(el, T, W, v, now) {
  if (!v.branch) return []
  const { Box, Link } = el
  const h = v.branch.headRun
  const latest = v.branch.latest
  const out = [section(T, W, 'THIS BRANCH')]
  out.push(Box({
    flexDirection: 'row', columnGap: 1,
    children: [
      T(fit(`${v.git.name} @ ${v.branch.name}  HEAD ${short(v.branch.head) || '?'}`, Math.floor(W * 0.45)), { bold: true }),
      ...(typeof behind === 'number' ? [T(behind ? `prod ${behind} behind` : 'prod is current', { dimColor: true })] : []),
      h ? kindText(T, h.status, `${h.status} · #${h.runSequence} ${ago(h.startTs, now)}`)
        : !latest && isCdOnly() ? T(fit(`CD-only: deploys ${data.services.filter((x) => repoServiceIds().has(x.identifier)).map((x) => x.name).join(', ')} from manifests here`, Math.max(20, W - Math.floor(W * 0.45) - 2)), { dimColor: true })
        : T(latest ? 'HEAD not built yet' : 'no runs on this branch', { color: 'yellow' }),
      ...(h ? [Link({ href: execUrl(cfg, h), label: 'open' })] : []),
    ],
  }))
  if (pr) out.push(renderPrRow(el, T, W))
  if (!h && latest) {
    out.push(Box({
      flexDirection: 'row', columnGap: 1,
      children: [T('  last run'), kindText(T, latest.status, `${latest.status} on ${short(execCi(latest)?.commit)} · ${ago(latest.startTs, now)}`), Link({ href: execUrl(cfg, latest), label: 'open' })],
    }))
  }
  return out
}

function renderPrRow(el, T, W) {
  const { Box, Link } = el
  const c = summarizeChecks(pr.checks)
  const k = c.fail ? 'fail' : c.run ? 'run' : pr.checks.length ? 'ok' : 'idle'
  return Box({
    flexDirection: 'row', columnGap: 1,
    children: [
      T(ICON[k], { color: COLOR[k] }),
      T(fit(prLine(pr) + (c.failing.length ? ` (${c.failing.slice(0, 3).join(', ')})` : ''), W - 10)),
      ...(pr.url ? [Link({ href: pr.url, label: 'open' })] : []),
    ],
  })
}

function runLine(x, W, now, narrow) {
  const ci = execCi(x)
  const targets = cdTargets(x)
  const what = targets.length ? targets.map((t) => `${t.serviceName}→${t.envName}`).join(', ') : ci ? `${ci.branch}${ci.commit ? '@' + short(ci.commit) : ''}` : ''
  // Truncate the pipeline name, never the run number
  const runNo = ` #${x.runSequence ?? ''}`
  const nameW = narrow ? Math.floor(W * 0.45) : Math.floor(W * 0.25)
  const label = fit(x.name ?? x.pipelineIdentifier, nameW - Array.from(runNo).length) + runNo
  // 15 columns fits Harness's longest common statuses (ApprovalWaiting, IgnoreFailed)
  return narrow
    ? `${pad(label, nameW)} ${pad(x.status, 15)} ${ago(x.startTs, now)}`
    : `${pad(label, nameW)} ${pad(what, Math.floor(W * 0.24))} ${pad(x.status, 15)} ${ago(x.startTs, now)}`
}

function renderRuns($, el, T, W, v, runs, sel, now, narrow) {
  const { Box } = el
  const out = [section(T, W, `PIPELINES (${v.scope !== 'mine' ? 'project' : v.mineBasis === 'me' ? 'yours' : 'this repo'}) · ${v.counts.running} running · ${v.counts.failed} failed`)]
  if (!runs.length) out.push(T(updatedAt ? 'No runs.' : 'Loading…', { dimColor: true }))
  const newestFailed = runs.find((r) => statusKind(r.status) === 'fail')?.planExecutionId
  for (const x of runs) {
    const isSel = sel?.planExecutionId === x.planExecutionId
    out.push(Box({
      key: 'run-' + x.planExecutionId, flexDirection: 'row', columnGap: 1,
      children: [T(isSel ? '❯' : ' ', { color: 'blue' }), kindText(T, x.status, ''), T(fit(runLine(x, W, now, narrow), W - 5), { inverse: isSel })],
    }))
    if (isExpanded(x, newestFailed)) out.push(...renderCard($, el, T, W, x))
    if (isSel && view.menu) out.push(...renderMenu($, el, T, x))
  }
  if (v.executions.length > runs.length) out.push(T(`  … ${v.executions.length - runs.length} more`, { dimColor: true }))
  return out
}

// The expandable diagnosis card under a failed run
function renderCard($, el, T, W, x) {
  const { Box, Button, Link } = el
  const id = x.planExecutionId
  const bar = () => T('  ┃', { color: 'red' })
  const row = (label, text, style = {}) => Box({ flexDirection: 'row', columnGap: 1, children: [bar(), T(pad(label, 10), { bold: Boolean(label) }), T(text, style)] })
  const out = []
  const d = doneDiag(id)
  const w = Math.max(20, W - 16)
  if (diagRuns.has(id)) out.push(row('', 'diagnosing…', { dimColor: true }))
  else if (d) {
    wrapLines(d.cause, w).forEach((l, i) => out.push(row(i ? '' : 'Cause', l)))
    if (d.evidence) wrapLines(d.evidence, w).forEach((l, i) => out.push(row(i ? '' : 'Evidence', l, { dimColor: true })))
    if (d.fix) wrapLines(d.fix, w).forEach((l, i) => out.push(row(i ? '' : 'Likely fix', l)))
    out.push(row('', `${d.confidence} confidence · ${d.fromLogs ? 'read from the step log' : 'from failure messages only'}`, { dimColor: true }))
  } else {
    const msg = failureMessage(x) || x.status
    wrapLines(msg, w).forEach((l, i) => out.push(row(i ? '' : 'Failure', l, { color: 'red' })))
  }
  out.push(Box({
    flexDirection: 'row', columnGap: 3,
    children: [
      bar(),
      Button({ key: 'ask-' + id, label: 'fix with Claude', plain: true, onPress: () => { askFix($, x) } }),
      ...(cfg.diagnose !== 'off' && !diagRuns.has(id) ? [Button({ key: 'diag-' + id, label: d ? 'diagnose again' : 'diagnose', plain: true, onPress: () => { rediagnose($, x) } })] : []),
      Link({ href: execUrl(cfg, x), label: 'open in Harness' }),
      T('a more · e collapse', { dimColor: true }),
    ],
  }))
  return out
}

// "Select a row, then act": the actions menu for the selected run
function renderMenu($, el, T, x) {
  const { Box, Button, Link } = el
  const out = []
  for (const kind of actionsFor(x)) {
    const a = ACTION[kind]
    const off = a.write && !cfg.allow_actions
    out.push(Box({
      flexDirection: 'row',
      children: [T('    │ ', { dimColor: true }), Button({ key: 'act-' + kind, label: `${a.key}  ${a.label}${off ? '  (off: allow_actions)' : ''}`, hotkey: a.key, plain: true, dimColor: off, onPress: () => { runAction($, kind, x) } })],
    }))
  }
  out.push(Box({ flexDirection: 'row', children: [T('    │ ', { dimColor: true }), Link({ href: execUrl(cfg, x), label: 'Open in Harness' })] }))
  out.push(Box({ flexDirection: 'row', children: [T('    │ ', { dimColor: true }), Button({ key: 'act-close', label: 'q  Close menu', hotkey: 'q', plain: true, dimColor: true, onPress: () => { view.menu = false; $.ui.invalidate('ui.render') } })] }))
  return out
}

// Promotion lanes: each service from dev to prod, with how far each stage is behind HEAD
function laneData(v, now) {
  const commits = envCommits(data.executions, data.git?.name)
  return v.matrix.services.map((s) => ({
    name: s.name,
    segs: v.matrix.envs.map((env) => {
      const c = s.cells[env.id]
      const n = behindByCommit.get(commits.get(s.id + '\u0000' + env.id))
      const p = pendingChanges.get(s.id + '\u0000' + env.id)
      const lag = n === 0 ? 'HEAD' : typeof n === 'number' ? `${n} behind` : typeof p === 'number' ? pendingText(p) : ''
      return {
        label: (env.type === 'Production' ? '★ ' : '') + env.name + ' ',
        cell: c ? `${ICON[statusKind(c.status)]} ${fit(c.artifact || '#' + (c.execution?.runSequence ?? ''), 12)}` : '—',
        color: c ? COLOR[statusKind(c.status)] : undefined,
        sub: c ? [lag, ago(c.startTs, now)].filter(Boolean).join(' · ') : 'not deployed',
      }
    }),
  }))
}

function renderLanes(el, T, W, v, now, vertical) {
  const { Box } = el
  const lanes = laneData(v, now)
  if (!lanes.length) return []
  const out = [section(T, W, 'DEPLOYED')]
  if (vertical) {
    for (const lane of lanes.slice(0, 4)) {
      out.push(T(lane.name, { bold: true }))
      for (const g of lane.segs) out.push(Box({ flexDirection: 'row', columnGap: 1, children: [T('  ' + pad(g.label, 12)), T(pad(g.cell, 14), { color: g.color }), T(g.sub, { dimColor: true })] }))
    }
    return out
  }
  const nameW = Math.min(18, Math.max(10, ...lanes.map((l) => Array.from(l.name).length + 2)))
  for (const lane of lanes.slice(0, 6)) {
    let segs = lane.segs.map((g) => ({ ...g, w: Math.max(Array.from(g.label + g.cell).length, Array.from(g.sub).length) }))
    let hidden = 0
    const width = () => nameW + segs.reduce((a, g) => a + g.w, 0) + 4 * (segs.length - 1)
    while (segs.length > 2 && width() > W - 8) { segs.splice(segs.length - 2, 1); hidden++ }
    const top = [T(pad(lane.name, nameW), { bold: true })]
    const bottom = [T(pad('', nameW))]
    segs.forEach((g, i) => {
      if (i) { top.push(T(' ─▶ ', { dimColor: true })); bottom.push(T('    ')) }
      top.push(T(g.label))
      top.push(T(pad(g.cell, g.w - Array.from(g.label).length), { color: g.color }))
      bottom.push(T(pad(g.sub, g.w), { dimColor: true }))
    })
    if (hidden) top.push(T(`  +${hidden} more`, { dimColor: true }))
    out.push(Box({ key: 'lane-' + lane.name, flexDirection: 'row', children: top }))
    out.push(Box({ key: 'lane-sub-' + lane.name, flexDirection: 'row', children: bottom }))
  }
  return out
}

function renderEnvs(T, W, v) {
  if (!v.environments.length) return []
  return [section(T, W, 'ENVIRONMENTS'), T(fit(v.environments.map((env) => `${env.name}${env.type === 'Production' ? ' (prod)' : ''}`).join(' · '), W), { dimColor: true })]
}

// Branch-first focus: one headline about your commit, the rest folded
function renderFocus($, el, T, W, v, sel, now) {
  const out = []
  const sha = short(v.branch?.head)
  const h = v.branch?.headRun
  if (!v.branch) out.push(T('Not in a git repo: switch to the stacked layout (v) for project runs.', { dimColor: true }))
  else if (!h) out.push(T(fit(`· Your commit ${sha || '?'} hasn't been built yet${v.branch.latest ? ` (last run ${runName(v.branch.latest)} ${v.branch.latest.status})` : ''}.`, W), { color: 'yellow' }))
  else {
    const k = statusKind(h.status)
    const where = [...new Set(laneData(v, now).flatMap((l) => l.segs.filter((g) => g.sub.startsWith('HEAD')).map((g) => g.label.replace('★ ', '').trim())))]
    const text = k === 'ok' ? `✓ Your commit ${sha} is built${where.length ? ` and running in ${where.join(', ')}` : ''}.`
      : k === 'fail' ? `✗ Your commit ${sha} failed: ${runName(h)} ${h.status}.`
      : k === 'wait' ? `◆ Your commit ${sha} is waiting: ${runName(h)} ${h.status}.`
      : `● Building your commit ${sha}: ${runName(h)} · ${ago(h.startTs, now)}.`
    out.push(T(fit(text, W), { color: COLOR[k], bold: true }))
    if (k === 'fail') out.push(...renderCard($, el, T, W, h))
    if (view.menu && sel) out.push(...renderMenu($, el, T, sel))
  }
  if (pr) out.push(renderPrRow(el, T, W))
  const first = laneData(v, now)[0]
  out.push(T(fit(`▸ runs: ${v.executions.length} · ${v.counts.running} running · ${v.counts.failed} failed`, W), { dimColor: true }))
  if (first) out.push(T(fit(`▸ deployed: ${first.name}  ${first.segs.map((g) => `${g.label}${g.cell}`).join('  ')}${typeof behind === 'number' ? `  (prod ${behind} behind)` : ''}`, W), { dimColor: true }))
  out.push(T(fit(`▸ environments: ${v.environments.map((e) => e.name).join(' · ')}`, W), { dimColor: true }))
  return out
}

// Docked sidebar: two tabs, narrow rows
function renderDock($, el, T, W, v, runs, sel, now) {
  const { Button } = el
  const out = [Button({ key: 'tab', label: view.tab === 'runs' ? 'Runs  ·  deployed (w)' : 'runs  ·  Deployed (w)', hotkey: 'w', plain: true, onPress: () => { view.tab = view.tab === 'runs' ? 'deployed' : 'runs'; $.ui.invalidate('ui.render') } })]
  if (v.branch?.headRun) out.push(kindText(T, v.branch.headRun.status, fit(`${v.branch.name}@${short(v.branch.head)} ${v.branch.headRun.status} #${v.branch.headRun.runSequence}`, W - 2)))
  if (view.tab === 'runs') out.push(...renderRuns($, el, T, W, v, runs, sel, now, true))
  else out.push(...renderLanes(el, T, W, v, now, true))
  return out
}

function renderHints($, el, T, sel, effective) {
  const { Box, Button } = el
  const redraw = () => $.ui.invalidate('ui.render')
  const failed = sel && statusKind(sel.status) === 'fail'
  return Box({
    flexDirection: 'row', columnGap: 2,
    children: [
      ...(effective !== 'focus' ? [
        Button({ key: 'sel-down', label: 'j ↓', hotkey: 'j', plain: true, dimColor: true, onPress: () => { moveSelection(1); redraw() } }),
        Button({ key: 'sel-up', label: 'k ↑', hotkey: 'k', plain: true, dimColor: true, onPress: () => { moveSelection(-1); redraw() } }),
      ] : []),
      ...(sel ? [
        Button({ key: 'actions', label: 'a actions', hotkey: 'a', plain: true, dimColor: true, onPress: () => { view.menu = !view.menu; redraw() } }),
        ...(failed ? [
          Button({ key: 'expand', label: 'e expand', hotkey: 'e', plain: true, dimColor: true, onPress: () => { toggleExpand(sel); redraw() } }),
          Button({ key: 'fix', label: 'f fix', hotkey: 'f', plain: true, dimColor: true, onPress: () => { askFix($, sel) } }),
          ...(cfg.diagnose !== 'off' ? [Button({ key: 'diagnose', label: 'd diagnose', hotkey: 'd', plain: true, dimColor: true, onPress: () => { rediagnose($, sel) } })] : []),
        ] : []),
      ] : []),
    ],
  })
}

function moveSelection(delta) {
  const runs = buildView(data, scope).executions.slice(0, 30)
  const i = runs.findIndex((r) => r.planExecutionId === view.selected)
  const next = runs[Math.min(runs.length - 1, Math.max(0, (i === -1 ? 0 : i) + delta))]
  if (next) view.selected = next.planExecutionId
  view.menu = false
}

function renderBand($, el, props, now) {
  const { Box, Button } = el
  const T = mkT(el.Text)
  const v = buildView(data, 'mine')
  const h = v.branch?.headRun
  const head = v.branch
    ? h ? kindText(T, h.status, `${v.branch.name}@${short(v.branch.head)} ${h.status} #${h.runSequence}`) : T(`· ${v.branch.name}@${short(v.branch.head)} not built yet`, { color: 'yellow' })
    : T(`harness ${cfg.project_id}: ${v.counts.running} running · ${v.counts.failed} failed`)
  const spark = sparkRuns(v.executions, 20).map((g) => T(SPARK[g.kind].repeat(g.count), { color: COLOR[g.kind] }))
  return Box({
    flexDirection: 'row', columnGap: 2,
    children: [
      head,
      Box({ flexDirection: 'row', children: spark }),
      ...(typeof behind === 'number' ? [T(behind ? `prod ${behind} behind` : 'prod is current', { dimColor: true })] : []),
      ...(pr ? [T(`PR #${pr.number} ${summarizeChecks(pr.checks).fail ? '✗' : summarizeChecks(pr.checks).run ? '●' : '✓'}`, { color: COLOR[summarizeChecks(pr.checks).fail ? 'fail' : summarizeChecks(pr.checks).run ? 'run' : 'ok'] })] : []),
      ...(freeze?.frozen ? [T(freezeText(freeze), { color: 'cyan' })] : []),
      ...(attentionLine(mods.results).length ? [T(attentionLine(mods.results)[0].text + (attentionLine(mods.results).length > 1 ? ` +${attentionLine(mods.results).length - 1}` : ''), { color: COLOR[attentionLine(mods.results)[0].k] })] : []),
      ...(waitingList().length ? [T(`◆ ${waitingList().length} approval${waitingList().length === 1 ? '' : 's'} waiting`, { color: 'magenta' })] : []),
      ...(cfg.on_failure === 'auto' ? [T('auto-fix on', { color: 'magenta' })] : []),
      Button({ key: 'band-open', label: 'h Harness pane', hotkey: 'h', plain: true, dimColor: true, onPress: () => { openPane($, true) } }),
    ],
  })
}

// ---- /harness doctor: read-only checks of everything the mod uses ------------------------

async function doctor($) {
  freezeAt = 0
  prAt = 0
  await refresh($)
  const L = [`Harness doctor · ${cfg.org_id}/${cfg.project_id} · ${cfg.base_url}`]
  const ok = (n, d) => L.push(`✓ ${n} — ${d}`)
  const bad = (n, d) => L.push(`✗ ${n} — ${d}`)
  const note = (n, d) => L.push(`· ${n} — ${d}`)
  if (error === 'not configured') { bad('Settings', 'set the project ID (and sign in or set an API key): /plugin configure harness-platform@harness-tools'); return L.join('\n') }
  if (cfg.auth === 'key') ok('Auth', `API key (${cfg.api_key.split('.')[0] || 'key'}…), account ${cfg.account_id}`)
  else note('Auth', `Harness sign-in through the MCP server "${cfg.mcp_server}"`)
  if (error) { bad('Pipelines API', error); L.push('Fix this first: everything else depends on it.'); return L.join('\n') }
  const v = buildView(data, 'mine')
  ok('Pipeline runs', `${data.executions.length} recent runs${v.mineBasis === 'repo' ? `, ${v.executions.length} from this repo` : ''}`)
  ok('Services & environments', `${data.services.length} services, ${data.environments.length} environments (${data.environments.filter((e) => e.type === 'Production').length} production)`)
  if (cfg.auth === 'key') data.me ? ok('User', data.me) : note('User', 'no user behind this key (service account?): "runs you triggered" is unavailable')
  data.git ? ok('Git', `${data.git.name} @ ${data.git.branch ?? '(detached)'} ${short(data.git.head)}`) : note('Git', 'not in a git repo: showing the whole project')
  if (data.git?.name) {
    const refs = [...connectors.keys()]
    const unreadable = refs.filter((r) => connectors.get(r) === null)
    const mine = data.services.filter((x) => repoServiceIds().has(x.identifier)).map((x) => x.name)
    if (refs.length) unreadable.length ? bad('Git connectors', `${refs.length - unreadable.length}/${refs.length} readable; can't read ${unreadable.join(', ')} (needs view on connectors), so services using them can't be matched to this repo`) : ok('Git connectors', `${refs.length} read to match service manifests to this repo`)
    if (mine.length) ok('Services from this repo', `${mine.join(', ')}${isCdOnly() ? ' — CD-only repo: matched by manifests; pending manifest changes tracked per environment' : ''}`)
  }

  const x = data.executions.find((r) => statusKind(r.status) === 'fail') ?? data.executions[0]
  if (x) {
    if (cfg.auth === 'key') {
      try { await harness($, 'GET', '/pipeline/api/pipelines/execution/v2/' + encodeURIComponent(x.planExecutionId), { renderFullBottomGraph: 'true' }); ok('Step details', `execution graph of ${runName(x)} readable`) } catch (err) { bad('Step details', `${fit(String(err?.message ?? err), 100)} (diagnosis falls back to stage messages)`) }
      try {
        const tok = await $.http.fetch(`${cfg.base_url}/gateway/log-service/token?accountID=${encodeURIComponent(cfg.account_id)}`, { headers: { 'x-api-key': cfg.api_key } })
        tok.ok ? ok('Step logs', 'log service token issued') : bad('Step logs', `log service answered HTTP ${tok.status} (diagnosis works without logs)`)
      } catch (err) { bad('Step logs', fit(String(err?.message ?? err), 100)) }
    } else {
      try { await mcp($, 'harness_diagnose', { resource_type: 'pipeline', options: { execution_id: x.planExecutionId, summary: true } }); ok('Step details & logs', 'harness_diagnose works') } catch (err) { bad('Step details & logs', fit(String(err?.message ?? err), 100)) }
    }
    try {
      const list = await fetchApprovalsFor($, x)
      ok('Approvals API', `readable (${list.length} waiting on ${runName(x)})`)
    } catch (err) { bad('Approvals API', fit(String(err?.message ?? err), 100)) }
  } else note('Run details', 'no runs to check against')

  freeze ? ok('Freeze windows', freeze.frozen ? freezeText(freeze) : `none active${freeze.upcoming[0] ? `, next: ${freeze.upcoming[0].name}` : ''}`) : bad('Freeze windows', 'could not read them (needs view permission on freeze windows); production actions are not freeze-checked')

  const pipelines = [...new Set(data.executions.map((r) => r.pipelineIdentifier))].slice(0, 5)
  for (const p of pipelines) {
    try {
      const j = cfg.auth === 'mcp'
        ? await mcp($, 'harness_get', { resource_type: 'runtime_input_template', resource_id: p })
        : await harness($, 'POST', '/pipeline/api/inputSets/template', { pipelineIdentifier: p }, {})
      const ins = parseTemplateInputs(String(j?.inputSetTemplateYaml ?? j?.data?.inputSetTemplateYaml ?? ''))
      ins.length
        ? note(`Runtime inputs: ${p}`, `${ins.length} (${ins.map((i) => i.label).join(', ')}): rerun/retry reuse the original run's inputs${ins.length > 6 ? '; new runs need Harness or Claude' : ', and ask for any it lacks'}`)
        : ok(`Runtime inputs: ${p}`, 'none: rerun/retry need nothing')
    } catch (err) { bad(`Runtime inputs: ${p}`, fit(String(err?.message ?? err), 100)) }
  }

  if (!data.git?.remote) note('Pull requests', 'no git remote')
  else if (pr) ok('Pull requests', prLine(pr))
  else if (prError) bad('Pull requests', prError + (isGithubRemote(data.git.remote) ? ' (install gh and run gh auth login)' : ''))
  else if (harnessCodeRef(data.git.remote) && cfg.auth === 'mcp') note('Pull requests', 'Harness Code PRs need an API key for now')
  else if (harnessCodeRef(data.git.remote) || isGithubRemote(data.git.remote)) ok('Pull requests', `no open PR for ${data.git.branch}`)
  else note('Pull requests', 'repo host not supported (Harness Code or GitHub)')

  await fetchModules($)
  for (const m of MODULES.filter((x) => cfg.modules.includes(x.id))) {
    const r = mods.results.get(m.id)
    r?.items ? ok(`${m.title}`, moduleSummary(m, r.items).text) : note(`${m.title}`, `not available: ${r?.error || 'not loaded'}`)
  }
  note('Platform modules', `through ${cfg.mcp_server}${cfg.auth === 'key' ? ' (local, with your API key; needs Node.js for npx)' : ''}`)
  note('Starting screen', `${START_LABEL[cfg.start_view]} (s in any view, or /harness start)`)
  note('Behaviour', `diagnose ${cfg.diagnose} · on failure ${cfg.on_failure} · push guard ${cfg.push_guard} · prod guard ${cfg.prod_guard ? 'on' : 'off'} · actions ${cfg.allow_actions ? 'on' : 'off'}`)
  note('Write permissions', 'Harness checks them when you act; a refusal shows Harness\'s own message')
  return L.join('\n')
}

// ---- Inventory view: every service × environment, live version, drift, details -----------------

function renderInventory($, el, T, W, now, vertical) {
  const { Box, Button, Link } = el
  const iv = currentInventory()
  const redraw = () => $.ui.invalidate('ui.render')
  const out = []
  const deployed = iv.rows.filter((r) => r.deployed)
  const status = inv.scanning && !inv.scannedAt ? 'scanning deploy history…' : inv.error ? '⚠ ' + inv.error : `${inv.runs} CD runs · ${cfg.inventory_days}d · scanned ${ago(inv.scannedAt, now) || 'now'}${inv.scanning ? ' · rescanning' : ''}`
  out.push(section(T, W, `DEPLOYMENTS (${iv.scopeLabel}) · ${deployed.length} services × ${iv.envs.length} environments`))
  if (!deployed.length) {
    out.push(T(inv.scannedAt ? 'No deployments in the window.' : 'Loading deployments…', { dimColor: true }))
    out.push(T(status, { dimColor: true }))
    return out
  }
  if (!view.invSel || !deployed.some((r) => r.id === view.invSel)) view.invSel = deployed[0].id
  const nameW = Math.min(22, Math.max(12, ...deployed.map((r) => Array.from(r.name).length + 3)))
  const colW = Math.max(14, Math.min(22, Math.floor((W - nameW - 8) / Math.max(1, iv.envs.length))))
  const fitEnvs = vertical ? iv.envs : iv.envs.slice(0, Math.max(1, Math.floor((W - nameW - 8) / colW)))
  if (!vertical) {
    out.push(T(pad('', nameW) + fitEnvs.map((e) => pad((e.type === 'Production' ? '★ ' : '') + e.name, colW)).join('') + (iv.envs.length > fitEnvs.length ? `+${iv.envs.length - fitEnvs.length}` : ''), { bold: true }))
  }
  for (const r of deployed) {
    const sel = r.id === view.invSel
    const open = view.invOpen.has(r.id)
    if (vertical) {
      out.push(Box({ key: 'inv-' + r.id, flexDirection: 'row', columnGap: 1, children: [T(sel ? '❯' : ' ', { color: 'blue' }), T(r.name + (r.drift.length ? '  ⚠ drift' : ''), { bold: true, inverse: sel })] }))
      for (const e of iv.envs) {
        const c = inventoryCell(r.cells[e.id], now)
        if (r.cells[e.id]) out.push(Box({ flexDirection: 'row', columnGap: 1, children: [T('   ' + pad((e.type === 'Production' ? '★ ' : '') + e.name, 12)), T(c.text, { color: COLOR[c.kind] })] }))
      }
    } else {
      out.push(Box({
        key: 'inv-' + r.id, flexDirection: 'row',
        children: [
          T(sel ? '❯ ' : '  ', { color: 'blue' }),
          T(pad(r.name, nameW - 3), { bold: true, inverse: sel }),
          T(' '),
          ...fitEnvs.map((e) => { const c = inventoryCell(r.cells[e.id], now); return T(pad(c.text, colW), { color: COLOR[c.kind], dimColor: c.kind === 'idle' }) }),
          ...(r.drift.length ? [T('⚠ ' + r.drift.map((d) => `${d.to} ≠ ${d.from}`).join(', '), { color: 'yellow' })] : []),
        ],
      }))
    }
    if (open) out.push(...renderInventoryDetail(el, T, W, iv, r, now))
  }
  const idle = iv.rows.filter((r) => !r.deployed)
  if (idle.length) out.push(T(fit(`not deployed in ${cfg.inventory_days} days: ${idle.map((r) => r.name).join(', ')}`, W), { dimColor: true }))
  out.push(T(fit(`live = last good deploy per environment/infrastructure · ${status}`, W), { dimColor: true }))
  out.push(Box({
    flexDirection: 'row', columnGap: 2,
    children: [
      Button({ key: 'inv-down', label: 'j ↓', hotkey: 'j', plain: true, dimColor: true, onPress: () => { moveInventory(deployed, 1); redraw() } }),
      Button({ key: 'inv-up', label: 'k ↑', hotkey: 'k', plain: true, dimColor: true, onPress: () => { moveInventory(deployed, -1); redraw() } }),
      Button({ key: 'inv-expand', label: 'e details', hotkey: 'e', plain: true, dimColor: true, onPress: () => { view.invOpen.has(view.invSel) ? view.invOpen.delete(view.invSel) : view.invOpen.add(view.invSel); redraw() } }),
      Button({ key: 'inv-rescan', label: 'r rescan', hotkey: 'r', plain: true, dimColor: true, onPress: () => { scanInventory($) } }),
      Button({ key: 'inv-back', label: 'i back to runs', hotkey: 'i', plain: true, dimColor: true, onPress: () => { view.mode = 'runs'; redraw() } }),
    ],
  }))
  return out
}

function moveInventory(rows, d) {
  const i = rows.findIndex((r) => r.id === view.invSel)
  const next = rows[Math.min(rows.length - 1, Math.max(0, (i === -1 ? 0 : i) + d))]
  if (next) view.invSel = next.id
}

// Every environment and infrastructure of one service: live version, when, who, which run; newer attempts
function renderInventoryDetail(el, T, W, iv, r, now) {
  const { Box, Link } = el
  const out = []
  for (const e of iv.envs) {
    const c = r.cells[e.id]
    if (!c) continue
    for (const i of c.infras) {
      const l = i.live
      const where = `${(e.type === 'Production' ? '★ ' : '') + e.name}${c.infras.length > 1 || i.infra ? ' · ' + (i.infra || 'default') : ''}`
      const url = (l ?? i.attempt) ? execUrl(cfg, { pipelineIdentifier: (l ?? i.attempt).pipelineId, planExecutionId: (l ?? i.attempt).execution, openInHarness: (l ?? i.attempt).url }) : ''
      out.push(Box({
        flexDirection: 'row', columnGap: 1,
        children: [
          T('    │', { dimColor: true }),
          T(pad(where, 24)),
          l ? T(pad(l.artifact || '#' + l.run, 16), { color: 'green' }) : T(pad('nothing live', 16), { dimColor: true }),
          T(fit(l ? `${ago(l.at, now) === 'now' ? 'just now' : ago(l.at, now) + ' ago'}${l.by ? ' by ' + l.by : ''} · ${l.pipeline} #${l.run}${l.commit ? ' @' + short(l.commit) : ''}` : '', Math.max(10, W - 52)), { dimColor: true }),
          ...(url ? [Link({ href: url, label: 'open' })] : []),
        ],
      }))
      const p = pendingChanges.get(r.id + '\u0000' + e.id)
      if (typeof p === 'number' && i === c.infras[0]) out.push(T(fit(`    │   manifests in this repo: ${p ? `${p} commit${p === 1 ? '' : 's'} since this deploy, not deployed yet` : 'no changes since this deploy'}`, W), { color: p ? 'yellow' : undefined, dimColor: !p }))
      if (i.attempt) out.push(T(fit(`    │   ↳ newer: ${i.attempt.artifact || '#' + i.attempt.run} ${i.attempt.status} ${ago(i.attempt.at, now) === 'now' ? 'just now' : ago(i.attempt.at, now) + ' ago'} (${i.attempt.pipeline} #${i.attempt.run})`, W), { color: COLOR[statusKind(i.attempt.status)] }))
    }
  }
  for (const d of r.drift) out.push(T(fit(`    │ ⚠ ${d.to} runs a different version from ${d.from}`, W), { color: 'yellow' }))
  for (const g of (mods.results.get('gitops')?.items ?? []).filter((x) => x.service === r.id || repoKey(x.name).startsWith(repoKey(r.name) + '-'))) {
    out.push(T(fit(`    │ ⎈ GitOps ${g.name}${g.env ? ' (' + g.env + ')' : ''}: ${g.detail}`, W), { color: COLOR[g.kind] }))
  }
  const owner = (mods.results.get('catalog')?.items ?? []).find((x) => repoKey(x.name) === repoKey(r.name) || repoKey(x.name) === repoKey(r.id))?.owner
  if (owner) out.push(T(fit(`    │ owner: ${owner} (catalog)`, W), { dimColor: true }))
  return out
}

// ---- Platform hub ------------------------------------------------------------------------------

function modulesText() {
  const L = [`Harness platform · ${cfg.org_id}/${cfg.project_id}`]
  const att = attentionLine(mods.results)
  if (att.length) L.push('Needs attention: ' + att.map((a) => a.text).join(' · '))
  for (const m of MODULES.filter((x) => cfg.modules.includes(x.id))) {
    const r = mods.results.get(m.id)
    L.push(`${m.icon} ${m.title}: ${r?.items ? moduleSummary(m, r.items).text : 'not available (' + (r?.error || 'not loaded') + ')'}`)
    for (const x of (r?.items ?? []).filter((y) => y.kind === 'fail' || y.kind === 'warn').slice(0, 3)) L.push(`    ${ICON[x.kind]} ${x.name}${x.detail ? ' — ' + x.detail : ''}`)
  }
  return L.join('\n')
}

function renderModules($, el, T, W, now) {
  const { Box, Button, Link } = el
  const redraw = () => $.ui.invalidate('ui.render')
  const enabled = MODULES.filter((m) => cfg.modules.includes(m.id) && (!view.modFilter || view.modFilter.includes(m.id)))
  const out = [section(T, W, `${view.modFilter ? view.modFilterLabel.toUpperCase() : 'PLATFORM'} · ${enabled.length} module${enabled.length === 1 ? '' : 's'}${mods.fetching && !mods.at ? ' · loading…' : mods.at ? ` · ${ago(mods.at, now)}` : ''}`)]
  const att = attentionLine(mods.results)
  if (att.length) out.push(T(fit('needs attention: ' + att.map((a) => a.text).join(' · '), W), { color: COLOR[att[0].k] }))
  if (!view.modSel || !enabled.some((m) => m.id === view.modSel)) view.modSel = enabled[0]?.id
  view.modOpen ??= new Set()
  for (const m of enabled) {
    const r = mods.results.get(m.id)
    const sel = m.id === view.modSel
    const sum = r?.items ? moduleSummary(m, r.items) : null
    out.push(Box({
      key: 'mod-' + m.id, flexDirection: 'row', columnGap: 1,
      children: [
        T(sel ? '❯' : ' ', { color: 'blue' }),
        T(pad(`${m.icon} ${m.title}`, 24), { bold: true, inverse: sel }),
        sum ? T(fit(sum.text, W - 30), { color: COLOR[sum.kind] }) : T(fit(r ? 'not available: ' + (r.error || '—') : 'loading…', W - 30), { dimColor: true }),
      ],
    }))
    if (view.modOpen.has(m.id) && r?.items) {
      const rank = { fail: 0, warn: 1, run: 2, ok: 3, idle: 4 }
      for (const x of [...r.items].sort((a, b) => rank[a.kind] - rank[b.kind]).slice(0, 8)) {
        out.push(Box({
          flexDirection: 'row', columnGap: 1,
          children: [T('    │', { dimColor: true }), T(ICON[x.kind] ?? '·', { color: COLOR[x.kind] }), T(fit(`${x.name}${x.detail ? '  ' + x.detail : ''}`, W - (x.url ? 14 : 8))), ...(x.url ? [Link({ href: x.url, label: 'open' })] : [])],
        }))
      }
      if (r.items.length > 8) out.push(T(`    │ … ${r.items.length - 8} more`, { dimColor: true }))
    }
  }
  if (changeFlags.names.length) out.push(T(fit('⚑ flags in your change: ' + changeFlags.names.join(', '), W), { color: 'magenta' }))
  out.push(Box({
    flexDirection: 'row', columnGap: 2,
    children: [
      Button({ key: 'mod-down', label: 'j ↓', hotkey: 'j', plain: true, dimColor: true, onPress: () => { const i = enabled.findIndex((m) => m.id === view.modSel); view.modSel = enabled[Math.min(enabled.length - 1, i + 1)].id; redraw() } }),
      Button({ key: 'mod-up', label: 'k ↑', hotkey: 'k', plain: true, dimColor: true, onPress: () => { const i = enabled.findIndex((m) => m.id === view.modSel); view.modSel = enabled[Math.max(0, i - 1)].id; redraw() } }),
      Button({ key: 'mod-expand', label: 'e items', hotkey: 'e', plain: true, dimColor: true, onPress: () => { view.modOpen.has(view.modSel) ? view.modOpen.delete(view.modSel) : view.modOpen.add(view.modSel); redraw() } }),
      Button({ key: 'mod-refresh', label: 'r refresh', hotkey: 'r', plain: true, dimColor: true, onPress: () => { mods.at = 0; fetchModules($) } }),
      Button({ key: 'mod-back', label: 'm back to runs', hotkey: 'm', plain: true, dimColor: true, onPress: () => { view.mode = 'runs'; redraw() } }),
    ],
  }))
  return out
}

// /harness capture: the shape of every response the plugin reads, anonymized, saved for tightening fixtures
async function capture($) {
  await refresh($)
  await fetchModules($)
  const snap = {
    plugin: 'harness-platform', captured: new Date(await $.clock.now()).toISOString(), auth: cfg.auth, note: 'Anonymized: names, ids, emails, URLs and SHAs replaced; status values and YAML structure kept.',
    executions: anonymize(data.executions.slice(0, 3)), services: anonymize(data.services.slice(0, 2)), environments: anonymize(data.environments.slice(0, 3)),
    approvals: anonymize([...approvals.values()].flat().slice(0, 2)), inventory_sample: anonymize([...inv.store.values()].slice(0, 2)),
    modules: Object.fromEntries(MODULES.map((m) => [m.id, mods.results.get(m.id)?.error ? { error: '<error>' } : anonymize(mods.raw.get(m.id) ?? [])])),
  }
  const path = (data.git?.root || (await $.session.cwd())) + '/harness-capture.json'
  try {
    await $.fs.write(path, JSON.stringify(snap, null, 2))
    return `Saved an anonymized capture to ${path} (${Object.keys(snap.modules).length} modules, ${data.executions.length ? 'runs, ' : ''}services, environments).\nNo names, ids, emails, URLs or SHAs are in it; check it, then send it over to tighten the fixtures. Don't commit it.`
  } catch (err) {
    return 'Couldn\'t write the capture: ' + String(err?.message ?? err)
  }
}

// ---- Home: suggestions for right now, and every view you can open ------------------------------

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`
const titled = (n, one, many) => (n === 1 ? one : `${n} ${many}`) // titles: "Approval waiting", "2 approvals waiting"
const modItems = (id) => mods.results.get(id)?.items ?? null

// "Build ✓ → Deploy dev ✓ → Approval ◆ → Deploy prod ●": a run's stages, in order
function stageStrip(x) {
  const stages = Object.values(x?.layoutNodeMap ?? {}).filter((n) => !n.nodeGroup || n.nodeGroup === 'STAGE')
  return stages.map((n) => `${n.name} ${n.status === 'NotStarted' || !n.status ? '○' : ICON[statusKind(n.status)]}`).join(' → ')
}

// What deserves attention right now, best first; each opens the view that shows it
function suggestions(now) {
  const S = []
  const repoIds = repoServiceIds()
  const mineSvc = (x) => cdTargets(x).some((t) => repoIds.has(t.service))
  for (const x of data.executions) {
    const k = statusKind(x.status)
    const prod = cdTargets(x).filter((t) => t.envType === 'Production')
    if (k === 'run' && prod.length) S.push({ score: mineSvc(x) ? 100 : 92, kind: 'run', title: 'Production deploy in progress', text: `${runName(x)} · ${[...new Set(prod.map((t) => `${t.serviceName} → ${t.envName}`))].join(', ')} · started ${ago(x.startTs, now)} ago`, strip: stageStrip(x), open: { mode: 'runs', scope: 'all', select: x.planExecutionId } })
  }
  const v = buildView(data, 'mine')
  const h = v.branch?.headRun
  if (h && statusKind(h.status) === 'fail') {
    const d = doneDiag(h.planExecutionId)
    S.push({ score: 95, kind: 'fail', title: 'Your commit failed', text: `${runName(h)} · ${d?.cause || failureMessage(h) || h.status}`, open: { mode: 'runs', scope: 'mine', select: h.planExecutionId, expand: true } })
  } else if (h && statusKind(h.status) === 'run' && !S.some((x) => x.open.select === h.planExecutionId)) {
    S.push({ score: 60, kind: 'run', title: 'Your commit is building', text: `${runName(h)} · ${ago(h.startTs, now)}`, strip: stageStrip(h), open: { mode: 'runs', scope: 'mine', select: h.planExecutionId } })
  }
  const inc = (modItems('incidents') ?? []).filter((x) => x.kind === 'fail')
  if (inc.length) S.push({ score: 93, kind: 'fail', title: titled(inc.length, 'Active incident', 'active incidents'), text: inc.map((x) => x.name).slice(0, 2).join(', '), open: { mode: 'modules', filter: ['incidents', 'alerts'], label: 'operate', expand: 'incidents' } })
  const svcNames = data.services.filter((x) => repoIds.has(x.identifier)).map((x) => repoKey(x.name))
  const alerts = (modItems('alerts') ?? []).filter((x) => x.kind === 'fail')
  const myAlerts = alerts.filter((x) => svcNames.includes(repoKey(x.service)))
  if (alerts.length) S.push({ score: myAlerts.length ? 90 : 58, kind: 'fail', title: myAlerts.length ? 'Alerts on your service' : titled(alerts.length, 'Open alert', 'open alerts'), text: (myAlerts.length ? myAlerts : alerts).map((x) => `${x.name}${x.service ? ' · ' + x.service : ''}`).slice(0, 2).join(', '), open: { mode: 'modules', filter: ['alerts', 'incidents', 'chaos'], label: 'operate', expand: 'alerts' } })
  const waiting = waitingList()
  if (waiting.length) {
    const prodW = waiting.filter((w) => cdTargets(w.x).some((t) => t.envType === 'Production'))
    S.push({ score: prodW.length ? 85 : 72, kind: 'wait', title: titled(waiting.length, 'Approval waiting', 'approvals waiting'), text: waiting.slice(0, 2).map((w) => `${runName(w.x)} → ${[...new Set(cdTargets(w.x).map((t) => t.envName))].join(', ')}${w.a.deadline ? ' (' + expiresIn(w.a.deadline, now) + ')' : ''}`).join(' · '), open: { mode: 'approvals' } })
  }
  const gitBad = (modItems('gitops') ?? []).filter((x) => x.kind === 'fail')
  if (gitBad.length) S.push({ score: 80, kind: 'fail', title: titled(gitBad.length, 'GitOps app degraded', 'GitOps apps degraded'), text: gitBad.map((x) => `${x.name} · ${x.detail}`).slice(0, 2).join(', '), open: { mode: 'modules', filter: ['gitops'], label: 'gitops', expand: 'gitops' } })
  const sec = repoSecurity()
  if (sec.critical) S.push({ score: 78, kind: 'fail', title: titled(sec.critical, 'Critical security issue', 'critical security issues'), text: `on ${sec.targets.join(', ')}`, open: { mode: 'modules', filter: ['security', 'supply_chain', 'policies'], label: 'secure', expand: 'security' } })
  if (freeze?.frozen) S.push({ score: 70, kind: 'warn', title: 'Deployment freeze', text: freezeText(freeze).replace(/^❄ /, ''), open: { mode: 'inventory' } })
  if (pr && summarizeChecks(pr.checks).fail) S.push({ score: 64, kind: 'warn', title: `PR #${pr.number} checks failing`, text: summarizeChecks(pr.checks).failing.slice(0, 3).join(', '), open: { mode: 'runs', scope: 'mine' } })
  // A promotion waiting to happen: the stage before prod runs something prod doesn't
  for (const row of v.matrix.services) {
    const envs = v.matrix.envs
    const pi = envs.findIndex((e) => e.type === 'Production')
    if (pi < 1) continue
    const prodC = row.cells[envs[pi].id], prevC = row.cells[envs[pi - 1].id]
    if (prodC?.artifact && prevC?.artifact && statusKind(prevC.status) === 'ok' && prevC.artifact !== prodC.artifact && prevC.startTs > prodC.startTs) {
      S.push({ score: 30, kind: 'idle', title: 'Ready to promote', text: `${row.name}: ${envs[pi - 1].name} runs ${prevC.artifact}, prod runs ${prodC.artifact}`, open: { mode: 'inventory' } })
      break
    }
  }
  return S.sort((a, b) => b.score - a.score)
}

// Every place to go from home, with a live one-line badge
function homeViews(now) {
  const v = buildView(data, 'mine')
  const h = v.branch?.headRun
  // Empty modules stay out of the badge: "⊛ 3 issues" matters, "⎈ 0 apps" is noise
  const sevOf = (id) => { const r = mods.results.get(id); return r?.items?.length ? moduleSummary(MODULES.find((m) => m.id === id), r.items) : null }
  const merge = (ids) => {
    const parts = ids.map((id) => { const m = MODULES.find((x) => x.id === id); const sum = sevOf(id); return sum ? { k: sum.kind, t: `${m.icon} ${sum.text}` } : null }).filter(Boolean)
    const rank = { fail: 0, warn: 1, run: 2, ok: 3, idle: 4 }
    const loaded = ids.some((id) => mods.results.get(id)?.items)
    return parts.length ? { kind: parts.sort((a, b) => rank[a.k] - rank[b.k])[0].k, text: parts.map((p) => p.t).join(' · ') } : { kind: 'idle', text: loaded ? 'nothing to report' : mods.at ? 'unavailable' : 'loading…' }
  }
  const waiting = waitingList()
  const lanes = v.matrix.services
  return [
    { id: 'change', label: 'Your change', open: { mode: 'runs', scope: 'mine' }, kind: h ? statusKind(h.status) : 'idle',
      text: [h ? `${runName(h)} ${h.status}` : isCdOnly() ? 'CD-only repo' : data.git ? 'HEAD not built yet' : 'not in a git repo', pr ? prLine(pr) : '', changeFlags.names.length ? `⚑ ${changeFlags.names.join(', ')}` : ''].filter(Boolean).join(' · ') },
    { id: 'deployments', label: 'Deployments', open: { mode: 'inventory' }, kind: data.executions.some((x) => statusKind(x.status) === 'run' && cdTargets(x).length) ? 'run' : 'idle',
      text: [`${plural(new Set(data.executions.flatMap((x) => cdTargets(x).map((t) => t.service))).size, 'service', 'services')} deployed recently`, typeof behind === 'number' ? (behind ? `prod ${behind} behind` : 'prod current') : '', freeze?.frozen ? freezeText(freeze) : ''].filter(Boolean).join(' · ') },
    { id: 'approvals', label: 'Approvals', open: { mode: 'approvals' }, kind: waiting.length ? 'wait' : 'idle', text: waiting.length ? `${plural(waiting.length, 'waiting', 'waiting')}${waiting.some((w) => cdTargets(w.x).some((t) => t.envType === 'Production')) ? ' (production)' : ''}` : 'none waiting' },
    { id: 'service', label: 'Service', open: { mode: 'service' }, kind: 'idle', text: lanes.length ? `${lanes.map((r) => r.name).slice(0, 3).join(', ')}: versions, health, security, owner` : 'no services from this repo' },
    { id: 'secure', label: 'Security', open: { mode: 'modules', filter: ['security', 'supply_chain', 'policies'], label: 'secure' }, ...merge(['security', 'supply_chain', 'policies']) },
    { id: 'operate', label: 'Operate', open: { mode: 'modules', filter: ['alerts', 'incidents', 'chaos'], label: 'operate' }, ...merge(['alerts', 'incidents', 'chaos']) },
    { id: 'platform', label: 'Platform', open: { mode: 'modules', filter: ['gitops', 'releases', 'iacm', 'cost', 'catalog', 'registry', 'database', 'flags'], label: 'platform' }, ...merge(['gitops', 'iacm', 'cost', 'releases']) },
    { id: 'all', label: 'All modules', open: { mode: 'modules' }, kind: 'idle', text: `${MODULES.filter((m) => cfg.modules.includes(m.id)).length} Harness modules` },
    { id: 'project', label: 'Project runs', open: { mode: 'runs', scope: 'all' }, kind: 'idle', text: `${plural(data.executions.length, 'recent run', 'recent runs')} in ${cfg.org_id}/${cfg.project_id}` },
  ]
}

function openTarget($, t) {
  view.modFilter = null
  if (t.mode === 'runs') {
    view.mode = 'runs'
    if (t.scope) scope = t.scope
    if (t.select) { view.selected = t.select; if (t.expand) { view.expanded.add(t.select); view.collapsed.delete(t.select) } }
  } else if (t.mode === 'inventory') { openInventory($); return }
  else if (t.mode === 'modules') {
    view.mode = 'modules'
    view.modFilter = t.filter ?? null
    view.modFilterLabel = t.label ?? ''
    view.modOpen ??= new Set()
    if (t.expand) { view.modSel = t.expand; view.modOpen.add(t.expand) }
    mods.usedAt = updatedAt
    if (!mods.at) fetchModules($)
  } else view.mode = t.mode
  $.ui.invalidate('ui.render')
}

function renderHome($, el, T, W, now) {
  const { Box, Button } = el
  const S = suggestions(now).slice(0, 3)
  const V = homeViews(now)
  const rows = [...S.map((x) => ({ type: 's', ...x })), ...V.map((x) => ({ type: 'v', ...x }))]
  view.homeSel = Math.min(view.homeSel, rows.length - 1)
  const redraw = () => $.ui.invalidate('ui.render')
  const out = [section(T, W, 'SUGGESTED NOW')]
  if (!S.length) out.push(T(updatedAt ? '✓ All quiet: nothing is running in production, nothing needs you.' : 'Loading…', { color: updatedAt ? 'green' : undefined, dimColor: !updatedAt }))
  rows.forEach((r, i) => {
    if (r.type === 'v' && (i === 0 || rows[i - 1].type === 's')) out.push(section(T, W, 'VIEWS'))
    const sel = i === view.homeSel
    const n = r.type === 'v' ? V.indexOf(V.find((x) => x.id === r.id)) + 1 : 0
    out.push(Box({
      key: 'home-' + (r.type === 's' ? 's' + i : r.id), flexDirection: 'row', columnGap: 1,
      children: [
        T(sel ? '❯' : ' ', { color: 'blue' }),
        r.type === 'v' ? Button({ key: 'view-' + r.id, label: String(n), hotkey: String(n), plain: true, dimColor: true, onPress: () => { openTarget($, r.open) } }) : T(r.kind === 'wait' ? '◆' : ICON[r.kind] ?? '·', { color: COLOR[r.kind] }),
        T(pad(r.type === 's' ? r.title : r.label, r.type === 's' ? 30 : 14), { bold: true, inverse: sel, color: r.type === 's' ? COLOR[r.kind] : undefined }),
        T(fit(r.text, W - (r.type === 's' ? 36 : 20)), { color: r.type === 'v' && r.kind !== 'idle' && r.kind !== 'ok' ? COLOR[r.kind] : undefined, dimColor: r.type === 'v' && r.kind === 'idle' }),
      ],
    }))
    if (r.type === 's' && r.strip) out.push(T(fit('     ' + r.strip, W), { color: COLOR[r.kind], dimColor: !sel }))
  })
  out.push(Box({
    flexDirection: 'row', columnGap: 2,
    children: [
      Button({ key: 'home-down', label: 'j ↓', hotkey: 'j', plain: true, dimColor: true, onPress: () => { view.homeSel = Math.min(rows.length - 1, view.homeSel + 1); redraw() } }),
      Button({ key: 'home-up', label: 'k ↑', hotkey: 'k', plain: true, dimColor: true, onPress: () => { view.homeSel = Math.max(0, view.homeSel - 1); redraw() } }),
      Button({ key: 'home-open', label: 'e open', hotkey: 'e', plain: true, dimColor: true, onPress: () => { openTarget($, rows[view.homeSel].open) } }),
      T('1–9 jump · o home from anywhere', { dimColor: true }),
    ],
  }))
  return out
}

// One card per service from this repo: versions, GitOps, health, security, owner, your change
function renderServicePage($, el, T, W, now) {
  const { Box, Button } = el
  const v = buildView(data, 'mine')
  const lanes = laneData(v, now)
  if (!lanes.length) return [section(T, W, 'SERVICE'), T('No services from this repo yet: open Deployments (2 on Home) for the whole project.', { dimColor: true })]
  view.svcIdx = Math.min(view.svcIdx, lanes.length - 1)
  const lane = lanes[view.svcIdx]
  const svc = v.matrix.services[view.svcIdx]
  const owner = (modItems('catalog') ?? []).find((x) => repoKey(x.name) === repoKey(lane.name) || repoKey(x.name) === repoKey(svc.id))?.owner
  const row = (label, text, style = {}) => Box({ flexDirection: 'row', columnGap: 1, children: [T(pad(label, 12), { bold: true }), T(fit(text, W - 14), style)] })
  const out = [section(T, W, `${lane.name.toUpperCase()}${owner ? ' · owner ' + owner : ''}${lanes.length > 1 ? ` · ${view.svcIdx + 1}/${lanes.length}` : ''}`)]
  out.push(row('versions', lane.segs.map((g) => `${g.label}${g.cell}${g.sub ? ' (' + g.sub + ')' : ''}`).join('  ─▶  ')))
  const gitops = (modItems('gitops') ?? []).filter((x) => x.service === svc.id || repoKey(x.name).startsWith(repoKey(lane.name)))
  if (gitops.length) out.push(row('gitops', gitops.map((g) => `${g.env || g.name} ${ICON[g.kind] ?? '·'} ${g.detail}`).join('   '), { color: COLOR[[...gitops].sort((a, b) => ({ fail: 0, warn: 1 }[a.kind] ?? 2) - ({ fail: 0, warn: 1 }[b.kind] ?? 2))[0].kind] }))
  const alerts = (modItems('alerts') ?? []).filter((x) => x.kind === 'fail' && repoKey(x.service) === repoKey(lane.name))
  out.push(row('health', alerts.length ? `◉ ${plural(alerts.length, 'open alert', 'open alerts')}: ${alerts.map((x) => x.name).join(', ')}` : modItems('alerts') ? 'no open alerts' : 'alerts unavailable', alerts.length ? { color: 'red' } : { dimColor: !modItems('alerts') }))
  const sec = (modItems('security') ?? []).filter((x) => [lane.name, data.git?.name || ''].some((n) => n && repoKey(x.target) === repoKey(n)))
  const crit = sec.filter((x) => x.kind === 'fail')
  out.push(row('security', modItems('security') ? `${crit.length} critical${crit[0] ? ` (${crit[0].name})` : ''} · ${sec.filter((x) => x.kind === 'warn').length} high` : 'security unavailable', crit.length ? { color: 'red' } : { dimColor: !modItems('security') }))
  if (changeFlags.names.length) out.push(row('flags', changeFlags.names.join(', ') + ' in your change', { color: 'magenta' }))
  const h = v.branch?.headRun
  out.push(row('your change', h ? `${ICON[statusKind(h.status)]} ${runName(h)} ${h.status}${pr ? ' · ' + prLine(pr) : ''}` : isCdOnly() ? 'CD-only: manifest changes show under versions' : 'not built yet', h ? { color: COLOR[statusKind(h.status)] } : { dimColor: true }))
  out.push(Box({ flexDirection: 'row', columnGap: 2, children: [
    ...(lanes.length > 1 ? [Button({ key: 'svc-next', label: 'j next service', hotkey: 'j', plain: true, dimColor: true, onPress: () => { view.svcIdx = (view.svcIdx + 1) % lanes.length; $.ui.invalidate('ui.render') } })] : []),
    Button({ key: 'svc-inv', label: 'e every environment', hotkey: 'e', plain: true, dimColor: true, onPress: () => { view.invSel = svc.id; view.invOpen.add(svc.id); openInventory($) } }),
  ] }))
  return out
}
