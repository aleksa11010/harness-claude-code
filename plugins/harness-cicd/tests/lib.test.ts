import { expect, test } from 'claude-code/testing'
import {
  repoKey, accountFromKey, execCi, execRepoKeys, cdTargets, failureMessage, execUrl, buildView, toolSummary, statusKind, fit, ago,
} from '../hooks/lib.js'
import { executions, services, environments, T0 } from './fixtures.ts'

const data = (git: any) => ({
  executions,
  services: services.map((s) => s.service),
  environments: environments.map((e) => e.environment),
  git, me: null,
})
const cfg = { base_url: 'https://app.harness.io', account_id: 'ACC123', org_id: 'ORG', project_id: 'proj' }

test('repoKey normalizes remotes and Harness repo names alike', () => {
  expect(repoKey('https://github.com/acme/Guest_Flow.git')).toBe('guest-flow')
  expect(repoKey('git@github.com:acme/guest-flow')).toBe('guest-flow')
  expect(repoKey('org.bootcamp-app')).toBe('bootcamp-app')
  expect(repoKey('ORG/bootcamp-app')).toBe('bootcamp-app')
  expect(repoKey('')).toBe('')
})

test('account id comes from PAT and SAT tokens', () => {
  expect(accountFromKey('pat.ACC123.tok.secret')).toBe('ACC123')
  expect(accountFromKey('sat.ACC999.tok.secret')).toBe('ACC999')
  expect(accountFromKey('nonsense')).toBe('')
})

test('CI info, repo keys and CD targets are read from an execution', () => {
  const ci = execCi(executions[3])
  expect(ci?.branch).toBe('main')
  expect(ci?.commit).toBe('a99212271ccf98e1')
  expect([...execRepoKeys(executions[3])]).toContain('bootcamp-app')
  const t = cdTargets(executions[3])
  expect(t.length).toBe(1)
  expect(t[0]).toMatchObject({ service: 'bootcampapp', env: 'dev', envType: 'PreProduction', artifact: '1-dev', status: 'Expired' })
})

test('failure message names the failed stage', () => {
  expect(failureMessage(executions[3])).toMatch(/^Deploy dev: Please Check the timeout/)
  expect(failureMessage(executions[1])).toBe('')
})

test('execution URLs use the /deployments/ path Harness links to', () => {
  expect(execUrl(cfg, executions[1])).toBe('https://app.harness.io/ng/account/ACC123/all/orgs/ORG/projects/proj/pipelines/guestflow_api_pipeline/deployments/run4/pipeline')
})

test('"mine" scopes to the repo you are in, and knows whether HEAD was built', () => {
  const v = buildView(data({ name: 'guest-flow', branch: 'main', head: 'cc6d11f2644ab0fe864f87458e5881ebbe8cf1fd' }), 'mine')
  expect(v.scope).toBe('mine')
  expect(v.executions.map((x: any) => x.planExecutionId)).toEqual(['run4', 'run3'])
  expect(v.branch?.headRun?.planExecutionId).toBe('run4')
  expect(v.matrix.services.length).toBe(0)
})

test('HEAD not built yet when the newest commit has no run', () => {
  const v = buildView(data({ name: 'guest-flow', branch: 'main', head: 'ffffffffffffffff' }), 'mine')
  expect(v.branch?.headRun).toBe(null)
  expect(v.branch?.latest?.planExecutionId).toBe('run4')
})

test('deploy matrix keeps the newest deployment per service × environment, prod last', () => {
  const v = buildView(data({ name: 'bootcamp-app', branch: 'main', head: 'b0b0b0b0b0b0b0b0' }), 'mine')
  expect(v.matrix.envs.map((e: any) => e.id)).toEqual(['dev', 'prod'])
  const row = v.matrix.services[0]
  expect(row.name).toBe('bootcamp-app')
  expect(row.cells.dev.artifact).toBe('1-dev') // run2 is newer than run1
  expect(row.cells.prod.status).toBe('Running')
  expect(v.counts).toEqual({ running: 1, failed: 1, waiting: 0 })
})

