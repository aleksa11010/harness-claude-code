import { expect, mock, test } from 'claude-code/testing'
import { executions, services, environments, envelope, T0 } from './fixtures.ts'

const TOOL = 'mcp__harness-cicd__harness_status'
const PANE = {
  plugin: 'harness-cicd',
  component: 'Pane',
  requestId: 'harness',
  viewport: { columns: 140, rows: 40 },
  props: {
    title: 'Harness', isFocused: true, bodyColumns: 100, placement: 'inline',
    scroll: { offset: 0, bodyRows: 30 }, view: {},
  },
} as const

const ENV = { HARNESS_API_KEY: 'pat.ACC123.tok.secret', HARNESS_DEFAULT_PROJECT_ID: 'proj', HARNESS_DEFAULT_ORG_ID: 'ORG' }

// Stubs for everything the mod asks Claude Code for. `world` lets a test change Harness's answers.
function harnessWorld(on: any, opts: { env?: Record<string, string>; httpStatus?: number; surfaces?: string[]; slowMs?: number; answer?: string | string[]; model?: string; behind?: string; store?: Record<string, unknown>; remote?: string; mcp?: (tool: string, args: any) => any } = {}) {
  const world = {
    executions: structuredClone(executions) as any[],
    requests: [] as { url: string; init?: any }[],
    statuses: [] as (string | undefined)[],
    toasts: [] as string[],
    prompts: [] as string[],
    contexts: [] as string[][],
    asked: [] as string[],
    modelCalls: [] as any[],
    logs: [] as string[],
    opened: [] as any[],
    store: undefined as unknown as Map<string, unknown>,
    // Documented shape of GET /v1/…/approvals/execution/{id}?approval_status=WAITING (a bare array)
    approvalList: [{
      id: 'ap1', type: 'HarnessApproval', status: 'WAITING', deadline: T0 + 3 * 3600_000, created: T0 - 20 * 60_000, updated: T0, error_message: '',
      details: { approvalMessage: 'Approve deploy of 3-dev to prod?', approvers: { userGroups: ['_project_all_users', 'release-managers'], minimumCount: 1 }, approverInputs: [{ name: 'version', defaultValue: '3-dev' }] },
    }] as any[],
    approvalPost: null as null | { status: number; text: string },
    inputs: '' as string, // inputSetYaml the run used
    template: '' as string, // runtime input template
    freezeList: [] as any[],
    globalFreeze: { status: 'Disabled' } as any,
    prList: [] as any[], prChecks: [] as any, prReviewers: [] as any,
    gh: null as null | { exitCode: number; stdout: string; stderr: string },
    mcpCalls: [] as any[],
  }
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, opts.env ?? ENV)
  const store = new Map(Object.entries(opts.store ?? {}))
  on('store.get', ($: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', ($: any, e: any) => { store.set(e.key, e.value); return { value: undefined } })
  world.store = store
  on('ui.close', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('ui.open', ($: any, e: any) => { world.opened.push(e); return { value: { isPlaced: true } } })
  on('ui.status', ($: any, e: any) => { world.statuses.push(e.text); return { value: undefined } })
  on('ui.toast', ($: any, e: any) => { world.toasts.push(e.text); return { value: undefined } })
  on('prompt.submit', ($: any, e: any) => { world.prompts.push(e.text); world.contexts.push([...(e.context ?? [])]); return { text: e.text } })
  on('ui.log', ($: any, e: any) => { world.logs.push(e.text); return { value: undefined } })
  on('model.complete', ($: any, e: any) => {
    world.modelCalls.push(e)
    return { value: { isAnswered: true, text: opts.model ?? '{"cause":"Pod taskmanager OOMKilled at startup (limit 256Mi)","evidence":"Last State: OOMKilled","fix":"Lower CACHE_MAX_ENTRIES or raise the memory limit","confidence":"high"}', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  on('session.repo', () => ({ value: { root: '/work', remote: opts.remote ?? 'https://git.example.com/ACC123/ORG/bootcamp-app.git', internal: false, name: null } }))
  on('mcp.call', ($: any, e: any) => {
    world.mcpCalls.push(e)
    if (!opts.mcp) throw new Error('unknown server ' + e.server)
    const out = opts.mcp(e.tool, e.args)
    return { value: out?.isError ? out : { content: [{ type: 'text', text: JSON.stringify(out) }], isError: false } }
  })
  on('process.run', ($: any, e: any) => {
    const cmd = e.argv.join(' ')
    if (cmd === 'git rev-parse --abbrev-ref HEAD') return { value: { exitCode: 0, stdout: 'main\n', stderr: '' } }
    if (cmd === 'git rev-parse HEAD') return { value: { exitCode: 0, stdout: 'b0b0b0b0b0b0b0b0\n', stderr: '' } }
    if (cmd.startsWith('git rev-list --count') && opts.behind) return { value: { exitCode: 0, stdout: opts.behind + '\n', stderr: '' } }
    if (cmd.startsWith('gh pr view')) return { value: world.gh ?? { exitCode: 1, stdout: '', stderr: 'no pull requests found for branch "main"' } }
    return { value: { exitCode: 1, stdout: '', stderr: 'unknown' } }
  })
  on('http.fetch', async ($: any, e: any) => {
    world.requests.push({ url: e.url, init: e.init })
    if (opts.slowMs) await clock.sleep(opts.slowMs)
    if (opts.httpStatus) return { value: { status: opts.httpStatus, ok: false, headers: {}, text: '' } }
    const ok = (d: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: envelope(d) } })
    if (e.url.includes('/pipeline/api/pipelines/execution/summary')) return ok({ content: world.executions })
    if (e.url.includes('/ng/api/servicesV2')) return ok({ content: services })
    if (e.url.includes('/ng/api/environmentsV2')) return ok({ content: environments })
    if (e.url.includes('/ng/api/user/currentUser')) return ok({ email: 'dev@example.com' })
    if (e.url.includes('/pipeline/api/v1/') && e.url.includes('/approvals/execution/')) return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(world.approvalList) } }
    if (e.url.includes('/inputsetV2')) return ok({ inputSetYaml: world.inputs })
    if (e.url.includes('/pipeline/api/inputSets/template')) return ok({ inputSetTemplateYaml: world.template })
    if (e.url.includes('/ng/api/freeze/getGlobalFreeze')) return ok(world.globalFreeze)
    if (e.url.includes('/ng/api/freeze/list')) return ok({ content: world.freezeList })
    const bare = (d: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(d) } })
    if (/\/code\/api\/v1\/repos\/.+\/pullreq\/\d+\/checks/.test(e.url)) return bare(world.prChecks)
    if (/\/code\/api\/v1\/repos\/.+\/pullreq\/\d+\/reviewers/.test(e.url)) return bare(world.prReviewers)
    if (/\/code\/api\/v1\/repos\/.+\/pullreq\?/.test(e.url)) return bare(world.prList)
    if (e.url.includes('/harness/activity') && world.approvalPost) return { value: { ...world.approvalPost, ok: world.approvalPost.status < 300, headers: {} } }
    if (e.url.includes('/pipeline/api/pipeline/execute/') || e.url.includes('/pipeline/api/approvals/')) return ok({ planExecution: { uuid: 'new1' } })
    return { value: { status: 404, ok: false, headers: {}, text: '' } }
  })
  on('session.surfaces', () => ({ value: opts.surfaces ?? ['terminal'] }))
  on('ui.render', ($: any, e: any) => { const { Text } = $.ui.resolve(e); return Text({ children: ['(engine band)'] }) }) // core's own drawing
  // What Claude Code answers: AskUserQuestion (from $.ui.ask) gets the scripted answer, every other tool "ok"
  on('tool.call', ($: any, e: any) => {
    if (e.tool === 'AskUserQuestion') {
      const q = e.questions[0].question
      world.asked.push(q)
      const a = Array.isArray(opts.answer) ? opts.answer[world.asked.length - 1] : opts.answer
      if (!a) throw new Error('no one to ask')
      return { result: { answers: { [q]: a } } }
    }
    return { result: 'ok' }
  })
  return { world, clock }
}

