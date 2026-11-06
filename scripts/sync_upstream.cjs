const upstreamRepository = { owner: 'Xanerix', repo: 'guoapp', branch: 'main' };

function commitSHA(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error('GitHub 未返回有效的提交 SHA，已停止构建。');
  }
  return value;
}

module.exports = async function syncUpstream({ github, owner, repo }) {
  if (!owner || !repo) throw new Error('缺少目标仓库，已停止同步。');
  const response = await github.rest.repos.getBranch(upstreamRepository);
  const upstream = commitSHA(response.data.commit.sha);
  let merge;
  try {
    merge = await github.rest.repos.merge({
      owner, repo, base: 'main', head: upstream,
      commit_message: `Merge Xanerix/guoapp:main (${upstream}) before Android APK build`,
    });
  } catch (error) {
    if (error.status === 409) {
      throw new Error('上游 main 与当前仓库 main 存在合并冲突；请解决冲突后重新运行，未开始 APK 构建。');
    }
    if (error.status === 403) {
      throw new Error('无法写入当前仓库 main。请检查 contents: write、分支保护；若上游涉及工作流文件，可按 docs/android-apk.md 配置 UPSTREAM_SYNC_TOKEN。');
    }
    throw error;
  }

  let commit;
  if (merge.status === 201) {
    commit = commitSHA(merge.data.sha);
  } else if (merge.status === 204) {
    const branch = await github.rest.repos.getBranch({ owner, repo, branch: 'main' });
    commit = commitSHA(branch.data.commit.sha);
  } else {
    throw new Error('GitHub 返回了无法确认的合并响应，已停止构建。');
  }

  const comparison = await github.rest.repos.compareCommits({ owner, repo, base: upstream, head: commit });
  if (comparison.data.behind_by !== 0 || !['ahead', 'identical'].includes(comparison.data.status)) {
    throw new Error('目标构建提交未包含本次上游提交，已停止构建。');
  }
  return { upstream, commit, updated: merge.status === 201 };
};
