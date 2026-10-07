// Shapes copied from live Harness NG responses (execution summary, servicesV2, environmentsV2),
// trimmed and anonymized.

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0)
export const T0 = NOW
const min = 60_000

const ciModule = (repoPath: string, repoShort: string, branch: string, commit: string, msg: string) => ({
  ci: {
    branch, buildType: 'branch', repoName: repoShort,
    ciPipelineStageModuleInfo: {
      stageId: 'build', stageName: 'Build', status: 'SUCCEEDED', branch, sourceBranch: branch,
      commitId: commit, commitMessage: msg + '\n', repoName: repoPath,
      repoUrl: `https://git.example.com/ACC123/${repoPath}`,
    },
    scmDetailsList: [{ scmUrl: `https://git.example.com/ACC123/${repoPath}.git`, scmProvider: 'Harness' }],
  },
})

const ciNode = (status: string, start: number) => ({
  nodeType: 'CI', nodeGroup: 'STAGE', nodeIdentifier: 'build', name: 'Build', status, module: 'ci',
  moduleInfo: { ci: {} }, startTs: start, endTs: start + 2 * min, failureInfo: { message: '' },
})

const cdNode = (status: string, start: number, env: string, envType: string, tag: string, failure = '') => ({
  nodeType: 'Deployment', nodeGroup: 'STAGE', nodeIdentifier: 'Deploy_' + env, name: 'Deploy ' + env, status, module: 'cd',
  moduleInfo: {
    cd: {
      serviceInfo: {
        identifier: 'bootcampapp', displayName: 'bootcamp-app', deploymentType: 'Kubernetes',
        artifacts: { primary: { tag, image: `pkg.example.com/acc/ar/taskmanager:${tag}` }, artifactDisplayName: `ar/taskmanager:${tag}` },
      },
      infraExecutionSummary: { identifier: env, name: env, type: envType, infrastructureIdentifier: env + '_k8s', infrastructureName: env + '_k8s' },
    },
  },
  startTs: start, endTs: start + 5 * min, failureInfo: { message: failure },
})

const exec = (o: any) => ({
  orgIdentifier: 'ORG', projectIdentifier: 'proj', yamlVersion: '0', tags: [],
  executionTriggerInfo: { triggerType: 'MANUAL', triggeredBy: { identifier: 'Dev User', extraInfo: { email: 'dev@example.com' } } },
  ...o,
})

export const executions = [
  // Running deploy of bootcamp-app to prod (newest)
  exec({
    pipelineIdentifier: 'CI_CD', name: 'CI CD', planExecutionId: 'run5', runSequence: 3, status: 'Running',
    startTs: NOW - 3 * min, moduleInfo: { ...ciModule('ORG/bootcamp-app', 'org.bootcamp-app', 'main', 'b0b0b0b0b0b0b0b0', 'feat: faster'), cd: { serviceIdentifiers: ['bootcampapp'], envIdentifiers: ['prod'] } },
    layoutNodeMap: { a: ciNode('Success', NOW - 3 * min), b: cdNode('Running', NOW - 1 * min, 'prod', 'Production', '3-dev') },
  }),
  exec({
    pipelineIdentifier: 'guestflow_api_pipeline', name: 'guestflow_api_pipeline', planExecutionId: 'run4', runSequence: 2, status: 'Success',
    startTs: NOW - 2 * 60 * min, moduleInfo: ciModule('ORG/proj/guest_flow', 'guest_flow', 'main', 'cc6d11f2644ab0fe864f87458e5881ebbe8cf1fd', 'chore: update OpenAPI spec'),
    layoutNodeMap: { a: ciNode('Success', NOW - 2 * 60 * min) },
  }),
  exec({
    pipelineIdentifier: 'guestflow_api_pipeline', name: 'guestflow_api_pipeline', planExecutionId: 'run3', runSequence: 1, status: 'IgnoreFailed',
    startTs: NOW - 3 * 60 * min, moduleInfo: ciModule('ORG/proj/guest_flow', 'guest_flow', 'main', 'cc6d11f2644ab0fe864f87458e5881ebbe8cf1fd', 'chore: update OpenAPI spec'),
    layoutNodeMap: { a: ciNode('IgnoreFailed', NOW - 3 * 60 * min) },
  }),
  exec({
    pipelineIdentifier: 'CI_CD', name: 'CI CD', planExecutionId: 'run2', runSequence: 2, status: 'Expired',
    startTs: NOW - 10 * 1440 * min,
    moduleInfo: { ...ciModule('ORG/bootcamp-app', 'org.bootcamp-app', 'main', 'a99212271ccf98e1', 'temp: add junit sample'), cd: { serviceIdentifiers: ['bootcampapp'], envIdentifiers: ['dev'] } },
    layoutNodeMap: {
      a: ciNode('Success', NOW - 10 * 1440 * min),
      b: cdNode('Expired', NOW - 10 * 1440 * min + 2 * min, 'dev', 'PreProduction', '1-dev', 'Please Check the timeout configuration on the step to extend the duration of the step'),
    },
  }),
  exec({
    pipelineIdentifier: 'CI_CD', name: 'CI CD', planExecutionId: 'run1', runSequence: 1, status: 'Success',
    startTs: NOW - 11 * 1440 * min,
    moduleInfo: { ...ciModule('ORG/bootcamp-app', 'org.bootcamp-app', 'main', 'a99212271ccf98e1', 'temp: add junit sample'), cd: { serviceIdentifiers: ['bootcampapp'], envIdentifiers: ['dev'] } },
    layoutNodeMap: { a: ciNode('Success', NOW - 11 * 1440 * min), b: cdNode('Success', NOW - 11 * 1440 * min + 2 * min, 'dev', 'PreProduction', '0-dev') },
  }),
]

export const services = [
  {
    service: {
      identifier: 'bootcampapp', name: 'bootcamp-app', orgIdentifier: 'ORG', projectIdentifier: 'proj',
      yaml: 'service:\n  name: bootcamp-app\n  serviceDefinition:\n    spec:\n      manifests:\n        - manifest:\n            spec:\n              store:\n                type: HarnessCode\n                spec:\n                  repoName: org.bootcamp-app\n                  branch: java-app\n',
    },
  },
  { service: { identifier: 'guestflow', name: 'guestflow-api', yaml: 'service:\n  name: guestflow-api\n' } },
]

export const environments = [
  { environment: { identifier: 'prod', name: 'prod', type: 'Production' } },
  { environment: { identifier: 'dev', name: 'dev', type: 'PreProduction' } },
  { environment: { identifier: 'qa', name: 'qa', type: 'PreProduction' } },
]

// What the REST endpoints wrap them in
export const envelope = (d: unknown) => JSON.stringify({ status: 'SUCCESS', data: d })