async function start($: any, clock: any) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(600) // first refresh runs 500 ms after start
}

test('refresh calls the three Harness endpoints with the API key and scope', async ($, on) => {
  const { world, clock } = harnessWorld(on)
  await start($, clock)
  const urls = world.requests.map((r) => r.url)
  expect(urls.some((u) => u.startsWith('https://app.harness.io/pipeline/api/pipelines/execution/summary?'))).toBe(true)
  expect(urls.some((u) => u.includes('/ng/api/servicesV2?'))).toBe(true)
  expect(urls.some((u) => u.includes('/ng/api/environmentsV2?'))).toBe(true)
  const summary = world.requests.find((r) => r.url.includes('execution/summary'))!
  expect(summary.url).toContain('accountIdentifier=ACC123')
  expect(summary.url).toContain('orgIdentifier=ORG')
  expect(summary.url).toContain('projectIdentifier=proj')
  expect(summary.init.method).toBe('POST')
  expect(summary.init.headers['x-api-key']).toBe('pat.ACC123.tok.secret')
  expect(JSON.parse(summary.init.body)).toEqual({ filterType: 'PipelineExecution' })
  // auto_open defaults to true
  expect(world.opened[0]).toMatchObject({ id: 'harness' })
})

test('status line summarizes your branch', async ($, on) => {
  const { world, clock } = harnessWorld(on)
  await start($, clock)
  expect(world.statuses.at(-1)).toBe('harness: main@b0b0b0b ● Running · 1 running · 1 failed')
})