test('falls back to the whole project when nothing matches the repo', () => {
  const v = buildView(data({ name: 'some-other-repo', branch: 'main', head: 'x' }), 'mine')
  expect(v.scope).toBe('all')
  expect(v.scopeFellBack).toBe(true)
  expect(v.executions.length).toBe(5)
})

test('without a matching repo, "mine" falls back to runs you triggered', () => {
  const d = data(null)
  d.me = 'dev@example.com' as any
  d.executions = executions.map((x: any, i: number) => i === 0 ? x : { ...x, executionTriggerInfo: { triggeredBy: { extraInfo: { email: 'someone@example.com' } } } })
  const v = buildView(d, 'mine')
  expect(v.mineBasis).toBe('me')
  expect(v.executions.map((x: any) => x.planExecutionId)).toEqual(['run5'])
})

test('tool summary is compact and linked', () => {
  const v = buildView(data({ name: 'bootcamp-app', branch: 'main', head: 'b0b0b0b0b0b0b0b0' }), 'mine')
  const s = toolSummary(v, cfg, T0)
  expect(s.scope).toBe('this repo')
  expect(s.this_branch.head_built).toBe('Running')
  expect(s.executions[0].deploys).toEqual(['bootcampapp→prod (3-dev)'])
  expect(s.deployed[0].environments.dev.artifact).toBe('1-dev')
  expect(s.executions[0].url).toMatch(/\/deployments\/run5\/pipeline$/)
})

test('helpers', () => {
  expect(statusKind('IgnoreFailed')).toBe('warn')
  expect(statusKind('ApprovalWaiting')).toBe('wait')
  expect(fit('abcdef', 4)).toBe('abc…')
  expect(ago(T0 - 3 * 3600_000, T0)).toBe('3h')
})

import { isGitPush, isHarnessWrite, prodTargets, parseDiagnosis, failedSteps, logTail, prodCommit, wantsContext, contextLine } from '../hooks/lib.js'

test('git push detection', () => {
  for (const c of ['git push', 'git push origin main', 'git -C ../app push', 'git -c http.x=1 push --force', 'cd app && git push', 'GIT_TRACE=1 git push', 'git --no-pager push'])
    expect([c, isGitPush(c)]).toEqual([c, true])
  for (const c of ['git pushd', 'git push-hooks', 'git log --grep push', 'git status', 'echo pushed'])
    expect([c, isGitPush(c)]).toEqual([c, false])
})

test('Harness write tools are recognized on any Harness MCP server name', () => {
  expect(isHarnessWrite('mcp__Harness__harness_execute')).toBe(true)
  expect(isHarnessWrite('mcp__harness-mcp__harness_delete')).toBe(true)
  expect(isHarnessWrite('mcp__claude_ai_Harness__harness_update')).toBe(true)
  expect(isHarnessWrite('mcp__Harness__harness_list')).toBe(false)
  expect(isHarnessWrite('mcp__other__harness_execute')).toBe(false)
})

test('production targets come from environment types and names', () => {
  const envs = [{ identifier: 'prod_us', name: 'Prod US', type: 'Production' }, { identifier: 'dev', name: 'dev', type: 'PreProduction' }]
  expect(prodTargets({ inputs: { env: 'prod_us' } }, envs)).toEqual(['Prod US'])
  expect(prodTargets({ inputs: { env: 'dev' } }, envs)).toEqual([])
  expect(prodTargets({ note: 'products page' }, envs)).toEqual([])
  expect(prodTargets({ stage: 'deploy to production' }, [])).toEqual(['prod'])
})

test('diagnosis replies are parsed defensively', () => {
  expect(parseDiagnosis('```json\n{"cause":"OOMKilled","fix":"raise limit","confidence":"high"}\n```')).toMatchObject({ cause: 'OOMKilled', fix: 'raise limit', confidence: 'high' })
  expect(parseDiagnosis('The build failed because of X.')).toMatchObject({ cause: 'The build failed because of X.', confidence: 'low' })
  expect(parseDiagnosis('')).toBe(null)
})

