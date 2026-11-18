const assert = require('node:assert/strict');
const { test } = require('node:test');
const select = require('./select-pr-ci.cjs');

const base = 'a'.repeat(40), head = 'b'.repeat(40), merge = 'c'.repeat(40);
const workflow = 'd'.repeat(40), changed = 'e'.repeat(40);
const clone = value => structuredClone(value);

function fixture() {
  const repository = { id: 1, default_branch: 'master' };
  const run = {
    id: 10, repository: { id: 1 }, event: 'pull_request',
    path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'action_required',
    head_sha: head, head_branch: 'topic', head_repository: { id: 2, owner: { login: 'contributor' } },
  };
  const pull = {
    number: 42, state: 'open', head: { sha: head, ref: 'topic', repo: { id: 2 } },
    base: { sha: base, ref: 'master', repo: { id: 1 } }, merge_commit_sha: merge,
  };
  const commit = { sha: merge, parents: [{ sha: base }, { sha: head }] };
  const tree = { truncated: false, tree: [
    { path: '.github/workflows', mode: '040000', type: 'tree', sha: workflow },
    { path: '.github/workflows/ci.yml', mode: '100644', type: 'blob', sha: workflow },
    { path: 'SConstruct', mode: '100644', type: 'blob', sha: workflow },
  ] };
  const state = { repository, run, pulls: [pull], reads: [clone(pull), clone(pull)], commit,
    trees: { [base]: clone(tree), [merge]: clone(tree) }, outputs: {}, calls: [] };
  const get = (name, value) => async args => {
    state.calls.push([name, args]);
    return { data: clone(typeof value === 'function' ? value(args) : value) };
  };
  const list = () => { throw new Error('Use paginated pull request listing'); };
  state.args = {
    context: { eventName: 'workflow_run', repo: { owner: 'project', repo: 'game' },
      sha: base, payload: { workflow_run: { id: 10 } } },
    core: { setOutput: (key, value) => { state.outputs[key] = value; } },
    github: {
      rest: {
        repos: { get: get('repository', repository) },
        actions: { getWorkflowRun: get('run', run) },
        pulls: { list, get: get('pull', () => state.reads.shift()) },
        git: { getCommit: get('commit', commit), getTree: get('tree', args => state.trees[args.tree_sha]) },
      },
      paginate: async (method, args) => {
        assert.equal(method, list);
        state.calls.push(['pulls', args]);
        return clone(state.pulls);
      },
    },
  };
  return state;
}

test('binds pending CI to pinned source without using the empty run pull_requests array', async () => {
  const state = fixture();
  state.run.pull_requests = [];
  await select(state.args);
  assert.deepEqual(state.outputs, { head_sha: head, source_ref: merge, pr: '42',
    eligible: 'true', reason: 'Trusted CI definitions match' });
  assert.deepEqual(state.calls.find(([name]) => name === 'pulls')[1], {
    owner: 'project', repo: 'game', state: 'open', base: 'master', per_page: 100,
    head: 'contributor:topic',
  });
  assert.equal(state.calls.filter(([name]) => name === 'pull').length, 2);
});

test('permits arbitrary game/build changes and unordered tree responses', async () => {
  const state = fixture();
  state.trees[merge].tree.find(entry => entry.path === 'SConstruct').sha = changed;
  state.trees[merge].tree.reverse();
  await select(state.args);
  assert.equal(state.outputs.eligible, 'true');
});

test('manual replay uses the same live binding and definition checks', async () => {
  const state = fixture();
  state.args.context.eventName = 'workflow_dispatch';
  state.args.context.payload = { inputs: { request_run_id: '10' } };
  await select(state.args);
  assert.equal(state.outputs.eligible, 'true');
  assert.equal(state.outputs.head_sha, head);
});

for (const input of ['10/approve', '1e1', '0', '-1', '9007199254740992', 10, undefined]) {
  test(`rejects invalid manual run id ${String(input)}`, async () => {
    const state = fixture();
    state.args.context.eventName = 'workflow_dispatch';
    state.args.context.payload = { inputs: { request_run_id: input } };
    await assert.rejects(select(state.args));
    assert.deepEqual(state.outputs, {});
  });
}