test('the pane shows this branch, your runs, and what is deployed where', async ($, on) => {
  const { world, clock } = harnessWorld(on)
  await start($, clock)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^bootcamp-app @ main {2}HEAD b0b0b0b/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Running · #3/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^CI CD #3 / })).toBeDefined()
    // guestflow runs are another repo: hidden in "This repo"
    expect(await ui.find({ type: 'Text', text: /guestflow_api_pipeline/ })).toBeUndefined()
    // Promotion lanes: dev shows the newest (failed) deploy, prod the running one, with ages
    expect(await ui.find({ type: 'Text', text: /^✗ 1-dev/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^● 3-dev/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^9d/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^1m/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Deploy dev: Please Check the timeout/ })).toBeDefined()
    // Failed rows keep their age visible next to the diagnose / open / ask Claude controls
    expect(await ui.find({ key: 'diag-run2' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^CI CD #2 .*Expired +10d$/ })).toBeDefined()
    // Section rules are drawn to full width, without a truncation mark
    expect(await ui.find({ type: 'Text', text: /^── DEPLOYED ─+$/ })).toBeDefined()
    // Whole project shows the other repo's runs too
    await ui.press({ key: 'scope-all' })
    expect(await ui.find({ type: 'Text', text: /^guestflow_api_pipe\S*… #2 / })).toBeDefined() // long names truncate, run number stays
    await ui.press({ key: 'scope-mine' })
    await ui.unmount()
  }
  expect(world.prompts.length).toBe(0)
})

test('"ask Claude" on a failed run starts a turn with the failure and link', async ($, on) => {
  const { world, clock } = harnessWorld(on)
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'ask-run2' })
  expect(world.prompts.length).toBe(1)
  expect(world.prompts[0]).toContain('"CI CD" #2 ended Expired')
  expect(world.prompts[0]).toContain('/deployments/run2/pipeline')
  expect(world.prompts[0]).toContain('harness_diagnose')
})

test('Claude can read the same state through the harness_status tool', async ($, on) => {
  const { clock } = harnessWorld(on)
  await start($, clock)
  const out: any = await $.tool.call({ tool: TOOL })
  const s = JSON.parse(out.result)
  expect(s.project).toBe('ORG/proj')
  expect(s.git).toEqual({ repo: 'bootcamp-app', branch: 'main', head: 'b0b0b0b' })
  expect(s.this_branch.head_built).toBe('Running')
  expect(s.deployed[0].environments.prod).toMatchObject({ status: 'Running', artifact: '3-dev' })
  const all: any = await $.tool.call({ tool: TOOL, scope: 'all' })
  expect(JSON.parse(all.result).executions.length).toBe(5)
})

test('a git push turns on fast polling and you get a toast when the run finishes', async ($, on) => {
  const { world, clock } = harnessWorld(on)
  await start($, clock)
  const before = world.requests.length
  await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
  expect(world.toasts.at(-1)).toBe('Watching Harness for the pipeline this push triggers…')

  // The prod deploy finishes in Harness
  world.executions[0].status = 'Success'
  await clock.advance(8000)
  expect(world.requests.length).toBeGreaterThan(before)
  expect(world.toasts.at(-1)).toBe('✓ CI CD #3 Success')

  // While watching, refreshes come every ~10 s instead of every 60 s
  const n = world.requests.length
  await clock.advance(15000)
  expect(world.requests.length).toBeGreaterThan(n)
})

test('other Bash commands are passed through untouched', async ($, on) => {
  const { world, clock } = harnessWorld(on)
  await start($, clock)
  const out: any = await $.tool.call({ tool: 'Bash', command: 'git status' })
  expect(out).toEqual({ result: 'ok' })
  expect(world.toasts.length).toBe(0)
})

test('without configuration the pane shows setup steps', async ($, on) => {
  const { world, clock } = harnessWorld(on, { env: {} })
  await start($, clock)
  expect(world.requests.length).toBe(0)
  expect(world.statuses.at(-1)).toBe('harness: not configured — run /harness for setup')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Not configured yet.' })).toBeDefined()
})

test('an API error shows in the status line and the pane', async ($, on) => {
  const { world, clock } = harnessWorld(on, { httpStatus: 401 })
  await start($, clock)
  expect(world.statuses.at(-1)).toMatch(/^harness: Harness refused the API key \(HTTP 401\)/)
})

test('/harness opens the focused pane in the terminal', async ($, on) => {
  const { world, clock } = harnessWorld(on)
  await start($, clock)
  const out: any = await $.command.run({ command: 'harness', args: '' })
  expect(out).toEqual({})
  expect(world.opened.at(-1)).toMatchObject({ id: 'harness', focus: true })
})

test('/harness answers in text where nothing draws (claude -p, VS Code chat)', async ($, on) => {
  const { world, clock } = harnessWorld(on, { surfaces: [] })
  await start($, clock)
  const opensBefore = world.opened.length
  const out: any = await $.command.run({ command: 'harness', args: '' })
  expect(out.text).toContain('Harness ORG/proj — this repo')
  expect(out.text).toContain('Branch bootcamp-app @ main, HEAD b0b0b0b: ● Running')
  expect(out.text).toContain('↳ Deploy dev: Please Check the timeout')
  expect(out.text).toMatch(/bootcamp-app — dev: ✗ 1-dev \(9d\) \| prod: ● 3-dev \(1m\)/)
  expect(world.opened.length).toBe(opensBefore)
  const all: any = await $.command.run({ command: 'harness', args: 'all' })
  expect(all.text).toContain('whole project')
  expect(all.text).toContain('guestflow_api_pipeline #2')
})

test('/harness without configuration explains setup in text', async ($, on) => {
  const { clock } = harnessWorld(on, { env: {}, surfaces: ['vscode'] })
  await start($, clock)
  const out: any = await $.command.run({ command: 'harness', args: '' })
  expect(out.text).toMatch(/^Harness: not configured/)
})

test('/harness during a background refresh waits for it instead of printing stale data', async ($, on) => {
  const { world, clock } = harnessWorld(on, { surfaces: [], slowMs: 2000 })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(600) // background refresh starts; Harness takes 2 s to answer
  const pendingCmd = $.command.run({ command: 'harness', args: '' })
  await clock.advance(5000) // the core calls, then freeze windows, each 2 s
  const out: any = await pendingCmd
  expect(out.text).toContain('Branch bootcamp-app @ main, HEAD b0b0b0b: ● Running')
  // One refresh, not two: three endpoints, the one-time user lookup, and the two freeze reads
  expect(world.requests.length).toBe(6)
})

test('a rejected key backs off instead of retrying every 5 seconds', async ($, on) => {
  const { world, clock } = harnessWorld(on, { httpStatus: 401, surfaces: [] })
  await start($, clock)
  expect(world.requests.length).toBe(4) // one attempt: three endpoints + user lookup
  // /harness right after shows the error without hitting Harness again
  const out: any = await $.command.run({ command: 'harness', args: '' })
  expect(out.text).toMatch(/refused the API key \(HTTP 401\)/)
  expect(world.requests.length).toBe(4)
  // No 5-second retry storm: next attempt after the poll interval (60 s)…
  await clock.advance(55_000)
  expect(world.requests.length).toBe(4)
  await clock.advance(10_000)
  expect(world.requests.length).toBe(8)
  // …then 120 s after that
  await clock.advance(100_000)
  expect(world.requests.length).toBe(8)
  await clock.advance(30_000)
  expect(world.requests.length).toBe(12)
  // An explicit /harness refresh always tries
  await $.command.run({ command: 'harness', args: 'refresh' })
  expect(world.requests.length).toBe(16)
})

test('unconfigured: no polling at all', async ($, on) => {
  const { world, clock } = harnessWorld(on, { env: {} })
  await start($, clock)
  await clock.advance(10 * 60_000)
  expect(world.requests.length).toBe(0)
})

test('healthy: polls every 60 s, every 10 s while watching a push', async ($, on) => {
  const { world, clock } = harnessWorld(on)
  await start($, clock)
  await clock.advance(58_000)
  expect(world.requests.length).toBe(6) // 3 core + user lookup + 2 freeze reads
  await clock.advance(7_000) // the 5-second scheduler tick at 65 s is the first one past 60 s
  expect(world.requests.length).toBe(9) // user lookup once; freeze is cached for 5 minutes
  await $.tool.call({ tool: 'Bash', command: 'git push' })
  await clock.advance(30_000)
  expect(world.requests.length).toBeGreaterThanOrEqual(13)
})

test('/harness before the startup refresh does not cause a second refresh', async ($, on) => {
  const { world, clock } = harnessWorld(on, { surfaces: [] })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const out: any = await $.command.run({ command: 'harness', args: '' }) // what `claude -p "/harness"` does
  expect(out.text).toContain('this repo')
  await clock.advance(2_000) // the 500 ms startup timer has now fired
  expect(world.requests.length).toBe(6)
})

// ---------------------------------------------------------------- new features

const failHead = (w: any) => { w.executions[0].status = 'Failed'; w.executions[0].layoutNodeMap.b.status = 'Failed'; w.executions[0].layoutNodeMap.b.failureInfo = { message: 'Deployment did not stabilize in 10m' } }

test('diagnose button: diagnoses a failed run with a small model and shows the cause', async ($, on) => {
  const { world, clock } = harnessWorld(on)
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'diag-run2' })
  await clock.settle()
  expect(world.modelCalls.length).toBe(1)
  expect(world.modelCalls[0].model).toBe('haiku')
  expect(world.modelCalls[0].prompt).toContain('stage "Deploy dev": Expired — Please Check the timeout')
  await ui.unmount()
  const ui2 = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // The expanded card shows cause, evidence, likely fix and where it came from
  expect(await ui2.find({ type: 'Text', text: /^Pod taskmanager OOMKilled at startup/ })).toBeDefined()
  expect(await ui2.find({ type: 'Text', text: 'Last State: OOMKilled' })).toBeDefined()
  expect(await ui2.find({ type: 'Text', text: /^Lower CACHE_MAX_ENTRIES/ })).toBeDefined()
  expect(await ui2.find({ type: 'Text', text: 'high confidence · from failure messages only' })).toBeDefined()
  expect(((await ui2.find({ key: 'diag-run2' })) as any)?.props?.label).toBe('diagnose again')
  // Claude sees it through the tool, without another model call
  const out: any = await $.tool.call({ tool: TOOL })
  expect(JSON.parse(out.result).executions.find((x: any) => x.id === 'run2').diagnosis.cause).toMatch(/OOMKilled/)
  expect(world.modelCalls.length).toBe(1)
})

test('/harness diagnose answers in text', async ($, on) => {
  const { clock } = harnessWorld(on, { surfaces: [] })
  await start($, clock)
  const out: any = await $.command.run({ command: 'harness', args: 'diagnose' })
  expect(out.text).toContain('Cause: Pod taskmanager OOMKilled at startup')
  expect(out.text).toContain('high confidence, from failure messages only')
})

test('on_failure=ask: your commit fails → diagnosis → "Let Claude fix it" starts a fix turn', async ($, on) => {
  const { world, clock } = harnessWorld(on, { answer: 'Let Claude fix it' })
  await start($, clock)
  failHead(world)
  await clock.advance(65_000)
  await clock.settle()
  expect(world.asked.at(-1)).toMatch(/^CI CD #3 failed on your commit: Pod taskmanager OOMKilled at startup .*What now\?$/)
  expect(world.prompts.length).toBe(1)
  expect(world.prompts[0]).toContain('Diagnosis: Pod taskmanager OOMKilled')
  expect(world.prompts[0]).toContain('then commit and push')
})

test('on_failure=ask: "Ignore" does nothing more', async ($, on) => {
  const { world, clock } = harnessWorld(on, { answer: 'Ignore' })
  await start($, clock)
  failHead(world)
  await clock.advance(65_000)
  await clock.settle()
  expect(world.asked.length).toBe(1)
  expect(world.prompts.length).toBe(0)
})

test('on_failure=auto: Claude fixes up to the attempt limit, then hands back', async ($, on) => {
  const { world, clock } = harnessWorld(on, { env: { ...ENV, HARNESS_CICD_ON_FAILURE: 'auto' } })
  await start($, clock)
  for (let attempt = 1; attempt <= 3; attempt++) {
    // a new run on HEAD fails each time
    const x = structuredClone(world.executions[0])
    x.planExecutionId = 'fix' + attempt; x.runSequence = 3 + attempt
    x.status = 'Failed'; x.layoutNodeMap.b.status = 'Failed'
    world.executions.unshift(x)
    await clock.advance(65_000)
    await clock.settle()
  }
  expect(world.asked.length).toBe(0)
  expect(world.prompts.length).toBe(2)
  expect(world.prompts[0]).toContain('Auto-fix attempt 1 of 2')
  expect(world.prompts[1]).toContain('Auto-fix attempt 2 of 2')
  expect(world.toasts.at(-1)).toBe('Auto-fix stopped after 2 attempts on CI CD. Over to you.')
})

test('push guard (hold): "Don\'t push" blocks the push and tells Claude why', async ($, on) => {
  const { world, clock } = harnessWorld(on, { answer: "Don't push" })
  failHead(world)
  await start($, clock)
  const out: any = await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
  expect(world.asked[0]).toMatch(/^Claude wants to push, but main is red in Harness: CI CD #3 Failed/)
  expect(out.deny).toMatch(/^The user chose not to push yet: main is red/)
  expect(world.toasts.includes('Watching Harness for the pipeline this push triggers…')).toBe(false)
})

test('push guard (hold): "Push anyway" lets it through and starts watching', async ($, on) => {
  const { world, clock } = harnessWorld(on, { answer: 'Push anyway' })
  failHead(world)
  await start($, clock)
  const out: any = await $.tool.call({ tool: 'Bash', command: 'git push' })
  expect(out).toEqual({ result: 'ok' })
  expect(world.toasts.at(-1)).toBe('Watching Harness for the pipeline this push triggers…')
})

test('push guard: green build, or warn mode, never asks', async ($, on) => {
  const { world, clock } = harnessWorld(on, { env: { ...ENV, HARNESS_CICD_PUSH_GUARD: 'warn' } })
  failHead(world)
  await start($, clock)
  const out: any = await $.tool.call({ tool: 'Bash', command: 'git push' })
  expect(out).toEqual({ result: 'ok' })
  expect(world.asked.length).toBe(0)
  expect(world.toasts[0]).toMatch(/^Pushing while main is red/)
})

test('push guard in claude -p (nobody to ask): the push goes ahead and is logged', async ($, on) => {
  const { world, clock } = harnessWorld(on) // no scripted answer: AskUserQuestion fails
  failHead(world)
  await start($, clock)
  const out: any = await $.tool.call({ tool: 'Bash', command: 'git push' })
  expect(out).toEqual({ result: 'ok' })
  expect(world.logs).toContain('push guard: nobody to ask, so the push goes ahead')
})

test('production guardrail: Harness write to prod asks; Cancel denies', async ($, on) => {
  const { world, clock } = harnessWorld(on, { answer: 'Cancel' })
  await start($, clock)
  const out: any = await $.tool.call({ tool: 'mcp__Harness__harness_execute', action: 'run', resource_id: 'CI_CD', inputs: { env: 'prod' } })
  expect(world.asked[0]).toBe('Claude wants to run harness_execute against production (prod). Allow it?')
  expect(out.deny).toBe('The user did not allow this production action.')
})

test('production guardrail: Allow runs it; non-prod and read tools are never asked', async ($, on) => {
  const { world, clock } = harnessWorld(on, { answer: 'Allow' })
  await start($, clock)
  expect(await $.tool.call({ tool: 'mcp__Harness__harness_execute', action: 'run', inputs: { env: 'prod' } })).toEqual({ result: 'ok' })
  expect(world.asked.length).toBe(1)
  expect(await $.tool.call({ tool: 'mcp__Harness__harness_execute', action: 'run', inputs: { env: 'dev' } })).toEqual({ result: 'ok' })
  expect(await $.tool.call({ tool: 'mcp__Harness__harness_list', resource_type: 'environment', search_term: 'prod' })).toEqual({ result: 'ok' })
  expect(world.asked.length).toBe(1)
})

test('production guardrail with nobody to ask: denied', async ($, on) => {
  const { clock } = harnessWorld(on)
  await start($, clock)
  const out: any = await $.tool.call({ tool: 'mcp__Harness__harness_execute', action: 'rollback', params: { environment: 'production' } })
  expect(out.deny).toMatch(/needs the user to confirm it, but nobody could be asked/)
})

test('automatic context: CI/deploy prompts get one line of Harness state; others none', async ($, on) => {
  const { world, clock } = harnessWorld(on, { behind: '3' })
  world.executions.push({ ...structuredClone(executions[0]), planExecutionId: 'prodok', status: 'Success',
    moduleInfo: { ...executions[0].moduleInfo, ci: { ...executions[0].moduleInfo.ci, ciPipelineStageModuleInfo: { ...executions[0].moduleInfo.ci.ciPipelineStageModuleInfo, commitId: 'c0ffee' } } },
    layoutNodeMap: { b: { ...executions[0].layoutNodeMap.b, status: 'Success' } } })
  await start($, clock)
  await $.prompt.submit({ text: 'deploy this to qa' })
  await $.prompt.submit({ text: 'rename this variable' })
  expect(world.contexts[0].length).toBe(1)
  expect(world.contexts[0][0]).toMatch(/^\[Harness, from the harness-cicd plugin\] bootcamp-app@main \(HEAD b0b0b0b\): HEAD is CI CD #3 Running/)
  expect(world.contexts[0][0]).toContain('prod is 3 commits behind HEAD')
  expect(world.contexts[1].length).toBe(0)
  // …and the same number shows in the pane and the tool
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'prod 3 behind' })).toBeDefined()
  const s = JSON.parse(((await $.tool.call({ tool: TOOL })) as any).result)
  expect(s.prod_commits_behind_head).toBe(3)
})

// ---------------------------------------------------------------- round 2: your design picks

const reqs = (w: any, part: string) => w.requests.filter((r: any) => r.url.includes(part))

test('layout is a preference: v cycles stacked → focus → dock → strip and it is saved', async ($, on) => {
  const { world, clock } = harnessWorld(on)
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(((await ui.find({ key: 'layout' })) as any)?.props?.label).toBe('Layout: stacked')
  await ui.press({ key: 'layout' })
  await clock.settle()
  expect(world.store.get('layout')).toBe('focus')
  expect(await ui.find({ type: 'Text', text: '● Building your commit b0b0b0b: CI CD #3 · 3m.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^▸ deployed: bootcamp-app/ })).toBeDefined()
  await ui.press({ key: 'layout' })
  await clock.settle()
  expect(world.store.get('layout')).toBe('dock')
  expect(world.opened.at(-1)).toMatchObject({ id: 'harness', columns: 72, focus: true }) // reopened for docking
  await ui.press({ key: 'layout' })
  await clock.settle()
  expect(world.store.get('layout')).toBe('strip')
  const out: any = await $.command.run({ command: 'harness', args: 'layout nope' })
  expect(out.text).toBe('Layouts: stacked, focus, dock, strip (now: strip). Use /harness layout <name>, or press v in the pane.')
})

test('a saved layout is used next session; strip-first does not open the pane at start', async ($, on) => {
  const { world, clock } = harnessWorld(on, { store: { layout: 'strip' } })
  await start($, clock)
  expect(world.opened.length).toBe(0)
  const out: any = await $.command.run({ command: 'harness', args: 'layout focus' })
  expect(out.text).toBe('Layout: focus.')
})

test('docked layout: narrow rows and a deployed tab', async ($, on) => {
  const { clock } = harnessWorld(on, { store: { layout: 'dock' } })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, placement: 'dock', bodyColumns: 70 } })
  expect(await ui.find({ type: 'Text', text: /^CI CD #3 +Running +3m$/ })).toBeDefined()
  await ui.press({ key: 'tab' })
  expect(await ui.find({ type: 'Text', text: /^  ★ prod/ })).toBeDefined()
})

test('focus layout when your commit failed: headline plus the diagnosis card', async ($, on) => {
  const { world, clock } = harnessWorld(on, { store: { layout: 'focus' } })
  failHead(world)
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '✗ Your commit b0b0b0b failed: CI CD #3 Failed.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Deploy prod: Deployment did not stabilize/ })).toBeDefined()
})

test('select a row, then act: j/k move the selection, a opens that run\'s actions', async ($, on) => {
  const { clock } = harnessWorld(on)
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'actions' }) // selection starts on the failed run
  expect(await ui.find({ key: 'act-retry' })).toBeDefined()
  expect(await ui.find({ key: 'act-diagnose' })).toBeDefined()
  await ui.press({ key: 'sel-down' }) // → CI CD #1, Success; moving closes the menu
  expect(await ui.find({ key: 'act-retry' })).toBeUndefined()
  await ui.press({ key: 'actions' })
  expect(await ui.find({ key: 'act-rerun' })).toBeDefined()
  expect(await ui.find({ key: 'act-retry' })).toBeUndefined()
  await ui.press({ key: 'sel-up' }); await ui.press({ key: 'sel-up' }) // → CI CD #3, Running
  await ui.press({ key: 'actions' })
  expect(await ui.find({ key: 'act-abort' })).toBeDefined()
  await ui.press({ key: 'act-close' })
  expect(await ui.find({ key: 'act-abort' })).toBeUndefined()
})

test('e collapses and re-expands the diagnosis card', async ($, on) => {
  const { clock } = harnessWorld(on)
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^Deploy dev: Please Check/ })).toBeDefined()
  await ui.press({ key: 'expand' })
  expect(await ui.find({ type: 'Text', text: /^Deploy dev: Please Check/ })).toBeUndefined()
  await ui.press({ key: 'expand' })
  expect(await ui.find({ type: 'Text', text: /^Deploy dev: Please Check/ })).toBeDefined()
})

