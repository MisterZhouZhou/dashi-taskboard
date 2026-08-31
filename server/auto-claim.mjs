import { randomUUID } from "node:crypto";

import { signalProcessTree } from "../shared/process-tree.mjs";
import { buildTaskctlCommand } from "../shared/taskboard-automation.mjs";
import {
  agentThreadIdToken,
  agentTurnEnv,
  buildAgentTurnArgs,
  createAgentTurnReader,
  resolveAgentExecutable,
} from "./agent-runtime.mjs";
import { spawnCodexTurn } from "./ai-chat-process.mjs";

const TICK_MS = 60 * 1_000;
const MINUTE_MS = 60 * 1_000;

/**
 * An issue is eligible when nobody owns it yet and nothing it depends on is
 * still open. Anything already carrying a thread id belongs to a conversation
 * that must be allowed to finish or be re-dispatched by a human.
 */
export function eligibleIssue(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return tasks.find((task) => {
    if (task.status !== "todo" || task.archivedAt != null) return false;
    if (task.threadId || task.threadBinding) return false;
    return (task.relations?.blockedBy ?? []).every((dependency) => {
      const blocker = byId.get(dependency.id);
      return blocker ? blocker.status === "done" : true;
    });
  }) ?? null;
}

export function buildAutoClaimPrompt({
  issue,
  project,
  workspacePath,
  taskctl,
  threadIdToken,
}) {
  return [
    `你是任务面板的自动认领 worker，本轮只处理议题 ${issue.identifier}，处理完即停止。`,
    "",
    `项目：${project.name}（id: ${project.id}）`,
    `工作目录：${workspacePath}`,
    `taskctl 命令前缀：${taskctl}`,
    `你的会话 id：${threadIdToken}`,
    "",
    "严格按顺序执行，每一步用给出的精确命令形式，不要自行探索参数：",
    "",
    `1. 读取议题与全部评论：`,
    `   ${taskctl} issue get ${issue.identifier} --json`,
    `   ${taskctl} comment list ${issue.identifier} --json`,
    "   把返回的 version 记为 V。若描述或最新评论要求等待、暂不执行或已由他人处理，立即停止并不要改状态。",
    "",
    "2. 认领。用刚读到的 V 作为 --if-version，一次写入完整绑定：",
    `   ${taskctl} issue move ${issue.identifier} --status in_progress --if-version V \\`,
    `     --thread-id "${threadIdToken}" \\`,
    `     --binding-thread-id "${threadIdToken}" \\`,
    `     --binding-codex-project-id ${JSON.stringify(project.id)} \\`,
    `     --binding-codex-project-kind local \\`,
    `     --binding-codex-host-id local \\`,
    `     --binding-workspace-path ${JSON.stringify(workspacePath)}`,
    "   写入成功后把返回的 version 记为 V。失败或返回 409 就立即停止，不要重试、不要抢占。",
    "",
    "3. 在工作目录内完成议题要求的改动，并验证它确实生效。",
    "",
    "4. 记录结果：",
    `   ${taskctl} comment add ${issue.identifier} --body "<改动、验证方式、结果、遗留风险>" --thread-id "${threadIdToken}"`,
    "",
    "5. 交回评审。用最新的 V 和同样的五个 binding 参数：",
    `   ${taskctl} issue move ${issue.identifier} --status in_review --if-version V \\`,
    `     --thread-id "${threadIdToken}" \\`,
    `     --binding-thread-id "${threadIdToken}" \\`,
    `     --binding-codex-project-id ${JSON.stringify(project.id)} \\`,
    `     --binding-codex-project-kind local \\`,
    `     --binding-codex-host-id local \\`,
    `     --binding-workspace-path ${JSON.stringify(workspacePath)}`,
    "",
    "绝对不要把议题标成 done —— 只有用户能验收。不要处理其他议题。",
  ].join("\n");
}

export class AutoClaimService {
  constructor(options) {
    this.database = options.database;
    this.processEnv = options.processEnv ?? process.env;
    this.workspacePathFor = options.workspacePathFor
      ?? ((project) => project.workspacePath ?? null);
    this.active = new Map();
    this.closed = false;
    this.ticking = false;
    this.timer = setInterval(() => void this.tick(), options.tickMs ?? TICK_MS);
    this.timer.unref();
  }

  get(projectId) {
    const settings = this.database.getProjectAutoClaim(projectId);
    return { ...settings, running: this.active.has(projectId) };
  }

