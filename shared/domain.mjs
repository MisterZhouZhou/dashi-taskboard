export const TASK_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "canceled",
];
export const TASK_PRIORITIES = ["none", "urgent", "high", "medium", "low"];

export const DEFAULT_PROJECT_ID = "local";
export const JIRA_PROJECT_ID = "jira-my-tasks";
export const DEFAULT_LABEL_NAMES = [
  "缺陷",
  "特性",
  "hold",
  "改进",
  "phase-1",
  "phase-2",
  "phase-3",
  "phase-4",
  "phase-5",
  "phase-6",
];

export function isTaskStatus(value) {
  return TASK_STATUSES.includes(value);
}

export function isTaskPriority(value) {
  return TASK_PRIORITIES.includes(value);
}

export const CODEX_AGENT_ACTOR = {
  type: "agent",
  id: "codex-agent",
  name: "Codex Agent",
  avatarUrl: null,
};
export const CLAUDE_CODE_AGENT_ACTOR = {
  type: "agent",
  id: "claude-code-agent",
  name: "Claude Code",
  avatarUrl: null,
};

const AGENT_ACTORS = new Map([
  ["codex", CODEX_AGENT_ACTOR],
  ["claude-code", CLAUDE_CODE_AGENT_ACTOR],
]);

export const AGENT_KINDS = new Set(AGENT_ACTORS.keys());

export function agentActorForKind(kind) {
  return AGENT_ACTORS.get(kind) ?? CODEX_AGENT_ACTOR;
}

export function isAgentKind(value) {
  return AGENT_KINDS.has(value);
}