test('write actions are off by default and say how to turn them on', async ($, on) => {
  const { world, clock } = harnessWorld(on)
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'actions' })
  expect(((await ui.find({ key: 'act-retry' })) as any)?.props?.label).toBe('t  Retry failed stages  (off: allow_actions)')
  await ui.press({ key: 'act-retry' })
  expect(world.toasts.at(-1)).toBe('Actions are off. Turn on "allow_actions" in /plugin configure harness-cicd@harness-tools.')
  expect(reqs(world, '/execute/retry/').length).toBe(0)
})

const ON = { ...ENV, HARNESS_CICD_ALLOW_ACTIONS: '1' }

test('retry failed stages: confirm, then POST retry with the failed stage ids', async ($, on) => {
  const { world, clock } = harnessWorld(on, { env: ON, answer: 'Retry' })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'actions' })
  await ui.press({ key: 'act-retry' })
  await clock.settle()
  expect(world.asked[0]).toBe('Retry the failed stages of CI CD #2 (Deploy_dev)?')
  const r = reqs(world, '/pipeline/api/pipeline/execute/retry/CI_CD?')
  expect(r.length).toBe(1)
  expect(r[0].init.method).toBe('POST')
  expect(r[0].url).toContain('planExecutionId=run2')
  expect(r[0].url).toContain('retryStages=Deploy_dev')
  expect(r[0].url).toContain('runAllStages=false')
  expect(r[0].init.headers['Content-Type']).toBe('application/yaml')
  expect(world.toasts.at(-1)).toBe('✓ Retrying CI CD #2')
})

