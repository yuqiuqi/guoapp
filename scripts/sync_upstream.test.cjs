const assert = require('node:assert/strict');
const { test } = require('node:test');
const syncUpstream = require('./sync_upstream.cjs');

const upstream = 'a'.repeat(40);
const merged = 'b'.repeat(40);
const current = 'c'.repeat(40);

function fixture(overrides = {}) {
  const calls = [];
  const defaults = {
    getBranch: async ({ owner }) => ({ data: { commit: { sha: owner === 'Xanerix' ? upstream : current } } }),
    merge: async () => ({ status: 201, data: { sha: merged } }),
    compareCommits: async () => ({ data: { status: 'ahead', behind_by: 0 } }),
  };
  const repos = {};
  for (const name of Object.keys(defaults)) {
    repos[name] = async (input) => {
      calls.push({ method: name, ...input });
      return (overrides[name] || defaults[name])(input);
    };
  }
  return { github: { rest: { repos } }, calls };
}

test('merges the captured upstream SHA into the fork and returns the exact merge commit', async () => {
  const { github, calls } = fixture();
  const result = await syncUpstream({ github, owner: 'yuqiuqi', repo: 'guoapp' });
  assert.deepEqual(result, { upstream, commit: merged, updated: true });
  assert.deepEqual(calls.find((call) => call.method === 'merge'), {
    method: 'merge', owner: 'yuqiuqi', repo: 'guoapp', base: 'main', head: upstream,
    commit_message: `Merge Xanerix/guoapp:main (${upstream}) before Android APK build`,
  });
  assert.deepEqual(calls.find((call) => call.method === 'compareCommits'), {
    method: 'compareCommits', owner: 'yuqiuqi', repo: 'guoapp', base: upstream, head: merged,
  });
});

test('when already current, builds the fork main commit rather than replacing it with upstream', async () => {
  const { github, calls } = fixture({ merge: async () => ({ status: 204 }) });
  assert.deepEqual(await syncUpstream({ github, owner: 'yuqiuqi', repo: 'guoapp' }), {
    upstream, commit: current, updated: false,
  });
  assert.equal(calls.filter((call) => call.method === 'getBranch').length, 2);
  assert.equal(calls.at(-1).head, current);
});

test('a merge conflict stops the operation and cannot return a build commit', async () => {
  const { github, calls } = fixture({ merge: async () => { throw Object.assign(new Error('conflict'), { status: 409 }); } });
  await assert.rejects(syncUpstream({ github, owner: 'yuqiuqi', repo: 'guoapp' }), /合并冲突/);
  assert.equal(calls.some((call) => call.method === 'compareCommits'), false);
});

test('insufficient write permissions explain the optional sync token and stop', async () => {
  const { github } = fixture({ merge: async () => { throw Object.assign(new Error('forbidden'), { status: 403 }); } });
  await assert.rejects(syncUpstream({ github, owner: 'yuqiuqi', repo: 'guoapp' }), /UPSTREAM_SYNC_TOKEN/);
});

test('an unavailable upstream is never followed by a write', async () => {
  const { github, calls } = fixture({ getBranch: async () => { throw new Error('upstream unavailable'); } });
  await assert.rejects(syncUpstream({ github, owner: 'yuqiuqi', repo: 'guoapp' }), /upstream unavailable/);
  assert.equal(calls.length, 1);
});

test('an invalid merge commit cannot be used as a checkout ref', async () => {
  const { github, calls } = fixture({ merge: async () => ({ status: 201, data: { sha: 'main' } }) });
  await assert.rejects(syncUpstream({ github, owner: 'yuqiuqi', repo: 'guoapp' }), /提交 SHA/);
  assert.equal(calls.some((call) => call.method === 'compareCommits'), false);
});

test('a commit that does not contain upstream is rejected before publishing build outputs', async () => {
  const { github } = fixture({ compareCommits: async () => ({ data: { status: 'diverged', behind_by: 1 } }) });
  await assert.rejects(syncUpstream({ github, owner: 'yuqiuqi', repo: 'guoapp' }), /未包含/);
});

test('an unexpected merge response fails instead of guessing which branch to build', async () => {
  const { github } = fixture({ merge: async () => ({ status: 200, data: {} }) });
  await assert.rejects(syncUpstream({ github, owner: 'yuqiuqi', repo: 'guoapp' }), /合并响应/);
});

test('missing target repository is rejected before making any request', async () => {
  const { github, calls } = fixture();
  await assert.rejects(syncUpstream({ github, owner: '', repo: 'guoapp' }), /目标仓库/);
  assert.equal(calls.length, 0);
});
