import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { parse } from "yaml";
import { expect, test, vi } from "vitest";

// Execute the actual reusable workflow body, without a checkout of caller code.
const workflow = parse(
  readFileSync(
    new URL("../.github/workflows/merge-release.yml", import.meta.url),
    "utf8",
  ),
);
const script = workflow.jobs.merge.steps.find((step) => step.with?.script).with
  .script;
const repo = { owner: "example", repo: "project" };
const release = {
  number: 7,
  html_url: "https://github.com/example/project/pull/7",
  state: "open",
  draft: false,
  title: "chore(main): release project 1.2.3",
  user: { type: "Bot", login: "release-app[bot]" },
  base: { ref: "main" },
  head: {
    ref: "release-please--branches--main",
    sha: "exact-reviewed-sha",
    repo: { full_name: "example/project" },
  },
  mergeable: true,
  mergeable_state: "clean",
};

async function execute({
  prs = [release],
  current = release,
  refreshed = current,
  checks = [{ name: "CI", status: "completed", conclusion: "success" }],
  statuses = [],
  totalCount = statuses.length,
  dryRun = "false",
  refusal,
} = {}) {
  const merge = vi.fn(
    async () =>
      new Response(
        JSON.stringify(
          refusal
            ? { message: refusal.message }
            : { merged: true, message: "Pull Request successfully merged" },
        ),
        { status: refusal?.status ?? 200 },
      ),
  );
  const summary = [];
  const failed = vi.fn();
  const github = {
    rest: {
      pulls: {
        list: "pulls",
        get: vi
          .fn()
          .mockResolvedValueOnce({ data: current })
          .mockResolvedValue({ data: refreshed }),
      },
      checks: { listForRef: "checks" },
      repos: {
        getCombinedStatusForRef: vi.fn(async () => ({
          data: { statuses, total_count: totalCount },
        })),
      },
    },
    paginate: vi.fn(async (endpoint) => {
      if (endpoint !== "pulls" && endpoint !== "checks")
        throw new Error("Unsupported pagination endpoint");
      return { pulls: prs, checks }[endpoint];
    }),
  };
  const core = {
    info() {},
    setFailed: failed,
    summary: {
      addHeading() {
        return this;
      },
      addRaw(message) {
        summary.push(message);
        return this;
      },
      async write() {},
    },
  };
  await runInNewContext(`(async () => { ${script}\n })()`, {
    github,
    core,
    context: { repo },
    fetch: merge,
    process: {
      env: {
        GITHUB_API_URL: "https://api.github.com",
        RELEASE_AUTHOR: "release-app[bot]",
        RELEASE_TOKEN: "app-token",
        DRY_RUN: dryRun,
      },
    },
  });
  return { merge, summary: summary.join("\n"), failed, github };
}

test("squashes only the exact reviewed release head using the release App", async () => {
  const result = await execute();
  expect(result.merge).toHaveBeenCalledExactlyOnceWith(
    "https://api.github.com/repos/example/project/pulls/7/merge",
    {
      method: "PUT",
      headers: {
        authorization: "Bearer app-token",
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({ sha: release.head.sha, merge_method: "squash" }),
    },
  );
  expect(
    result.github.rest.repos.getCombinedStatusForRef,
  ).toHaveBeenCalledExactlyOnceWith({
    ...repo,
    ref: release.head.sha,
    per_page: 100,
  });
  expect(result.github.paginate).toHaveBeenCalledWith(
    "checks",
    expect.objectContaining({ ref: release.head.sha }),
  );
});

test.each([
  { prs: [] },
  { prs: [release, release] },
  { prs: [{ ...release, title: "chore: something else" }] },
  { prs: [{ ...release, user: { type: "Bot", login: "other[bot]" } }] },
  { prs: [{ ...release, head: { ...release.head, ref: "feature" } }] },
  {
    prs: [
      {
        ...release,
        head: { ...release.head, repo: { full_name: "fork/project" } },
      },
    ],
  },
  { prs: [{ ...release, draft: true }] },
  { current: { ...release, state: "closed" } },
  { refreshed: { ...release, head: { ...release.head, sha: "new-head" } } },
  { refreshed: { ...release, title: "not a release" } },
  { checks: [] },
  { totalCount: 101, statuses: [] },
  { checks: [{ name: "CI", status: "in_progress", conclusion: null }] },
  { checks: [{ name: "CI", status: "completed", conclusion: "failure" }] },
  { statuses: [{ context: "external", state: "pending" }] },
  { statuses: [{ context: "external", state: "failure" }] },
  { current: { ...release, mergeable_state: "blocked" } },
  { current: { ...release, mergeable: null } },
  { dryRun: "true" },
])("does nothing and explains an ineligible case: %j", async (options) => {
  const result = await execute(options);
  expect(result.merge).not.toHaveBeenCalled();
  expect(result.summary).toMatch(/No merge|Dry run/);
});

test("GitHub's successful skipped attestation is allowed", async () => {
  const result = await execute({
    checks: [
      { name: "attestation", status: "completed", conclusion: "skipped" },
    ],
  });
  expect(result.merge).toHaveBeenCalledOnce();
});

test("reports the exact App ruleset refusal without retrying or bypassing", async () => {
  const result = await execute({
    refusal: Object.assign(
      new Error("Repository rule violations found: required approval"),
      { status: 405 },
    ),
  });
  expect(result.merge).toHaveBeenCalledOnce();
  expect(result.summary).toContain(
    "GitHub HTTP 405; merged=undefined; Repository rule violations found: required approval",
  );
  expect(result.failed).toHaveBeenCalledOnce();
});