test('cancel means nothing is sent', async ($, on) => {
  const { world, clock } = harnessWorld(on, { env: ON, answer: 'Cancel' })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'actions' }); await ui.press({ key: 'act-retry' }); await clock.settle()
  expect(reqs(world, '/execute/').length).toBe(0)
})

test('production gets a second confirmation', async ($, on) => {
  const { world, clock } = harnessWorld(on, { env: ON, answer: ['Retry', 'Cancel'] })
  failHead(world) // CI CD #3 deploys to prod
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'actions' }); await ui.press({ key: 'act-retry' }); await clock.settle()
  expect(world.asked).toEqual(['Retry the failed stages of CI CD #3 (Deploy_prod)?', 'This deploys to production (prod). Are you sure?'])
  expect(reqs(world, '/execute/retry/').length).toBe(0)
})

test('production confirmed twice: the retry goes out', async ($, on) => {
  const { world, clock } = harnessWorld(on, { env: ON, answer: ['Retry', 'Yes, deploy to production'] })
  failHead(world)
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'actions' }); await ui.press({ key: 'act-retry' }); await clock.settle()
  expect(reqs(world, '/execute/retry/').length).toBe(1)
})

test('abort a running run: PUT interrupt AbortAll', async ($, on) => {
  const { world, clock } = harnessWorld(on, { env: ON, answer: 'Abort' })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'sel-up' })
  await ui.press({ key: 'actions' }); await ui.press({ key: 'act-abort' }); await clock.settle()
  const r = reqs(world, '/pipeline/api/pipeline/execute/interrupt/run5?')
  expect(r.length).toBe(1)
  expect(r[0].init.method).toBe('PUT')
  expect(r[0].url).toContain('interruptType=AbortAll')
})

const awaitApproval = (w: any) => { w.executions[0].status = 'ApprovalWaiting'; w.executions[0].layoutNodeMap.b.status = 'ApprovalWaiting' }

test('approvals: the waiting approval is fetched with the documented request', async ($, on) => {
  const { world, clock } = harnessWorld(on, { env: ON })
  awaitApproval(world)
  await start($, clock)
  const r = reqs(world, '/pipeline/api/v1/orgs/ORG/projects/proj/approvals/execution/run5?')
  expect(r.length).toBe(1)
  expect(r[0].url).toContain('approval_status=WAITING')
  expect(r[0].url).toContain('accountIdentifier=ACC123')
  expect(r[0].init.headers['Harness-Account']).toBe('ACC123')
  expect(r[0].init.headers['x-api-key']).toBe('pat.ACC123.tok.secret')
  // Runs that aren't waiting are never asked about
  expect(reqs(world, '/approvals/execution/run2').length).toBe(0)
  expect(world.statuses.at(-1)).toContain('1 approval waiting')
})

test('approvals: the pane shows what is waiting, what it asks for, and who can approve', async ($, on) => {
  const { world, clock } = harnessWorld(on, { env: ON })
  awaitApproval(world)
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^── APPROVALS WAITING · 1 ─+$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'CI CD #3  bootcamp-app→prod  expires in 2h 59m · waiting 20m' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '    Approve deploy of 3-dev to prod?' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '    approvers: _project_all_users, release-managers · asks for: version' })).toBeDefined()
  expect(await ui.find({ key: 'appr-ap1' })).toBeDefined()
  expect(await ui.find({ key: 'rej-ap1' })).toBeDefined()
})

test('approvals: read-only until allow_actions is on', async ($, on) => {
  const { world, clock } = harnessWorld(on)
  awaitApproval(world)
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'appr-ap1' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'approve/reject: turn on allow_actions' })).toBeDefined()
})