  save(projectId, settings) {
    const saved = this.database.saveProjectAutoClaim(projectId, settings);
    return { ...saved, running: this.active.has(projectId) };
  }

  async tick() {
    if (this.closed || this.ticking) return;
    this.ticking = true;
    try {
      for (const settings of this.database.listProjectAutoClaims()) {
        if (this.closed) return;
        if (!settings.enabled) continue;
        if (this.active.has(settings.projectId)) continue;
        if (!this.#intervalElapsed(settings)) continue;
        // Deliberately serial across projects, not just within one: an
        // unattended turn is real model spend, so enabling auto-claim on N
        // projects must not put N agents to work at once. The `ticking` guard
        // keeps the next interval from starting a second turn behind this await.
        await this.runOnce(settings.projectId);
      }
    } finally {
      this.ticking = false;
    }
  }

  #intervalElapsed(settings) {
    if (!settings.lastStartedAt) return true;
    const elapsed = Date.now() - new Date(settings.lastStartedAt).getTime();
    return elapsed >= settings.intervalMinutes * MINUTE_MS;
  }

  /** One project runs at most one unattended turn at a time. */
  runOnce(projectId) {
    const current = this.active.get(projectId);
    if (current) return current.promise;
    const active = { child: null, promise: null };
    active.promise = this.#dispatch(projectId, active)
      .finally(() => this.active.delete(projectId));
    this.active.set(projectId, active);
    return active.promise;
  }

  async #dispatch(projectId, active) {
    let started = false;
    try {
      const project = this.database.getProject(projectId);
      if (!project) return { skipped: "project-missing" };
      const workspacePath = this.workspacePathFor(project);
      if (!workspacePath) {
        this.database.recordProjectAutoClaimFinish(projectId, "failed", "项目没有可用的工作目录");
        return { skipped: "workspace-missing" };
      }
      const settings = this.database.getProjectAutoClaim(projectId);
      const issue = eligibleIssue(this.database.listTasks({ projectId, archived: "false" }));
      if (!issue) return { skipped: "no-eligible-issue" };

      // The project setting is the default; the issue's own executor wins when set.
      const agent = issue.executor ?? settings.agent;
      const sessionId = randomUUID();
      const executable = resolveAgentExecutable(agent, { env: this.processEnv });
      const args = buildAgentTurnArgs(agent, {
        workspacePath,
        sandbox: settings.sandbox,
        networkAccess: settings.networkAccess,
        model: settings.model ?? undefined,
        reasoningEffort: settings.reasoningEffort ?? undefined,
        sessionId,
      });
      const prompt = buildAutoClaimPrompt({
        issue,
        project,
        workspacePath,
        taskctl: buildTaskctlCommand({}),
        threadIdToken: agentThreadIdToken(agent, sessionId),
      });

      this.database.recordProjectAutoClaimStart(projectId, issue.identifier, agent);
      started = true;
      const reader = createAgentTurnReader(agent);
      const { child, completion } = spawnCodexTurn({
        executable,
        args,
        prompt,
        cwd: workspacePath,
        env: agentTurnEnv(agent, this.processEnv),
        onRawEvent: (raw) => reader.consume(raw),
      });
      active.child = child;
      const result = await completion;
      if (this.closed) return { interrupted: true };

      // The agent's own exit code is not evidence: a turn can end "successfully"
      // having achieved nothing. The board is the source of truth, so check
      // whether the issue actually changed hands.
      const settled = this.database.getTask(issue.id);
      const claimed = Boolean(settled?.threadBinding) || settled?.status !== "todo";
      const failure = !claimed
        ? reader.state.error
          || `${agent} 结束但议题仍是 todo（退出码 ${result.exitCode}）`
        : result.exitCode !== 0 || reader.state.outcome === "failed"
          ? reader.state.error || `${agent} 退出码 ${result.exitCode}`
          : null;
      this.database.recordProjectAutoClaimFinish(
        projectId,
        failure ? "failed" : "completed",
        failure,
      );
      return {
        issue: issue.identifier,
        agent,
        sessionId: reader.state.sessionId,
        status: settled?.status ?? null,
        claimed,
        ...(failure ? { failure } : {}),
      };
    } catch (error) {
      if (started && !this.closed) {
        this.database.recordProjectAutoClaimFinish(
          projectId,
          "failed",
          error instanceof Error ? error.message : String(error),
        );
      }
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    const active = [...this.active.values()];
    for (const entry of active) signalProcessTree(entry.child, "SIGTERM");
    await Promise.allSettled(active.map((entry) => entry.promise));
  }
}
