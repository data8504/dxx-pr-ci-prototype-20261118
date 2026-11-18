// This script runs from the trusted default-branch checkout, never from the PR.
module.exports = async ({ github, context, core }) => {
  const fail = message => { throw new Error(message); };
  const sha = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
  const id = value => Number.isSafeInteger(value) && value > 0;
  const { owner, repo } = context.repo;
  const manualId = context.payload.inputs?.request_run_id;
  const runId = context.eventName === 'workflow_run' ? context.payload.workflow_run?.id :
    typeof manualId === 'string' && /^[1-9][0-9]*$/.test(manualId) ? Number(manualId) : undefined;
  if (!['workflow_run', 'workflow_dispatch'].includes(context.eventName) || !id(runId) || !sha(context.sha))
    fail('Invalid workflow run event');
  const { data: repository } = await github.rest.repos.get({ owner, repo });
  const { data: run } = await github.rest.actions.getWorkflowRun({ owner, repo, run_id: runId });
  if (!id(repository.id) || typeof repository.default_branch !== 'string' || !repository.default_branch ||
      run.id !== runId || run.repository?.id !== repository.id ||
      run.event !== 'pull_request' || run.path !== '.github/workflows/ci.yml' ||
      run.status !== 'completed' || run.conclusion !== 'action_required' ||
      !sha(run.head_sha) || !id(run.head_repository?.id) ||
      typeof run.head_branch !== 'string' || !run.head_branch ||
      typeof run.head_repository.owner?.login !== 'string' || !run.head_repository.owner.login)
    fail('Run is not pending pull request CI for this repository');

  const bound = pr => pr.state === 'open' &&
    pr.head?.sha === run.head_sha && pr.head?.repo?.id === run.head_repository.id &&
    pr.head?.ref === run.head_branch && pr.base?.repo?.id === repository.id &&
    pr.base?.ref === repository.default_branch && pr.base?.sha === context.sha;
  const pulls = await github.paginate(github.rest.pulls.list, {
    owner, repo, state: 'open', base: repository.default_branch, per_page: 100,
    head: `${run.head_repository.owner.login}:${run.head_branch}`,
  });
  const matches = pulls.filter(bound);
  if (matches.length !== 1 || !id(matches[0].number))
    fail('No unique current pull request matches this run');
  const number = matches[0].number;
  const getPull = async () => (await github.rest.pulls.get({ owner, repo, pull_number: number })).data;
  const pr = await getPull();
  if (!bound(pr) || pr.number !== number || !sha(pr.merge_commit_sha))
    fail('Pull request changed or has no current merge commit');
  const mergeSha = pr.merge_commit_sha;
  const { data: merge } = await github.rest.git.getCommit({ owner, repo, commit_sha: mergeSha });
  if (merge.sha !== mergeSha || !Array.isArray(merge.parents) || merge.parents.length !== 2 ||
      merge.parents[0].sha !== context.sha || merge.parents[1].sha !== run.head_sha)
    fail('Merge commit does not match the current pull request and base');

  const workflowTree = async commit => {
    const { data: tree } = await github.rest.git.getTree({ owner, repo, tree_sha: commit, recursive: '1' });
    if (tree.truncated || !Array.isArray(tree.tree))
      fail('Cannot verify the complete workflow tree');
    const entries = tree.tree.filter(entry => ['.github/workflows', '.github/scripts']
      .some(path => entry.path === path || entry.path?.startsWith(`${path}/`)));
    if (!entries.some(entry => entry.path === '.github/workflows/ci.yml') ||
        entries.some(entry => typeof entry.path !== 'string' || !sha(entry.sha) ||
          typeof entry.mode !== 'string' || typeof entry.type !== 'string'))
      fail('Cannot verify the workflow definitions');
    return JSON.stringify(entries.map(({ path, mode, type, sha }) => [path, mode, type, sha])
      .sort((a, b) => a[0].localeCompare(b[0])));
  };
  const [trustedTree, sourceTree] = await Promise.all([
    workflowTree(context.sha), workflowTree(mergeSha),
  ]);
  const current = await getPull();
  if (!bound(current) || current.number !== number || current.merge_commit_sha !== mergeSha)
    fail('Pull request changed during validation');

  core.setOutput('head_sha', run.head_sha);
  core.setOutput('source_ref', mergeSha);
  core.setOutput('pr', String(number));
  core.setOutput('eligible', trustedTree === sourceTree ? 'true' : 'false');
  core.setOutput('reason', trustedTree === sourceTree ? 'Trusted CI definitions match' :
    'CI definitions changed; review required');
};