test('approve: confirm, fill the approver input, confirm production, then POST the activity', async ($, on) => {
  const { world, clock } = harnessWorld(on, { env: ON, answer: ['Approve', '3-dev-hotfix', 'Yes, approve for production'] })
  awaitApproval(world)
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'appr-ap1' })
  await clock.settle()
  expect(world.asked).toEqual([
    'Approve CI CD #3: "Approve deploy of 3-dev to prod?"?',
    'Value for "version"?',
    'This lets CI CD #3 deploy to production (prod). Approve it?',
  ])
  const post = reqs(world, '/pipeline/api/approvals/ap1/harness/activity')
  expect(post.length).toBe(1)
  expect(post[0].init.method).toBe('POST')
  expect(JSON.parse(post[0].init.body)).toEqual({ action: 'APPROVE', comments: 'From Claude Code (harness-cicd)', approverInputs: [{ name: 'version', value: '3-dev-hotfix' }] })
  expect(world.toasts.at(-1)).toBe('✓ Approved CI CD #3')
  expect(await ui.find({ key: 'appr-ap1' })).toBeUndefined() // gone from the pane straight away
})

test('approve: Cancel at any step sends nothing', async ($, on) => {
  const { world, clock } = harnessWorld(on, { env: ON, answer: ['Approve', 'Cancel'] })
  awaitApproval(world)
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'appr-ap1' }); await clock.settle()
  expect(reqs(world, '/harness/activity').length).toBe(0)
})

test('reject: one confirmation, no inputs, no production prompt', async ($, on) => {
  const { world, clock } = harnessWorld(on, { env: ON, answer: ['Reject'] })
  awaitApproval(world)
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'rej-ap1' }); await clock.settle()
  expect(world.asked.length).toBe(1)
  expect(JSON.parse(reqs(world, '/pipeline/api/approvals/ap1/harness/activity')[0].init.body)).toEqual({ action: 'REJECT', comments: 'From Claude Code (harness-cicd)' })
  expect(world.toasts.at(-1)).toBe('✓ Rejected CI CD #3')
})

test('approve from the actions menu (a → p) uses the same flow', async ($, on) => {
  const { world, clock } = harnessWorld(on, { env: ON, answer: ['Approve', '3-dev', 'Yes, approve for production'] })
  awaitApproval(world)
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'sel-up' })
  await ui.press({ key: 'actions' }); await ui.press({ key: 'act-approve' }); await clock.settle()
  expect(JSON.parse(reqs(world, '/harness/activity')[0].init.body).approverInputs).toEqual([{ name: 'version', value: '3-dev' }])
})

test('not an approver: Harness\'s own message is shown', async ($, on) => {
  const { world, clock } = harnessWorld(on, { env: ON, answer: ['Reject'] })
  awaitApproval(world)
  world.approvalPost = { status: 403, text: JSON.stringify({ status: 'ERROR', code: 'ACCESS_DENIED', message: 'User not authorized to approve/reject' }) }
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'rej-ap1' }); await clock.settle()
  expect(world.toasts.at(-1)).toBe("✗ Couldn't reject CI CD #3: User not authorized to approve/reject (HTTP 403)")
})

test('Jira and ServiceNow approvals point you to where they are decided', async ($, on) => {
  const { world, clock } = harnessWorld(on, { env: ON })
  awaitApproval(world)
  world.approvalList = [{ id: 'j1', type: 'JiraApproval', status: 'WAITING', deadline: 0, created: T0 - 60_000, details: {} }]
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'decide in Jira' })).toBeDefined()
  expect(await ui.find({ key: 'appr-j1' })).toBeUndefined()
})

test('a new approval is announced once, in a toast and the band', async ($, on) => {
  const { world, clock } = harnessWorld(on, { env: ON })
  await start($, clock)
  awaitApproval(world)
  await clock.advance(65_000)
  expect(world.toasts.filter((t: string) => t.startsWith('◆')).length).toBe(1)
  expect(world.toasts.at(-1)).toBe('◆ CI CD #3 is waiting for approval to deploy to prod')
  await clock.advance(65_000)
  expect(world.toasts.filter((t: string) => t.startsWith('◆')).length).toBe(1)
  const band = await $.ui.mount({ plugin: 'harness-cicd', component: 'AbovePrompt', surface: 'terminal', viewport: { columns: 140, rows: 40 },
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 140, scroll: { offset: 0, bodyRows: 9 } } as any })
  expect(await band.find({ type: 'Text', text: '◆ 1 approval waiting' })).toBeDefined()
})

test('Claude sees waiting approvals in harness_status', async ($, on) => {
  const { world, clock } = harnessWorld(on)
  awaitApproval(world)
  await start($, clock)
  const s = JSON.parse(((await $.tool.call({ tool: TOOL })) as any).result)
  expect(s.approvals_waiting).toEqual([{
    run: 'CI CD #3', execution_id: 'run5', approval_id: 'ap1', type: 'HarnessApproval', message: 'Approve deploy of 3-dev to prod?',
    approvers: ['_project_all_users', 'release-managers'], minimum: 1, inputs: ['version'], expires: 'expires in 2h 59m', deploys_to: ['prod'],
    url: 'https://app.harness.io/ng/account/ACC123/all/orgs/ORG/projects/proj/pipelines/CI_CD/deployments/run5/pipeline',
  }])
})

test('production guardrail: Claude approving a prod-bound run through the Harness MCP server asks you', async ($, on) => {
  const { world, clock } = harnessWorld(on, { answer: 'Cancel' })
  awaitApproval(world)
  await start($, clock)
  const out: any = await $.tool.call({ tool: 'mcp__Harness__harness_execute', resource_type: 'approval_instance', action: 'approve', approval_id: 'ap1' })
  expect(world.asked[0]).toBe('Claude wants to run harness_execute against production (prod). Allow it?')
  expect(out.deny).toBe('The user did not allow this production action.')
})

test('when your build fails, "Always auto-fix" switches to auto and remembers it', async ($, on) => {
  const { world, clock } = harnessWorld(on, { answer: 'Always auto-fix' })
  await start($, clock)
  failHead(world)
  await clock.advance(65_000)
  await clock.settle()
  expect(world.asked[0]).toMatch(/What now\?$/)
  expect(world.store.get('on_failure')).toBe('auto')
  expect(world.prompts[0]).toContain('Auto-fix attempt 1 of 2')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^auto-fix on · updated/ })).toBeDefined()
  const off: any = await $.command.run({ command: 'harness', args: 'autofix off' })
  expect(off.text).toBe('Auto-fix off.')
  expect(world.store.get('on_failure')).toBe('ask')
})

test('band above the prompt: your commit, a sparkline, prod lag, and h opens the pane', async ($, on) => {
  const { world, clock } = harnessWorld(on, { behind: '2' })
  world.executions.push({ ...structuredClone(executions[0]), planExecutionId: 'prodok', status: 'Success', startTs: T0 - 2 * 86400_000,
    moduleInfo: { ...executions[0].moduleInfo, ci: { ...executions[0].moduleInfo.ci, ciPipelineStageModuleInfo: { ...executions[0].moduleInfo.ci.ciPipelineStageModuleInfo, commitId: 'c0ffee' } } },
    layoutNodeMap: { b: { ...executions[0].layoutNodeMap.b, status: 'Success' } } })
  await start($, clock)
  const band = await $.ui.mount({ plugin: 'harness-cicd', component: 'AbovePrompt', surface: 'terminal', viewport: { columns: 140, rows: 40 },
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 140, scroll: { offset: 0, bodyRows: 9 } } as any })
  expect(await band.find({ type: 'Text', text: '● main@b0b0b0b Running #3' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: '▂' })).toBeDefined() // oldest: the successful prod deploy
  expect(await band.find({ type: 'Text', text: '█' })).toBeDefined() // the expired run
  expect(await band.find({ type: 'Text', text: 'prod 2 behind' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: '(engine band)' })).toBeDefined() // core's own band stays
  await band.press({ key: 'band-open' })
  expect(world.opened.at(-1)).toMatchObject({ id: 'harness', focus: true })
})

