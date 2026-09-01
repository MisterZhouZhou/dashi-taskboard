import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { test } from "node:test";

import {
  AutoClaimService,
  buildAutoClaimPrompt,
  eligibleIssue,
  issueRunBlocker,
} from "../server/auto-claim.mjs";

test("manual auto-claim rejects a missing workspace before entering running state", async (t) => {
  const project = {
    id: "missing-workspace",
    name: "Missing workspace",
    workspacePath: path.join(os.tmpdir(), "taskboard-workspace-that-does-not-exist"),
  };
  const issue = {
    id: "issue-1",
    identifier: "MISS-1",
    projectId: project.id,
    status: "todo",
    archivedAt: null,
    threadId: null,
    threadBinding: null,
    relations: { blockedBy: [] },
  };
  const settings = {
    projectId: project.id,
    enabled: false,
    agent: "codex",
    intervalMinutes: 5,
    sandbox: "workspace-write",
    networkAccess: true,
    model: null,
    reasoningEffort: null,
    lastIssue: null,
  };
  const database = {
    getProject: () => project,
    getTask: () => issue,
    listTasks: () => [issue],
    getProjectAutoClaim: () => settings,
  };
  const service = new AutoClaimService({ database, tickMs: 60_000 });
  t.after(() => service.close());

  assert.throws(
    () => service.runIssueNow(project.id, issue.id),
    (error) => error?.code === "WORKSPACE_MISSING"
      && error.message.includes(project.workspacePath),
  );
  assert.equal(service.get(project.id).running, false);
});

test("manual dispatch can reassign a todo issue while the scheduler leaves its old binding alone", () => {
  const issue = {
    id: "issue-2",
    identifier: "RETURNED-1",
    projectId: "project-1",
    status: "todo",
    archivedAt: null,
    threadId: "old-thread",
    threadBinding: {
      threadId: "old-thread",
      codexProjectId: "project-1",
      codexProjectKind: "local",
      codexHostId: "local",
      workspacePath: "/workspace",
    },
    relations: { blockedBy: [] },
  };

  const freshIssue = { ...issue, id: "issue-3", identifier: "FRESH-1", threadId: null, threadBinding: null };
  assert.equal(eligibleIssue([freshIssue]), freshIssue);
  assert.equal(issueRunBlocker(freshIssue, [freshIssue]), null);

  assert.equal(eligibleIssue([issue]), null);
  assert.equal(issueRunBlocker(issue, [issue]), null);
  assert.match(buildAutoClaimPrompt({
    issue,
    project: { id: "project-1", name: "Project" },
    workspacePath: "/workspace",
    taskctl: "taskctl",
    threadIdToken: "$CODEX_THREAD_ID",
    manualRedispatch: true,
  }), /用户已在详情页点击“立即执行”.*覆盖上一轮会话绑定/s);
});
