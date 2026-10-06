// Pure functions only: nothing here touches `$`, so tests can call them directly.
// Field names follow the Harness NG pipeline execution summary (verified against live data).

// ---- Status ---------------------------------------------------------------

const KIND = {
  Success: 'ok',
  Failed: 'fail', Aborted: 'fail', Expired: 'fail', Errored: 'fail', ApprovalRejected: 'fail', AbortedByFreeze: 'fail',
  IgnoreFailed: 'warn', Skipped: 'idle', NotStarted: 'idle', Discontinuing: 'warn',
  Running: 'run', AsyncWaiting: 'run', TaskWaiting: 'run', TimedWaiting: 'run', Waiting: 'run',
  ApprovalWaiting: 'wait', InterventionWaiting: 'wait', InputWaiting: 'wait', Paused: 'wait', Pausing: 'wait',
  Queued: 'run', QueuedLicenseLimitReached: 'run', QueuedExecutionConcurrencyReached: 'run', ResourceWaiting: 'run', WaitStepRunning: 'run',
}
export function statusKind(status) {
  return KIND[status] ?? 'idle'
}
export const ICON = { ok: '✓', fail: '✗', warn: '!', run: '●', wait: '◆', idle: '·' }
export const COLOR = { ok: 'green', fail: 'red', warn: 'yellow', run: 'cyan', wait: 'magenta' }
export const isTerminal = (kind) => kind === 'ok' || kind === 'fail' || kind === 'warn' || kind === 'idle'

// ---- Small helpers ----------------------------------------------------------

export function ago(ms, now) {
  if (!ms) return ''
  const m = Math.floor((now - ms) / 60000)
  if (m < 1) return 'now'
  if (m < 60) return m + 'm'
  if (m < 1440) return Math.floor(m / 60) + 'h'
  return Math.floor(m / 1440) + 'd'
}

export const short = (sha) => (sha ? String(sha).slice(0, 7) : '')

// Truncate to n columns with an ellipsis (code points, not UTF-16 units)
export function fit(s, n) {
  const chars = Array.from(String(s ?? ''))
  if (n <= 0) return ''
  if (chars.length <= n) return chars.join('')
  return chars.slice(0, Math.max(0, n - 1)).join('') + '…'
}
export function pad(s, n) {
  const f = fit(s, n)
  return f + ' '.repeat(Math.max(0, n - Array.from(f).length))
}

// PAT/SAT tokens look like pat.<accountId>.<tokenId>.<secret>
export function accountFromKey(key) {
  const parts = String(key ?? '').split('.')
  return (parts[0] === 'pat' || parts[0] === 'sat') && parts.length >= 4 ? parts[1] : ''
}

// "https://github.com/acme/Guest-Flow.git", "git@github.com:acme/guest-flow", "org.guest-flow" → "guest-flow"
export function repoKey(s) {
  if (!s) return ''
  let last = String(s).trim().replace(/\/+$/, '').split(/[/:]/).pop() ?? ''
  last = last.replace(/\.git$/i, '').replace(/^(org|account)\./i, '')
  return last.toLowerCase().replace(/_/g, '-')
}

// ---- Execution parsing ----------------------------------------------------

export function execCi(x) {
  const ci = x?.moduleInfo?.ci
  if (!ci) return null
  const st = ci.ciPipelineStageModuleInfo ?? {}
  const branches = [st.sourceBranch, ci.branch, st.branch].filter(Boolean)
  return {
    branch: st.sourceBranch || ci.branch || st.branch || '',
    branches,
    commit: st.commitId || ci.ciExecutionInfoDTO?.branch?.commits?.[0]?.id || '',
    message: (st.commitMessage || '').split('\n')[0],
    repo: st.repoName || ci.repoName || '',
    prNumber: ci.ciExecutionInfoDTO?.pullRequest?.number ?? null,
  }
}

export function execRepoKeys(x) {
  const ci = x?.moduleInfo?.ci
  const keys = new Set()
  if (!ci) return keys
  const st = ci.ciPipelineStageModuleInfo ?? {}
  for (const v of [ci.repoName, st.repoName, st.repoUrl]) if (v) keys.add(repoKey(v))
  for (const d of ci.scmDetailsList ?? ci.ciExecutionInfoDTO?.scmDetailsList ?? []) if (d?.scmUrl) keys.add(repoKey(d.scmUrl))
  keys.delete('')
  return keys
}

// One entry per deployment stage: which service went to which environment, with what artifact
export function cdTargets(x) {
  const out = []
  for (const node of Object.values(x?.layoutNodeMap ?? {})) {
    const cd = node?.moduleInfo?.cd
    if (node?.module !== 'cd' || !cd?.serviceInfo) continue
    const svc = cd.serviceInfo
    const infra = cd.infraExecutionSummary ?? {}
    const art = svc.artifacts?.primary ?? {}
    out.push({
      service: svc.identifier,
      serviceName: svc.displayName || svc.identifier,
      env: infra.identifier || '',
      envName: infra.name || infra.identifier || '',
      envType: infra.type || '',
      infra: infra.infrastructureName || '',
      artifact: art.tag || svc.artifacts?.artifactDisplayName || '',
      status: node.status,
      startTs: node.startTs || x.startTs,
      endTs: node.endTs || 0,
    })
  }
  // Older summaries carry only the pipeline-level lists
  if (!out.length && x?.moduleInfo?.cd) {
    const cd = x.moduleInfo.cd
    const svcs = cd.serviceIdentifiers ?? []
    const envs = cd.envIdentifiers ?? []
    for (const s of svcs) for (const [i, env] of envs.entries())
      out.push({ service: s, serviceName: s, env, envName: env, envType: cd.environmentTypes?.[i] ?? '', infra: '', artifact: '', status: x.status, startTs: x.startTs, endTs: x.endTs })
  }
  return out
}