test('band yields to a survey', async ($, on) => {
  const { clock } = harnessWorld(on)
  await start($, clock)
  const band = await $.ui.mount({ plugin: 'harness-cicd', component: 'AbovePrompt', surface: 'terminal', viewport: { columns: 140, rows: 40 },
    props: { hasSurvey: true, isWorking: false, maxRows: 10, bodyColumns: 140, scroll: { offset: 0, bodyRows: 9 } } as any })
  expect(await band.find({ key: 'band-open' })).toBeUndefined()
  expect(await band.find({ type: 'Text', text: '(engine band)' })).toBeDefined()
})

// ---------------------------------------------------------------- doctor, runtime inputs, freeze, sign-in, PRs

test('/harness doctor: read-only checks with a clear verdict for each', async ($, on) => {
  const { world, clock } = harnessWorld(on, { surfaces: [] })
  world.template = 'pipeline:\n  identifier: CI_CD\n  stages:\n    - stage:\n        identifier: Deploy\n        spec:\n          tag: <+input>'
  await start($, clock)
  const out: any = await $.command.run({ command: 'harness', args: 'doctor' })
  const t = out.text as string
  expect(t.split('\n')[0]).toBe('Harness doctor · ORG/proj · https://app.harness.io')
  expect(t).toContain('✓ Auth — API key (pat…), account ACC123')
  expect(t).toContain('✓ Pipeline runs — 5 recent runs, 3 from this repo')
  expect(t).toContain('✓ Services & environments — 2 services, 3 environments (1 production)')
  expect(t).toContain('✓ User — dev@example.com')
  expect(t).toContain('✓ Git — bootcamp-app @ main b0b0b0b')
  expect(t).toContain('✗ Step details —') // the stub has no execution graph: reported, with the fallback
  expect(t).toMatch(/✓ Approvals API — readable \(\d+ waiting on CI CD #2\)/)
  expect(t).toContain('✓ Freeze windows — none active')
  expect(t).toContain('· Runtime inputs: CI_CD — 1 (tag): rerun/retry reuse the original run\'s inputs, and ask for any it lacks')
  expect(t).toContain('· Pull requests — repo host not supported (Harness Code or GitHub)')
  expect(t).toContain('· Behaviour — diagnose auto · on failure ask · push guard hold · prod guard on · actions off')
  // Doctor never writes
  expect(world.requests.every((r: any) => (r.init?.method ?? 'GET') !== 'PUT' && !/execute|activity/.test(r.url))).toBe(true)
})

test('rerun reuses the inputs the run used', async ($, on) => {
  const { world, clock } = harnessWorld(on, { env: ON, answer: 'Rerun' })
  world.inputs = 'pipeline:\n  identifier: CI_CD\n  variables:\n    - name: reason\n      value: nightly'
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'sel-down' }) // CI CD #1, Success → rerun
  await ui.press({ key: 'actions' }); await ui.press({ key: 'act-rerun' }); await clock.settle()
  const r = reqs(world, '/pipeline/api/pipeline/execute/rerun/run1/CI_CD')
  expect(r.length).toBe(1)
  expect(r[0].init.body).toBe(world.inputs)
  expect(r[0].init.headers['Content-Type']).toBe('application/yaml')
  expect(world.toasts.at(-1)).toBe('✓ Rerunning CI CD #1 with the inputs it used')
})

test('retry asks for runtime inputs when the run has none recorded', async ($, on) => {
  const { world, clock } = harnessWorld(on, { env: ON, answer: ['Retry', 'stable'] })
  world.template = 'pipeline:\n  identifier: CI_CD\n  stages:\n    - stage:\n        identifier: Deploy\n        spec:\n          tag: <+input>.allowedValues(latest,stable)'
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'actions' }); await ui.press({ key: 'act-retry' }); await clock.settle()
  expect(world.asked[1]).toBe('Runtime input "tag" (Deploy)?')
  const r = reqs(world, '/execute/retry/CI_CD')
  expect(r[0].init.body).toContain('tag: stable')
  expect(world.toasts.at(-1)).toBe('✓ Retrying CI CD #2 with your inputs')
})

test('too many runtime inputs: hands off instead of a long quiz', async ($, on) => {
  const { world, clock } = harnessWorld(on, { env: ON, answer: 'Retry' })
  world.template = 'pipeline:\n' + Array.from({ length: 8 }, (_, i) => `  v${i}: <+input>`).join('\n')
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'actions' }); await ui.press({ key: 'act-retry' }); await clock.settle()
  expect(reqs(world, '/execute/retry/').length).toBe(0)
  expect(world.toasts.at(-1)).toBe('CI CD #2 needs 8 runtime inputs: run it from Harness, or ask Claude to run it with the inputs.')
})

const activeFreeze = (w: any) => { w.freezeList = [{ identifier: 'q4', name: 'Q4 freeze', status: 'Enabled', currentOrUpcomingWindow: { startTime: T0 - 3600_000, endTime: T0 + 2 * 3600_000 } }] }

test('freeze: shown everywhere, blocks production actions, warns on others', async ($, on) => {
  const { world, clock } = harnessWorld(on, { env: ON, answer: ['Retry'] })
  activeFreeze(world)
  failHead(world) // CI CD #3 → prod
  await start($, clock)
  expect(world.statuses.at(-1)).toMatch(/^harness: ❄ Q4 freeze until 2026-10-05 14:00 UTC · main@b0b0b0b/)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^❄ Q4 freeze until .* · updated now$/ })).toBeDefined()
  // production retry is blocked outright
  await ui.press({ key: 'actions' }); await ui.press({ key: 'act-retry' }); await clock.settle()
  expect(world.asked.length).toBe(0)
  expect(world.toasts.at(-1)).toMatch(/^❄ Q4 freeze .*: not running CI CD #3, it deploys to production/)
  // a dev retry is allowed, with the freeze named in the confirmation
  await ui.press({ key: 'sel-down' })
  await ui.press({ key: 'actions' }); await ui.press({ key: 'act-retry' }); await clock.settle()
  expect(world.asked[0]).toBe('Retry the failed stages of CI CD #2 (Deploy_dev) (❄ Q4 freeze until 2026-10-05 14:00 UTC is active)?')
})

test('freeze: Claude\'s production actions through the Harness MCP server are refused, not asked', async ($, on) => {
  const { world, clock } = harnessWorld(on, { answer: 'Allow' })
  activeFreeze(world)
  await start($, clock)
  const out: any = await $.tool.call({ tool: 'mcp__Harness__harness_execute', action: 'run', inputs: { env: 'prod' } })
  expect(world.asked.length).toBe(0)
  expect(out.deny).toMatch(/^A deployment freeze is active \(Q4 freeze until .*\)\. This Harness action targets production \(prod\), so it was not run/)
  const s = JSON.parse(((await $.tool.call({ tool: TOOL })) as any).result)
  expect(s.freeze.active[0].name).toBe('Q4 freeze')
})