for (const [name, mutate] of [
  ['modified workflow', tree => { tree[1].sha = changed; }],
  ['added workflow', tree => tree.push({ path: '.github/workflows/extra.yml', mode: '100644', type: 'blob', sha: changed })],
  ['deleted workflow', tree => tree.push({ path: '.github/workflows/package.yml', mode: '100644', type: 'blob', sha: changed })],
  ['mode change', tree => { tree[1].mode = '120000'; }],
  ['type change', tree => { tree[1].type = 'tree'; }],
  ['controller script addition', tree => tree.push({ path: '.github/scripts/select-pr-ci.cjs', mode: '100644', type: 'blob', sha: changed })],
  ['controller script deletion', tree => tree.push({ path: '.github/scripts/select-pr-ci.cjs', mode: '100644', type: 'blob', sha: changed })],
]) {
  test(`holds ${name} while preserving the validated status target`, async () => {
    const state = fixture();
    mutate(['deleted workflow', 'controller script deletion'].includes(name) ?
      state.trees[base].tree : state.trees[merge].tree);
    await select(state.args);
    assert.equal(state.outputs.eligible, 'false');
    assert.equal(state.outputs.reason, 'CI definitions changed; review required');
    assert.equal(state.outputs.head_sha, head);
    assert.equal(state.outputs.source_ref, merge);
    assert.equal(state.outputs.pr, '42');
  });
}

const rejected = [
  ['wrong controller event', s => { s.args.context.eventName = 'pull_request'; }],
  ['invalid run id', s => { s.args.context.payload.workflow_run.id = '10'; }],
  ['invalid controller commit', s => { s.args.context.sha = 'master'; }],
  ['different live run', s => { s.run.id = 11; }],
  ['wrong event', s => { s.run.event = 'push'; }],
  ['wrong workflow path', s => { s.run.path = '.github/workflows/other.yml'; }],
  ['wrong repository', s => { s.run.repository.id = 7; }],
  ['missing repository default', s => { s.repository.default_branch = ''; }],
  ['already running', s => { s.run.status = 'in_progress'; s.run.conclusion = null; }],
  ['finished run', s => { s.run.conclusion = 'success'; }],
  ['invalid head', s => { s.run.head_sha = 'topic'; }],
  ['missing fork', s => { s.run.head_repository = null; }],
  ['stale head', s => { s.pulls[0].head.sha = changed; }],
  ['wrong fork', s => { s.pulls[0].head.repo.id = 7; }],
  ['wrong branch', s => { s.pulls[0].head.ref = 'other'; }],
  ['closed pull request', s => { s.pulls[0].state = 'closed'; }],
  ['ambiguous pull requests', s => { s.pulls.push(clone(s.pulls[0])); }],
  ['wrong base repository', s => { s.pulls[0].base.repo.id = 7; }],
  ['wrong base branch', s => { s.pulls[0].base.ref = 'release'; }],
  ['stale base', s => { s.pulls[0].base.sha = changed; }],
  ['changed initial lookup', s => { s.reads[0].head.sha = changed; }],
  ['missing merge', s => { s.reads[0].merge_commit_sha = null; }],
  ['invalid merge', s => { s.reads[0].merge_commit_sha = 'refs/pull/42/merge'; }],
  ['mismatched returned merge', s => { s.commit.sha = changed; }],
  ['wrong merge parents', s => { s.commit.parents[1].sha = changed; }],
  ['extra merge parent', s => { s.commit.parents.push({ sha: changed }); }],
  ['reversed merge parents', s => { s.commit.parents.reverse(); }],
  ['truncated base tree', s => { s.trees[base].truncated = true; }],
  ['truncated source tree', s => { s.trees[merge].truncated = true; }],
  ['missing tree', s => { s.trees[merge].tree = null; }],
  ['missing CI definition', s => { s.trees[merge].tree.splice(1, 1); }],
  ['invalid workflow entry', s => { s.trees[merge].tree[1].sha = 'main'; }],
  ['head changed during verification', s => { s.reads[1].head.sha = changed; }],
  ['base changed during verification', s => { s.reads[1].base.sha = changed; }],
  ['merge changed during verification', s => { s.reads[1].merge_commit_sha = changed; }],
  ['PR closed during verification', s => { s.reads[1].state = 'closed'; }],
];
for (const [name, mutate] of rejected) {
  test(`rejects ${name} without exposing a status or build target`, async () => {
    const state = fixture();
    mutate(state);
    await assert.rejects(select(state.args));
    assert.deepEqual(state.outputs, {});
  });
}
