export const EXECUTION_RUN_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "interrupted",
];

export const EXECUTION_SOURCES = ["manual", "auto-claim"];

export const EXECUTION_EVENT_TYPES = [
  "agent_message",
  "command_started",
  "command_output",
  "command_completed",
  "file_change",
  "tool_call",
  "error",
  "run_completed",
  "run_failed",
  "run_interrupted",
];

export const EXECUTION_EVENT_ROLES = ["agent", "command", "tool", "system", "error"];

export function isExecutionRunStatus(value) {
  return EXECUTION_RUN_STATUSES.includes(value);
}

export function isExecutionSource(value) {
  return EXECUTION_SOURCES.includes(value);
}

export function isExecutionEventType(value) {
  return EXECUTION_EVENT_TYPES.includes(value);
}

export function isExecutionEventRole(value) {
  return EXECUTION_EVENT_ROLES.includes(value);
}