test('freeze: an enabled but future window is not active', async ($, on) => {
  const { world, clock } = harnessWorld(on, { surfaces: [] })
  world.freezeList = [{ identifier: 'later', name: 'Holiday freeze', status: 'Enabled', currentOrUpcomingWindow: { startTime: T0 + 86400_000, endTime: T0 + 2 * 86400_000 } }]
  await start($, clock)
  expect(world.statuses.at(-1)).not.toContain('❄')
  const out: any = await $.command.run({ command: 'harness', args: 'doctor' })
  expect(out.text).toContain('✓ Freeze windows — none active, next: Holiday freeze')
})

// Sign-in mode: no API key, everything through Harness's MCP server (Claude Code's OAuth connection)
const mcpHarness = (w: any) => (tool: string, args: any) => {
  if (tool === 'harness_list' && args.resource_type === 'execution') return { items: w.executions.map((x: any) => ({ ...x, openInHarness: `https://app.harness.io/ng/account/ACC123/all/orgs/ORG/projects/proj/pipelines/${x.pipelineIdentifier}/deployments/${x.planExecutionId}/pipeline` })), total: 5 }
  if (tool === 'harness_list' && args.resource_type === 'service') return { items: services, total: 2 }
  if (tool === 'harness_list' && args.resource_type === 'environment') return { items: environments, total: 3 }
  if (tool === 'harness_list' && args.resource_type === 'approval_instance') return { items: w.approvalList, total: w.approvalList.length }
  if (tool === 'harness_list' && args.resource_type === 'freeze_window') return { items: [], total: 0 }
  if (tool === 'harness_get' && args.resource_type === 'global_freeze') return { status: 'Disabled' }
  if (tool === 'harness_get' && args.resource_type === 'execution_inputs') return { inputSetYaml: '' }
  if (tool === 'harness_get' && args.resource_type === 'runtime_input_template') return { inputSetTemplateYaml: '' }
  return { ok: true }
}
const SIGNIN = { HARNESS_DEFAULT_PROJECT_ID: 'proj', HARNESS_DEFAULT_ORG_ID: 'ORG', HARNESS_CICD_ALLOW_ACTIONS: '1' }

test('sign-in mode: no API key, data comes through the Harness MCP server', async ($, on) => {
  let w: any
  const { world, clock } = harnessWorld(on, { env: SIGNIN, mcp: (t, a) => mcpHarness(w)(t, a) })
  w = world
  await start($, clock)
  expect(world.requests.length).toBe(0) // no REST calls at all
  const lists = world.mcpCalls.filter((c: any) => c.tool === 'harness_list').map((c: any) => c.args.resource_type)
  expect(lists).toEqual(expect.arrayContaining(['execution', 'service', 'environment', 'freeze_window']))
  expect(world.mcpCalls[0]).toMatchObject({ server: 'plugin:harness-cicd:harness', args: { org_id: 'ORG', project_id: 'proj', compact: false } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^CI CD #3 / })).toBeDefined()
  // account id learned from Harness's own links
  expect(((await ui.find({ type: 'Link', label: 'open in Harness' } as any)) as any)?.props?.href).toContain('/ng/account/ACC123/')
})

test('sign-in mode: actions go through harness_execute', async ($, on) => {
  let w: any
  const { world, clock } = harnessWorld(on, { env: SIGNIN, mcp: (t, a) => mcpHarness(w)(t, a), answer: 'Abort' })
  w = world
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'sel-up' })
  await ui.press({ key: 'actions' }); await ui.press({ key: 'act-abort' }); await clock.settle()
  const ex = world.mcpCalls.find((c: any) => c.tool === 'harness_execute')
  expect(ex.args).toMatchObject({ resource_type: 'execution', action: 'interrupt', resource_id: 'run5', params: { interrupt_type: 'AbortAll' }, confirm: true })
  expect(world.toasts.at(-1)).toBe('✓ Aborted CI CD #3')
})

test('sign-in mode: approvals list and decide through the MCP server', async ($, on) => {
  let w: any
  const { world, clock } = harnessWorld(on, { env: SIGNIN, mcp: (t, a) => mcpHarness(w)(t, a), answer: ['Reject'] })
  w = world
  awaitApproval(world)
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'rej-ap1' }); await clock.settle()
  const ex = world.mcpCalls.find((c: any) => c.tool === 'harness_execute')
  expect(ex.args).toMatchObject({ resource_type: 'approval_instance', action: 'reject', params: { approval_id: 'ap1' }, body: { comments: 'From Claude Code (harness-cicd)' }, confirm: true })
})

test('sign-in mode, not signed in yet: says exactly what to do', async ($, on) => {
  const { world, clock } = harnessWorld(on, { env: SIGNIN })
  await start($, clock)
  expect(world.statuses.at(-1)).toMatch(/^harness: Harness sign-in needed: run \/mcp, choose the Harness server, Authenticate/)
  const out: any = await $.command.run({ command: 'harness', args: 'doctor' })
  expect(out.text).toMatch(/✗ Pipelines API — Harness sign-in needed: .*\[.+\]/) // with the underlying error
})

test('pull request (Harness Code): checks and review on the branch row, the band and the status line', async ($, on) => {
  const { world, clock } = harnessWorld(on, { remote: 'https://git.harness.io/ACC123/ORG/bootcamp-app.git' })
  world.prList = [{ number: 7, title: 'Faster cache', state: 'open', source_branch: 'main', target_branch: 'release', is_draft: false }, { number: 6, source_branch: 'other', state: 'open' }]
  world.prChecks = { commit_sha: 'b0b0', checks: [{ required: true, check: { identifier: 'ci', status: 'failure' } }, { check: { identifier: 'lint', status: 'success' } }] }
  world.prReviewers = [{ reviewer: { display_name: 'Ana' }, review_decision: 'pending' }]
  await start($, clock)
  expect(reqs(world, '/code/api/v1/repos/ACC123/ORG/bootcamp-app/+/pullreq?').length).toBe(1)
  expect(reqs(world, '/code/api/v1/repos/ACC123/ORG/bootcamp-app/+/pullreq/7/checks').length).toBe(1)
  expect(world.statuses.at(-1)).toContain('PR #7 ✗ 1 failing')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'PR #7 → release: 1 check failing · review pending (ci)' })).toBeDefined()
  expect(((await ui.find({ type: 'Link', label: 'open', href: 'https://app.harness.io/ng/account/ACC123/module/code/orgs/ORG/repos/bootcamp-app/pulls/7' } as any)) as any)).toBeDefined()
  const s = JSON.parse(((await $.tool.call({ tool: TOOL })) as any).result)
  expect(s.pull_request).toMatchObject({ number: 7, target: 'release', review: 'review pending', checks: ['ci: failure', 'lint: success'] })
})

test('pull request (GitHub): read with the gh CLI', async ($, on) => {
  const { world, clock } = harnessWorld(on, { remote: 'git@github.com:acme/bootcamp-app.git' })
  world.gh = { exitCode: 0, stderr: '', stdout: JSON.stringify({ number: 42, title: 'x', state: 'OPEN', isDraft: true, reviewDecision: 'APPROVED', baseRefName: 'main', url: 'https://github.com/acme/bootcamp-app/pull/42', statusCheckRollup: [{ name: 'build', conclusion: 'SUCCESS' }] }) }
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'PR #42 (draft) → main: checks passing · approved' })).toBeDefined()
})

test('pull request: none open is quiet', async ($, on) => {
  const { world, clock } = harnessWorld(on, { remote: 'git@github.com:acme/bootcamp-app.git' })
  await start($, clock)
  expect(world.statuses.at(-1)).not.toContain('PR #')
})