test('failed stages and steps, and log tails', () => {
  const steps = failedSteps(executions[3], { executionGraph: { nodeMap: { s: { name: 'Rollout Deployment', stepType: 'K8sRollingDeploy', status: 'Expired', failureInfo: { message: 'timed out' }, logBaseKey: 'k1' }, ok: { name: 'x', status: 'Success' } } } })
  expect(steps.map((s: any) => `${s.level}:${s.name}`)).toEqual(['stage:Deploy dev', 'step:Rollout Deployment'])
  expect(steps[1].logKey).toBe('k1')
  expect(logTail('{"out":"a"}\n{"out":"b"}\nplain\n', 2)).toBe('b\nplain')
})

test('commits behind prod use the newest successful prod deploy from this repo', () => {
  const prodOk = { ...executions[0], planExecutionId: 'old', status: 'Success', moduleInfo: { ...executions[0].moduleInfo, ci: { ...executions[0].moduleInfo.ci, ciPipelineStageModuleInfo: { ...executions[0].moduleInfo.ci.ciPipelineStageModuleInfo, commitId: 'c0ffee' } } },
    layoutNodeMap: { b: { ...executions[0].layoutNodeMap.b, status: 'Success' } } }
  expect(prodCommit([executions[0], prodOk], 'bootcamp-app')?.commit).toBe('c0ffee') // the Running one is skipped
  expect(prodCommit(executions, 'guest-flow')).toBe(null)
})