export function failureMessage(x) {
  if (statusKind(x?.status) !== 'fail' && x?.status !== 'IgnoreFailed') return ''
  const nodes = Object.values(x?.layoutNodeMap ?? {}).filter((n) => n?.failureInfo?.message)
  const n = nodes.find((n) => statusKind(n.status) === 'fail') ?? nodes[0]
  return n ? `${n.name}: ${n.failureInfo.message}` : ''
}

export function execUrl(c, x) {
  if (x?.openInHarness) return x.openInHarness
  const u = `${c.base_url}/ng/account/${c.account_id}/all/orgs/${c.org_id}/projects/${c.project_id}` +
    `/pipelines/${encodeURIComponent(x.pipelineIdentifier)}/deployments/${encodeURIComponent(x.planExecutionId)}/pipeline`
  try { return new URL(u).href } catch { return '' }
}

export function projectUrl(c) {
  try { return new URL(`${c.base_url}/ng/account/${c.account_id}/all/orgs/${c.org_id}/projects/${c.project_id}/deployments`).href } catch { return '' }
}

// Manifests in a service YAML: store type, connector, repo, branch, and the paths they read
export function parseManifests(yaml) {
  const lines = String(yaml ?? '').split('\n')
  const start = lines.findIndex((l) => /^\s*manifests:\s*$/.test(l))
  if (start === -1) return []
  const base = lines[start].search(/\S/)
  const out = []
  let cur = null
  let listKey = ''
  let listIndent = -1
  const val = (l) => l.replace(/^[^:]+:\s*/, '').replace(/^["']|["']\s*$/g, '').trim()
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]
    if (!l.trim()) continue
    const ind = l.search(/\S/)
    if (ind <= base) break
    if (/^\s*-\s+manifest:\s*$/.test(l)) { cur = { storeType: '', connectorRef: '', repoName: '', branch: '', paths: [] }; out.push(cur); listKey = ''; continue }
    if (!cur) continue
    if (listKey && ind > listIndent && /^\s*-\s+/.test(l)) { cur.paths.push(l.replace(/^\s*-\s+/, '').replace(/^["']|["']$/g, '').trim()); continue }
    listKey = ''
    const k = /^\s*(?:-\s+)?([A-Za-z]+):/.exec(l)?.[1]
    if (!k) continue
    if (k === 'paths' || k === 'valuesPaths' || k === 'files') { listKey = k; listIndent = ind; continue }
    if (k === 'folderPath') cur.paths.push(val(l))
    else if (k === 'connectorRef') cur.connectorRef = val(l)
    else if (k === 'repoName') cur.repoName = val(l)
    else if (k === 'branch') cur.branch = val(l)
    else if (k === 'type' && /store:\s*$/.test(lines[i - 1] ?? '')) cur.storeType = val(l)
  }
  return out.map((m) => ({ ...m, paths: m.paths.filter((p) => p && !p.startsWith('<+')) }))
}

// "account.gh" / "org.gh" / "gh" → which scope to read the connector from
export function connectorScope(ref) {
  const m = /^(account|org)\.(.+)$/.exec(String(ref ?? ''))
  return m ? { id: m[2], scope: m[1] } : { id: String(ref ?? ''), scope: 'project' }
}

// Is this manifest stored in the repo with this key? Repo-level connectors carry the repo in their URL.
export function manifestInRepo(m, key, connectors) {
  if (!key) return false
  if (m.repoName && repoKey(m.repoName) === key) return true
  const c = connectors?.get?.(m.connectorRef)
  if (c?.url && c.type === 'Repo' && repoKey(c.url) === key) return true
  if (c?.url && c.type === 'Account' && m.repoName && repoKey(m.repoName) === key) return true
  return false
}

// Services whose manifests live in this repo (service YAML, resolving connectors when known)
export function servicesInRepo(services, key, connectors) {
  if (!key) return new Set()
  const out = new Set()
  for (const s of services ?? []) {
    const y = String(s?.yaml ?? '')
    const names = [...y.matchAll(/repoName:\s*["']?([^\s"']+)/g)].map((m) => repoKey(m[1]))
    const urls = [...y.matchAll(/(?:repoUrl|url):\s*["']?([^\s"']+)/g)].map((m) => repoKey(m[1]))
    if ([...names, ...urls].includes(key) || parseManifests(y).some((m) => manifestInRepo(m, key, connectors))) out.add(s.identifier)
  }
  return out
}

// The manifest paths of a service that live in this repo (for "changes not yet deployed")
export function repoManifestPaths(service, key, connectors) {
  const paths = parseManifests(service?.yaml).filter((m) => manifestInRepo(m, key, connectors)).flatMap((m) => m.paths)
  return [...new Set(paths.map((p) => p.replace(/^\/+/, '')))].filter(Boolean)
}

// ---- The view: everything the pane, status line and tool show ----------------

/**
 * @param {{executions:any[], services:any[], environments:any[], git:any, me:string|null}} data
 * @param {'mine'|'all'} scope
 */
export function buildView(data, scope) {
  const git = data.git
  const key = git?.name || ''
  const executions = data.executions ?? []

  // "Mine": runs built from this repo or that deployed this repo's services.
  // If the repo has no runs (or there's no repo), fall back to runs you triggered, then to the project.
  const repoSvcs = servicesInRepo(data.services ?? [], key, data.connectors)
  for (const x of executions) if (key && execRepoKeys(x).has(key)) for (const t of cdTargets(x)) repoSvcs.add(t.service)
  const byRepo = executions.filter((x) => (key && execRepoKeys(x).has(key)) || cdTargets(x).some((t) => repoSvcs.has(t.service)))
  const byMe = data.me ? executions.filter((x) => x?.executionTriggerInfo?.triggeredBy?.extraInfo?.email === data.me) : []
  const mine = byRepo.length ? byRepo : byMe
  const mineBasis = byRepo.length ? 'repo' : byMe.length ? 'me' : null
  const hasMine = mine.length > 0
  const scoped = scope === 'mine' && hasMine ? mine : executions

  // This branch: newest run on the current branch, and whether HEAD has been built
  let branch = null
  if (git?.branch) {
    const onBranch = executions.filter((x) => execRepoKeys(x).has(key) && (execCi(x)?.branches ?? []).includes(git.branch))
    const headRun = git.head ? onBranch.find((x) => execCi(x)?.commit === git.head) : null
    branch = { name: git.branch, head: git.head, latest: onBranch[0] ?? null, headRun: headRun ?? null, count: onBranch.length }
  }

  // Deploy matrix: newest deployment per service × environment, scoped like the list
  const cells = new Map()
  const svcNames = new Map()
  const envMeta = new Map((data.environments ?? []).map((e) => [e.identifier, { name: e.name, type: e.type }]))
  for (const x of scoped) {
    for (const t of cdTargets(x)) {
      if (!t.env) continue
      svcNames.set(t.service, t.serviceName)
      if (!envMeta.has(t.env)) envMeta.set(t.env, { name: t.envName, type: t.envType })
      const k = t.service + '\u0000' + t.env
      if (!cells.has(k)) cells.set(k, { ...t, execution: x })
    }
  }
  const usedEnvs = new Set([...cells.values()].map((c) => c.env))
  const envs = laneSort([...usedEnvs].map((id) => ({ id, ...envMeta.get(id) })))
  const services = [...svcNames.entries()].map(([id, name]) => ({
    id, name, cells: Object.fromEntries(envs.map((e) => [e.id, cells.get(id + '\u0000' + e.id) ?? null])),
  }))

  const counts = { running: 0, failed: 0, waiting: 0 }
  for (const x of scoped) {
    const k = statusKind(x.status)
    if (k === 'run') counts.running++
    else if (k === 'fail') counts.failed++
    else if (k === 'wait') counts.waiting++
  }

  return {
    scope: scope === 'mine' && hasMine ? 'mine' : 'all',
    mineBasis,
    scopeFellBack: scope === 'mine' && mineBasis !== 'repo',
    git, branch, executions: scoped, counts,
    matrix: { envs, services },
    environments: laneSort((data.environments ?? []).map((e) => ({ id: e.identifier, name: e.name, type: e.type }))),
  }
}

// Compact JSON for the tool Claude calls
export function toolSummary(v, c, now, extra = {}) {
  const dx = (id) => { const d = extra.diagnoses?.get?.(id); return d?.state === 'done' ? { cause: d.cause, fix: d.fix || undefined, confidence: d.confidence } : undefined }
  const run = (x) => ({
    id: x.planExecutionId, pipeline: x.pipelineIdentifier, name: x.name, run: x.runSequence, status: x.status,
    started: x.startTs ? new Date(x.startTs).toISOString() : null,
    branch: execCi(x)?.branch || undefined, commit: short(execCi(x)?.commit) || undefined,
    deploys: cdTargets(x).map((t) => `${t.service}→${t.env}${t.artifact ? ' (' + t.artifact + ')' : ''}`),
    failure: failureMessage(x) || undefined, diagnosis: dx(x.planExecutionId), url: execUrl(c, x),
  })
  return {
    project: `${c.org_id}/${c.project_id}`, scope: v.scope === 'mine' ? (v.mineBasis === 'me' ? 'runs you triggered' : 'this repo') : 'project', as_of: new Date(now).toISOString(),
    git: v.git ? { repo: v.git.name, branch: v.git.branch, head: short(v.git.head) } : null,
    this_branch: v.branch && {
      latest: v.branch.latest && run(v.branch.latest),
      head_built: v.branch.headRun ? v.branch.headRun.status : v.branch.head ? 'not built yet' : 'unknown',
    },
    counts: v.counts,
    prod_commits_behind_head: typeof extra.behind === 'number' ? extra.behind : undefined,
    executions: v.executions.slice(0, 15).map(run),
    deployed: v.matrix.services.map((s) => ({
      service: s.name,
      environments: Object.fromEntries(Object.entries(s.cells).filter(([, c]) => c).map(([env, c]) => [env, { status: c.status, artifact: c.artifact, when: c.startTs ? new Date(c.startTs).toISOString() : null }])),
    })),
    environments: v.environments,
  }
}

// Plain-text report for places where nothing can be drawn (claude -p, VS Code chat panel)
export function textReport(v, c, now, extra = {}) {
  const L = []
  L.push(`Harness ${c.org_id}/${c.project_id} — ${v.scope === 'mine' ? (v.mineBasis === 'me' ? 'runs you triggered' : 'this repo') : 'whole project'}`)
  if (v.branch) {
    const h = v.branch.headRun
    L.push(`Branch ${v.git.name} @ ${v.branch.name}, HEAD ${short(v.branch.head) || '?'}: ` +
      (h ? `${ICON[statusKind(h.status)]} ${h.status} (#${h.runSequence}, ${ago(h.startTs, now)} ago) ${execUrl(c, h)}` : v.branch.latest ? 'not built yet' : 'no runs on this branch'))
  }
  if (typeof extra.behind === 'number') L.push(`Prod is ${extra.behind} commit${extra.behind === 1 ? '' : 's'} behind HEAD`)
  L.push(`Pipelines: ${v.counts.running} running, ${v.counts.waiting} waiting, ${v.counts.failed} failed`)
  for (const x of v.executions.slice(0, 10)) {
    const t = cdTargets(x).map((d) => `${d.serviceName}→${d.envName}`).join(', ')
    const ci = execCi(x)
    L.push(`  ${ICON[statusKind(x.status)]} ${x.name ?? x.pipelineIdentifier} #${x.runSequence ?? ''} ${x.status} ${ago(x.startTs, now)} — ${t || (ci ? ci.branch + '@' + short(ci.commit) : '')}`)
    const d = extra.diagnoses?.get?.(x.planExecutionId)
    const msg = failureMessage(x)
    if (d?.state === 'done') L.push(`      ↳ ${d.cause}${d.fix ? ` — fix: ${d.fix}` : ''}`)
    else if (msg) L.push(`      ↳ ${fit(msg, 160)}`)
  }
  if (v.matrix.services.length) {
    L.push('Deployed:')
    for (const s of v.matrix.services) {
      const cells = v.matrix.envs.map((e) => { const d = s.cells[e.id]; return d ? `${e.name}: ${ICON[statusKind(d.status)]} ${d.artifact || d.status} (${ago(d.startTs, now)})` : null }).filter(Boolean)
      L.push(`  ${s.name} — ${cells.join(' | ')}`)
    }
  }
  if (v.environments.length) L.push('Environments: ' + v.environments.map((e) => e.name + (e.type === 'Production' ? ' (prod)' : '')).join(', '))
  return L.join('\n')
}

// ---- Failure diagnosis --------------------------------------------------------

// Failed stages (summary, verified shape) plus failed steps (execution graph, when fetched)
export function failedSteps(x, graph) {
  const out = []
  for (const n of Object.values(x?.layoutNodeMap ?? {})) {
    if (statusKind(n?.status) !== 'fail' && n?.status !== 'IgnoreFailed') continue
    out.push({
      level: 'stage', name: n.name, status: n.status, message: n.failureInfo?.message || '',
      codes: (n.failureInfoDTO?.responseMessages ?? []).map((m) => m?.code).filter(Boolean),
      types: n.failureInfoDTO?.failureTypeList ?? [],
    })
  }
  for (const n of Object.values(graph?.executionGraph?.nodeMap ?? {})) {
    if (statusKind(n?.status) !== 'fail') continue
    if (!n?.failureInfo?.message && !n?.logBaseKey) continue
    out.push({
      level: 'step', name: n.name || n.identifier, stepType: n.stepType || '', status: n.status,
      message: n.failureInfo?.message || '', logKey: n.logBaseKey || '',
      codes: (n.failureInfo?.responseMessages ?? []).map((m) => m?.code).filter(Boolean),
    })
  }
  return out
}

// Log service answers NDJSON lines like {"out":"…","level":"INFO"}; keep the tail
export function logTail(text, lines = 60) {
  const out = []
  for (const raw of String(text ?? '').split('\n')) {
    if (!raw.trim()) continue
    try { const j = JSON.parse(raw); out.push(String(j.out ?? j.message ?? '').replace(/\s+$/, '')) } catch { out.push(raw) }
  }
  return out.filter(Boolean).slice(-lines).join('\n').slice(-6000)
}

export const DIAGNOSIS_SYSTEM =
  'You diagnose failed CI/CD pipeline runs for a developer. Reply with only a JSON object, no prose, no code fences: ' +
  '{"cause": "<the root cause in one sentence, max 120 chars>", "evidence": "<the single most telling log line or error, max 160 chars>", ' +
  '"fix": "<the most likely fix in one sentence, max 160 chars>", "confidence": "high|medium|low"}. ' +
  'Be specific (name the step, resource, limit or test). If the information is insufficient, say so in cause and set confidence to low.'

export function diagnosisPrompt(x, steps, tail, git) {
  const ci = execCi(x)
  const lines = [
    `Pipeline: ${x.name ?? x.pipelineIdentifier} #${x.runSequence ?? ''} — status ${x.status}`,
    ci ? `Built: ${ci.repo || ''} ${ci.branch}@${short(ci.commit)} "${ci.message}"` : '',
    cdTargets(x).length ? 'Deploys: ' + cdTargets(x).map((t) => `${t.serviceName}→${t.envName} (${t.artifact || 'no artifact'}, ${t.status})`).join(', ') : '',
    git?.head && ci?.commit === git.head ? 'This is the developer\'s current HEAD commit.' : '',
    'Failures:',
    ...steps.map((s) => `- ${s.level} "${s.name}"${s.stepType ? ` (${s.stepType})` : ''}: ${s.status}${s.message ? ` — ${s.message}` : ''}${s.codes?.length ? ` [${s.codes.join(', ')}]` : ''}`),
    tail ? `\nLast log lines of the failed step:\n${tail}` : '\nNo step log was available.',
  ]
  return lines.filter(Boolean).join('\n')
}

export function parseDiagnosis(text) {
  const s = String(text ?? '').replace(/```(?:json)?/g, '').trim()
  const start = s.indexOf('{'); const end = s.lastIndexOf('}')
  try {
    const j = JSON.parse(s.slice(start, end + 1))
    if (typeof j.cause === 'string' && j.cause.trim()) {
      return { cause: fit(j.cause.trim(), 160), evidence: fit(String(j.evidence ?? '').trim(), 200), fix: fit(String(j.fix ?? '').trim(), 200), confidence: ['high', 'medium', 'low'].includes(j.confidence) ? j.confidence : 'medium' }
    }
  } catch { /* fall through */ }
  return s ? { cause: fit(s.split('\n')[0], 160), evidence: '', fix: '', confidence: 'low' } : null
}

// ---- Guards ---------------------------------------------------------------

// `git push`, `git -C dir push`, `git -c k=v push`, `cd x && git push`; not `git push-foo` or `git log --grep push`
export const isGitPush = (cmd) => /(^|[;&|(]\s*|\s)git\s+(?:(?:-C|-c)\s+\S+\s+|--?[A-Za-z][\w-]*(?:=\S+)?\s+)*push(?![\w-])/.test(String(cmd ?? ''))

// A Harness MCP tool that changes something (any server name containing "harness")
export function isHarnessWrite(tool) {
  const m = /^mcp__(.+?)__harness_(execute|create|update|delete)$/.exec(String(tool ?? ''))
  return Boolean(m && /harness/i.test(m[1]))
}

// Which production environments a tool call's arguments mention
export function prodTargets(args, environments) {
  const text = JSON.stringify(args ?? {}).toLowerCase()
  const hits = new Set()
  for (const e of environments ?? []) {
    if (e?.type !== 'Production') continue
    const id = String(e.identifier ?? e.id ?? '').toLowerCase()
    const name = String(e.name ?? '').toLowerCase()
    const re = (w) => new RegExp(`(^|[^a-z0-9_-])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9_-])`)
    if ((id && re(id).test(text)) || (name && re(name).test(text))) hits.add(e.name || e.identifier)
  }
  if (/(^|[^a-z0-9])(production|prod)([^a-z0-9]|$)/.test(text)) hits.add(hits.size ? [...hits][0] : 'prod')
  return [...hits]
}

// ---- Commits behind prod ------------------------------------------------------

// Commit of the newest *successful* production deploy of a service built from this repo
export function prodCommit(executions, key) {
  for (const x of executions ?? []) {
    if (key && !execRepoKeys(x).has(key)) continue
    const ci = execCi(x)
    if (!ci?.commit) continue
    if (cdTargets(x).some((t) => t.envType === 'Production' && t.status === 'Success')) return { commit: ci.commit, run: x }
  }
  return null
}

// ---- Automatic context ----------------------------------------------------------

export const wantsContext = (text) => /\b(deploy\w*|build\w*|pipeline\w*|ci|cd|ci\/cd|release\w*|prod|production|staging|rollback|roll back|harness|push)\b/i.test(String(text ?? ''))

export function contextLine(v, extra = {}) {
  const parts = []
  if (v.branch) {
    const r = v.branch.headRun ?? v.branch.latest
    const which = v.branch.headRun ? 'HEAD' : 'latest run'
    parts.push(`${v.git.name}@${v.branch.name} (HEAD ${short(v.branch.head)}): ` + (r
      ? `${which} is ${r.name ?? r.pipelineIdentifier} #${r.runSequence} ${r.status}` + (failureMessage(r) ? ` (${fit(failureMessage(r), 140)})` : '') + (extra.diagnoses?.get(r.planExecutionId)?.cause ? ` — diagnosis: ${extra.diagnoses.get(r.planExecutionId).cause}` : '')
      : 'no Harness runs for this branch yet'))
  }
  for (const s of v.matrix.services.slice(0, 3)) {
    const cells = v.matrix.envs.map((e) => s.cells[e.id] ? `${e.name} ${s.cells[e.id].artifact || ''} ${s.cells[e.id].status}`.replace(/\s+/g, ' ') : null).filter(Boolean)
    if (cells.length) parts.push(`${s.name}: ${cells.join(', ')}`)
  }
  if (typeof extra.behind === 'number') parts.push(`prod is ${extra.behind} commit${extra.behind === 1 ? '' : 's'} behind HEAD`)
  if (extra.pr) parts.push(extra.pr)
  if (extra.freeze) parts.push(`deployment freeze active: ${extra.freeze.replace(/^❄ /, '')}`)
  if (!parts.length) return ''
  return `[Harness, from the harness-cicd plugin] ${parts.join('; ')}. Call the harness_status tool for details.`
}

export function autoFixPrompt(x, diag, attempt, max, url) {
  const msg = failureMessage(x)
  return `Harness run "${x.name ?? x.pipelineIdentifier}" #${x.runSequence} failed on your commit${msg ? ` (${msg})` : ''}.` +
    (diag?.cause ? `\nDiagnosis: ${diag.cause}${diag.fix ? `\nLikely fix: ${diag.fix}` : ''}` : '') +
    `\nExecution: ${url}\nAuto-fix attempt ${attempt} of ${max}: find the cause (use the Harness MCP tools such as harness_diagnose if they are connected), ` +
    'make the smallest fix in this repo, run the relevant tests locally, then commit and push. If the failure is not caused by this repo (infra, flaky, permissions), do not push; explain instead.'
}

// ---- Promotion lanes, sparkline, actions ----------------------------------------

// dev → qa → staging → prod: Production last, then a conventional order, then by name
const LANE_ORDER = ['dev', 'development', 'int', 'integration', 'test', 'qa', 'uat', 'stage', 'staging', 'preprod', 'pre-prod', 'canary', 'prod', 'production']
export function laneSort(envs) {
  const rank = (e) => {
    const i = Math.max(LANE_ORDER.indexOf(String(e.id ?? '').toLowerCase()), LANE_ORDER.indexOf(String(e.name ?? '').toLowerCase()))
    return i === -1 ? 6.5 : i
  }
  return [...envs].sort((a, b) => (a.type === 'Production') - (b.type === 'Production') || rank(a) - rank(b) || String(a.name).localeCompare(String(b.name)))
}

// Newest successful deploy commit per service × environment, from runs that built this repo
export function envCommits(executions, key) {
  const out = new Map()
  for (const x of executions ?? []) {
    if (key && !execRepoKeys(x).has(key)) continue
    const commit = execCi(x)?.commit
    if (!commit) continue
    for (const t of cdTargets(x)) {
      const k = t.service + '\u0000' + t.env
      if (t.status === 'Success' && t.env && !out.has(k)) out.set(k, commit)
    }
  }
  return out
}

export const SPARK = { ok: '▂', fail: '█', run: '▅', warn: '▃', wait: '▄', idle: '▁' }
// Oldest → newest kinds of the last n runs, grouped into same-kind runs for drawing
export function sparkRuns(executions, n = 20) {
  const kinds = (executions ?? []).slice(0, n).map((x) => statusKind(x.status)).reverse()
  const groups = []
  for (const k of kinds) {
    if (groups.length && groups.at(-1).kind === k) groups.at(-1).count++
    else groups.push({ kind: k, count: 1 })
  }
  return groups
}

export const failedStageIds = (x) => Object.values(x?.layoutNodeMap ?? {})
  .filter((n) => n?.nodeGroup === 'STAGE' && statusKind(n.status) === 'fail' && n.nodeIdentifier)
  .map((n) => n.nodeIdentifier)

export function actionsFor(x) {
  const k = statusKind(x?.status)
  const list = []
  if (k === 'fail') list.push('diagnose', 'fix', 'retry', 'rerun')
  if (k === 'wait') list.push('approve', 'reject', 'abort')
  if (k === 'run') list.push('abort')
  if (k === 'ok' || k === 'warn' || k === 'idle') list.push('rerun')
  return list
}

// ---- Approvals ----------------------------------------------------------------------
// GET /pipeline/api/v1/orgs/{org}/projects/{project}/approvals/execution/{id}?approval_status=WAITING
// answers a bare array of { id, type, status, deadline, created, updated, error_message, details }.
// `details` for a HarnessApproval carries approvalMessage, approvers { userGroups, minimumCount },
// approverInputs [{ name, defaultValue }] (accepted in snake_case too).

export const isApprovalWaiting = (x) =>
  x?.status === 'ApprovalWaiting' || Object.values(x?.layoutNodeMap ?? {}).some((n) => n?.status === 'ApprovalWaiting')

export function parseApprovals(json) {
  const list = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : []
  return list
    .filter((a) => a?.id && (!a.status || a.status === 'WAITING'))
    .map((a) => {
      const d = a.details ?? {}
      const ap = d.approvers ?? {}
      return {
        id: String(a.id),
        type: a.type || 'HarnessApproval',
        deadline: Number(a.deadline) || 0,
        created: Number(a.created) || 0,
        message: String(d.approvalMessage ?? d.approval_message ?? '').trim(),
        approvers: (ap.userGroups ?? ap.user_groups ?? []).map(String),
        minimumCount: Number(ap.minimumCount ?? ap.minimum_count) || 1,
        inputs: (d.approverInputs ?? d.approver_inputs ?? []).filter((i) => i?.name).map((i) => ({ name: String(i.name), default: String(i.defaultValue ?? i.default_value ?? i.value ?? '') })),
        error: a.error_message || '',
      }
    })
}

export function expiresIn(deadline, now) {
  if (!deadline) return ''
  const left = deadline - now
  if (left <= 0) return 'expired'
  const m = Math.floor(left / 60000)
  const two = (a, ua, b, ub) => `${a}${ua}${b ? ` ${b}${ub}` : ''}` // "2h 59m", "3d 4h", never rounded up
  return 'expires in ' + (m < 60 ? `${Math.max(1, m)}m` : m < 1440 ? two(Math.floor(m / 60), 'h', m % 60, 'm') : two(Math.floor(m / 1440), 'd', Math.floor((m % 1440) / 60), 'h'))
}

export const approvalWhere = (type) => ({ JiraApproval: 'Jira', ServiceNowApproval: 'ServiceNow', CustomApproval: 'its custom approval step' }[type] ?? 'Harness')

// The NG activity body (what Harness's own MCP server sends)
export function approvalBody(action, inputs, comments) {
  return { action, comments: comments || 'From Claude Code (harness-cicd)', ...(inputs?.length ? { approverInputs: inputs } : {}) }
}

// ---- Runtime inputs (rerun / retry) ---------------------------------------------------
// A template line like `      tag: <+input>.default(latest).allowedValues(latest,stable)`
const INPUT_LINE = /^(\s*)(-\s+)?([A-Za-z_][\w.-]*):\s*["']?<\+input>((?:\.[a-zA-Z]+\([^)]*\))*)["']?\s*$/

export function parseTemplateInputs(yaml) {
  const lines = String(yaml ?? '').split('\n')
  const out = []
  lines.forEach((line, i) => {
    const m = INPUT_LINE.exec(line)
    if (!m) return
    const mods = m[4] || ''
    const dflt = /\.default\(([^)]*)\)/.exec(mods)?.[1]
    const allowed = /\.allowedValues\(([^)]*)\)/.exec(mods)?.[1]
    // Where it lives: the nearest `identifier:` above at a shallower indent
    let where = ''
    for (let j = i - 1; j >= 0; j--) {
      const id = /^(\s*)(?:-\s+)?identifier:\s*["']?([^"'\s]+)/.exec(lines[j])
      if (id && id[1].length < m[1].length + (m[2] ? m[2].length : 0)) { where = id[2]; break }
    }
    const varName = m[3] === 'value' ? /^\s*(?:-\s+)?name:\s*["']?([^"'\s]+)/.exec(lines[i - 1] ?? '')?.[1] : ''
    out.push({ line: i, key: m[3], label: varName || m[3], where, default: dflt ?? '', allowed: allowed ? allowed.split(',').map((s) => s.trim()).filter(Boolean) : [] })
  })
  return out
}

export function fillTemplate(yaml, inputs, values) {
  const lines = String(yaml ?? '').split('\n')
  inputs.forEach((inp, k) => {
    const m = INPUT_LINE.exec(lines[inp.line])
    if (!m) return
    const v = String(values[k] ?? '')
    const safe = /^[\w./:@-]+$/.test(v) ? v : JSON.stringify(v)
    lines[inp.line] = `${m[1]}${m[2] ?? ''}${m[3]}: ${safe}`
  })
  return lines.join('\n')
}

// ---- Freeze windows ------------------------------------------------------------------
// Global freeze (GET /ng/api/freeze/getGlobalFreeze) and enabled windows (POST /ng/api/freeze/list).
// Only a window we can see covers *now* counts as active; enabled-without-schedule is "enabled".
export function parseFreeze(globalData, listData, now) {
  const items = []
  const add = (f, isGlobal) => {
    if (!f || String(f.status ?? f.freezeStatus ?? '').toLowerCase() !== 'enabled') return
    const w = f.currentOrUpcomingWindow ?? f.currentOrUpcomingActiveWindow ?? f.window ?? null
    const start = Number(w?.startTime ?? w?.start_time ?? 0)
    const end = Number(w?.endTime ?? w?.end_time ?? 0)
    const known = Boolean(start || end)
    items.push({
      name: isGlobal ? 'Global freeze' : String(f.name ?? f.identifier ?? 'Freeze window'),
      id: String(f.identifier ?? (isGlobal ? '_GLOBAL_' : '')),
      active: known ? start <= now && (!end || now < end) : isGlobal, // an enabled global freeze applies now
      upcoming: known && start > now ? start : 0,
      until: end || 0,
      global: isGlobal,
    })
  }
  add(globalData, true)
  for (const f of Array.isArray(listData?.content) ? listData.content : Array.isArray(listData) ? listData : []) add(f, false)
  const active = items.filter((i) => i.active)
  return { active, upcoming: items.filter((i) => !i.active && i.upcoming).sort((a, b) => a.upcoming - b.upcoming), frozen: active.length > 0 }
}

export function freezeText(fz, now) {
  if (!fz?.frozen) return ''
  const f = fz.active[0]
  const until = f.until ? ` until ${new Date(f.until).toISOString().slice(0, 16).replace('T', ' ')} UTC` : ''
  return `❄ ${f.name}${until}${fz.active.length > 1 ? ` (+${fz.active.length - 1})` : ''}`
}

// ---- Pull requests -------------------------------------------------------------------
// Harness Code remotes look like https://git.harness.io/<account>/<org>[/<project>]/<repo>(.git)
export function harnessCodeRef(remote) {
  const m = /^(?:https?:\/\/|git@)([^/:]+)[/:](.+?)(?:\.git)?\/?$/.exec(String(remote ?? '').trim())
  if (!m || !/harness/i.test(m[1])) return null
  const parts = m[2].split('/').filter(Boolean)
  if (parts.length < 3 || parts.length > 4) return null
  return parts.join('/') + '/+'
}
export const isGithubRemote = (remote) => /(^|[@/.])github\.com[/:]/i.test(String(remote ?? ''))

const CHECK_KIND = { success: 'ok', passed: 'ok', failure: 'fail', failed: 'fail', error: 'fail', cancelled: 'fail', timed_out: 'fail', action_required: 'wait',
  pending: 'run', running: 'run', queued: 'run', in_progress: 'run', expected: 'run', skipped: 'idle', neutral: 'idle', stale: 'idle' }
const checkKind = (s) => CHECK_KIND[String(s ?? '').toLowerCase()] ?? 'idle'

export function summarizeChecks(checks) {
  const c = { ok: 0, fail: 0, run: 0, other: 0, failing: [] }
  for (const x of checks) {
    const k = checkKind(x.status)
    if (k === 'ok') c.ok++
    else if (k === 'fail') { c.fail++; c.failing.push(x.name) }
    else if (k === 'run' || k === 'wait') c.run++
    else c.other++
  }
  return c
}

// Harness Code: PR list item + /checks + /reviewers responses
export function parseHarnessPr(list, branch, checksJson, reviewersJson) {
  const prs = (Array.isArray(list) ? list : []).filter((p) => p?.source_branch === branch && (!p.state || p.state === 'open'))
  const pr = prs[0]
  if (!pr) return null
  const rawChecks = Array.isArray(checksJson) ? checksJson : checksJson?.checks ?? []
  const checks = rawChecks.map((c) => ({ name: c.check?.identifier ?? c.identifier ?? c.name ?? 'check', status: c.check?.status ?? c.status, required: Boolean(c.required) }))
  const reviews = (Array.isArray(reviewersJson) ? reviewersJson : []).map((r) => String(r.review_decision ?? r.state ?? '').toLowerCase())
  const review = reviews.includes('changereq') ? 'changes requested' : reviews.includes('approved') ? 'approved' : reviews.length ? 'review pending' : 'no reviewers'
  return { number: pr.number, title: String(pr.title ?? ''), draft: Boolean(pr.is_draft), target: pr.target_branch ?? '', checks, review, url: '' }
}

// GitHub via `gh pr view --json number,title,state,isDraft,reviewDecision,statusCheckRollup,url,baseRefName`
export function parseGhPr(json) {
  if (!json || json.state && json.state !== 'OPEN') return null
  const checks = (json.statusCheckRollup ?? []).map((c) => ({ name: c.name ?? c.context ?? 'check', status: c.conclusion || c.state || c.status, required: false }))
  const review = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes requested', REVIEW_REQUIRED: 'review pending' }[json.reviewDecision] ?? 'no reviewers'
  return { number: json.number, title: String(json.title ?? ''), draft: Boolean(json.isDraft), target: json.baseRefName ?? '', checks, review, url: json.url ?? '' }
}

export function prLine(pr) {
  if (!pr) return ''
  const c = summarizeChecks(pr.checks)
  const checks = pr.checks.length ? (c.fail ? `${c.fail} check${c.fail === 1 ? '' : 's'} failing` : c.run ? `${c.run} running` : 'checks passing') : 'no checks'
  return `PR #${pr.number}${pr.draft ? ' (draft)' : ''} → ${pr.target}: ${checks} · ${pr.review}`
}

// ---- MCP (sign-in mode) ----------------------------------------------------------------
// A Harness MCP tool result: text blocks holding JSON (or an error text when isError)
export function mcpJson(result) {
  const text = (result?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
  if (result?.isError) throw new Error(fit(text || 'Harness MCP call failed', 300))
  if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent
  try { return JSON.parse(text) } catch { return { text } }
}
export const mcpItems = (j) => (Array.isArray(j) ? j : Array.isArray(j?.items) ? j.items : Array.isArray(j?.content) ? j.content : [])
export const accountFromUrl = (u) => /\/account\/([^/]+)\//.exec(String(u ?? ''))?.[1] ?? ''

// ---- Deployment inventory: every service × environment × infrastructure --------------------
// Built from CD execution history (documented execution list, module=CD, paged back N days).
// "Live" = the newest *successful* deploy stage per service/env/infra, which also covers
// rollbacks (a failed deploy leaves the previous success live). A newer stage that is running
// or failed is kept as the "attempt" so the pane can say "deploying 3-dev" / "3-dev failed".

export function buildInventory(executions, services, environments) {
  const svcMeta = new Map((services ?? []).map((s) => [s.identifier, s.name || s.identifier]))
  const envMeta = new Map((environments ?? []).map((e) => [e.identifier, { name: e.name || e.identifier, type: e.type }]))
  const cells = new Map() // svc \0 env \0 infra → { live, attempt }
  const sorted = [...(executions ?? [])].sort((a, b) => (b.startTs || 0) - (a.startTs || 0))
  for (const x of sorted) {
    for (const t of cdTargets(x)) {
      if (!t.service || !t.env) continue
      if (!svcMeta.has(t.service)) svcMeta.set(t.service, t.serviceName || t.service)
      if (!envMeta.has(t.env)) envMeta.set(t.env, { name: t.envName || t.env, type: t.envType })
      const key = [t.service, t.env, t.infra || '-'].join('\u0000')
      const c = cells.get(key) ?? { service: t.service, env: t.env, infra: t.infra || '', live: null, attempt: null }
      const entry = {
        artifact: t.artifact || '', status: t.status, at: t.startTs || x.startTs || 0, run: x.runSequence, pipeline: x.name ?? x.pipelineIdentifier,
        pipelineId: x.pipelineIdentifier, execution: x.planExecutionId, by: x.executionTriggerInfo?.triggeredBy?.identifier || '',
        commit: execCi(x)?.commit || '', url: x.openInHarness || '',
      }
      const k = statusKind(t.status)
      if (k === 'ok' && !c.live) c.live = entry
      else if (!c.live && !c.attempt && k !== 'idle') c.attempt = entry // newer than anything live
      cells.set(key, c)
    }
  }
  const envs = laneSort([...envMeta.entries()].map(([id, m]) => ({ id, ...m })))
  const rows = [...svcMeta.entries()].map(([id, name]) => {
    const byEnv = {}
    for (const e of envs) {
      const infras = [...cells.values()].filter((c) => c.service === id && c.env === e.id)
      if (!infras.length) { byEnv[e.id] = null; continue }
      const lives = infras.map((c) => c.live).filter(Boolean)
      const versions = [...new Set(lives.map((l) => l.artifact || '#' + l.run))]
      const newest = lives.sort((a, b) => b.at - a.at)[0] ?? null
      const attempt = infras.map((c) => c.attempt).filter(Boolean).sort((a, b) => b.at - a.at)[0] ?? null
      byEnv[e.id] = { live: newest, versions, mixed: versions.length > 1, attempt, infras }
    }
    // Drift: a stage running a different version than the stage before it (in lane order)
    const drift = []
    let prev = null
    for (const e of envs) {
      const c = byEnv[e.id]
      if (!c?.live) continue
      if (prev && e.type === 'Production' && prev.versions.join() !== c.versions.join()) drift.push({ from: prev.envName, to: e.name, toType: e.type })
      prev = { ...c, envName: e.name }
    }
    const deployed = envs.some((e) => byEnv[e.id])
    return { id, name, cells: byEnv, drift, deployed }
  })
  rows.sort((a, b) => (b.deployed - a.deployed) || a.name.localeCompare(b.name))
  return { envs, rows }
}

// Merge newly fetched executions into the inventory's store, newest wins per execution id
export function mergeRuns(store, executions) {
  for (const x of executions ?? []) if (x?.planExecutionId && cdTargets(x).length) store.set(x.planExecutionId, x)
  return store
}

export function inventoryCell(c, now) {
  if (!c) return { text: '—', kind: 'idle' }
  if (!c.live && c.attempt) return { text: `${ICON[statusKind(c.attempt.status)]} ${fit(c.attempt.artifact || '#' + c.attempt.run, 12)} ${c.attempt.status === 'Running' ? 'deploying' : c.attempt.status.toLowerCase()}`, kind: statusKind(c.attempt.status) }
  const v = c.mixed ? `${c.versions.length} versions` : fit(c.live.artifact || '#' + c.live.run, 12)
  const pendingKind = c.attempt ? statusKind(c.attempt.status) : null
  const icon = pendingKind === 'run' ? '●' : pendingKind === 'fail' ? '!' : ICON.ok
  return { text: `${icon} ${v} ${ago(c.live.at, now)}`, kind: pendingKind === 'run' ? 'run' : pendingKind === 'fail' ? 'warn' : c.mixed ? 'warn' : 'ok' }
}

export function inventoryText(inv, now, scopeLabel) {
  const L = [`Deployments (${scopeLabel}) — live version per service and environment`]
  const envs = inv.envs
  L.push(['service', ...envs.map((e) => (e.type === 'Production' ? '★ ' : '') + e.name)].join(' | '))
  for (const r of inv.rows) {
    if (!r.deployed) continue
    L.push([r.name, ...envs.map((e) => inventoryCell(r.cells[e.id], now).text)].join(' | ') + (r.drift.length ? `   drift: ${r.drift.map((d) => `${d.to} ≠ ${d.from}`).join(', ')}` : ''))
  }
  const idle = inv.rows.filter((r) => !r.deployed).map((r) => r.name)
  if (idle.length) L.push(`Not deployed in the window: ${idle.join(', ')}`)
  return L.join('\n')
}