test('context is added only for CI/deploy prompts, and stays short', () => {
  expect(wantsContext('deploy this to qa')).toBe(true)
  expect(wantsContext('why is the build red?')).toBe(true)
  expect(wantsContext('rename this variable')).toBe(false)
  const v = buildView(data({ name: 'bootcamp-app', branch: 'main', head: 'b0b0b0b0b0b0b0b0' }), 'mine')
  const line = contextLine(v, { behind: 3, diagnoses: new Map() })
  expect(line).toMatch(/^\[Harness, from the harness-cicd plugin\] bootcamp-app@main \(HEAD b0b0b0b\): HEAD is CI CD #3 Running/)
  expect(line).toContain('prod is 3 commits behind HEAD')
  expect(line.length).toBeLessThan(600)
})

import { parseApprovals, expiresIn, approvalBody } from '../hooks/lib.js'

test('approvals: documented list shape, snake_case details too, non-waiting dropped', () => {
  const list = parseApprovals([
    { id: 'a', type: 'HarnessApproval', status: 'WAITING', deadline: 5, created: 1, details: { approval_message: 'ok?', approvers: { user_groups: ['g'], minimum_count: 2 }, approver_inputs: [{ name: 'n', default_value: 'd' }] } },
    { id: 'b', type: 'HarnessApproval', status: 'APPROVED', details: {} },
    { id: 'c', type: 'ServiceNowApproval', status: 'WAITING' },
  ])
  expect(list.map((a: any) => a.id)).toEqual(['a', 'c'])
  expect(list[0]).toMatchObject({ message: 'ok?', approvers: ['g'], minimumCount: 2, inputs: [{ name: 'n', default: 'd' }] })
  expect(parseApprovals({ nope: true })).toEqual([])
})

test('approvals: expiry never rounds up', () => {
  const h = 3600_000
  expect(expiresIn(3 * h - 600, 0)).toBe('expires in 2h 59m')
  expect(expiresIn(2 * h, 0)).toBe('expires in 2h')
  expect(expiresIn(30 * h, 0)).toBe('expires in 1d 6h')
  expect(expiresIn(90_000, 0)).toBe('expires in 1m')
  expect(expiresIn(1, 5)).toBe('expired')
  expect(expiresIn(0, 5)).toBe('')
  expect(approvalBody('REJECT', [])).toEqual({ action: 'REJECT', comments: 'From Claude Code (harness-cicd)' })
})

import { parseTemplateInputs, fillTemplate, parseFreeze, harnessCodeRef, isGithubRemote, mcpJson } from '../hooks/lib.js'

test('runtime input templates: labels, stage context, defaults, allowed values, safe filling', () => {
  const t = 'pipeline:\n  identifier: P\n  stages:\n    - stage:\n        identifier: Deploy\n        spec:\n          tag: <+input>.default(latest).allowedValues(latest,stable)\n  variables:\n    - name: reason\n      value: <+input>'
  const ins = parseTemplateInputs(t)
  expect(ins.map((i: any) => [i.label, i.where, i.default, i.allowed.join('|')])).toEqual([['tag', 'Deploy', 'latest', 'latest|stable'], ['reason', 'P', '', '']])
  const y = fillTemplate(t, ins, ['stable', 'hot: fix'])
  expect(y).toContain('          tag: stable')
  expect(y).toContain('      value: "hot: fix"')
})

test('freeze: global enabled applies now; windows by schedule; disabled ignored', () => {
  const now = 1_000_000
  expect(parseFreeze({ status: 'Enabled' }, null, now).frozen).toBe(true)
  expect(parseFreeze({ status: 'Disabled' }, { content: [{ name: 'off', status: 'Disabled' }] }, now).frozen).toBe(false)
  expect(parseFreeze(null, { content: [{ name: 'w', status: 'Enabled', currentOrUpcomingWindow: { startTime: now - 1, endTime: now + 1 } }] }, now).active[0].name).toBe('w')
})

test('repo hosts and MCP results', () => {
  expect(harnessCodeRef('https://git.harness.io/A/O/P/r.git')).toBe('A/O/P/r/+')
  expect(harnessCodeRef('git@github.com:a/b.git')).toBe(null)
  expect(isGithubRemote('https://github.com/a/b')).toBe(true)
  expect(mcpJson({ content: [{ type: 'text', text: '{"items":[1]}' }], isError: false })).toEqual({ items: [1] })
  expect(() => mcpJson({ content: [{ type: 'text', text: 'denied' }], isError: true })).toThrow('denied')
})

import { parseManifests, connectorScope, manifestInRepo, repoManifestPaths } from '../hooks/lib.js'

test('manifests: Git and Harness Code stores, list and folder paths, artifacts ignored', () => {
  const y = 'service:\n  serviceDefinition:\n    spec:\n      manifests:\n        - manifest:\n            spec:\n              store:\n                type: Github\n                spec:\n                  connectorRef: account.gh\n                  repoName: payments\n                  paths:\n                    - k8s/\n        - manifest:\n            spec:\n              store:\n                type: HarnessCode\n                spec:\n                  repoName: charts\n                  folderPath: charts/payments\n                  valuesPaths:\n                    - <+env.name>/values.yaml\n      artifacts:\n        primary:\n          spec:\n            connectorRef: docker'
  const m = parseManifests(y)
  expect(m.map((x: any) => [x.storeType, x.connectorRef, x.repoName, x.paths.join(',')])).toEqual([['Github', 'account.gh', 'payments', 'k8s/'], ['HarnessCode', '', 'charts', 'charts/payments']])
  expect(connectorScope('account.gh')).toEqual({ id: 'gh', scope: 'account' })
  // an account-level connector matches through repoName; a repo-level one through its URL
  expect(manifestInRepo(m[0], 'payments', new Map([['account.gh', { url: 'https://github.com/acme', type: 'Account' }]]))).toBe(true)
  expect(manifestInRepo({ connectorRef: 'r', repoName: '', paths: [] }, 'payments', new Map([['r', { url: 'https://github.com/acme/payments.git', type: 'Repo' }]]))).toBe(true)
  expect(manifestInRepo({ connectorRef: 'r', repoName: '', paths: [] }, 'payments', new Map())).toBe(false) // unknown connector: no guess
  expect(repoManifestPaths({ yaml: y }, 'charts', new Map())).toEqual(['charts/payments']) // runtime-expression paths skipped
})
