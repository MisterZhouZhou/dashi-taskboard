import { accessSync, constants } from "node:fs";
import path from "node:path";

import { resolveCodexExecutable } from "../shared/codex-executable.mjs";

const CLAUDE_TOOLS_READ_ONLY = ["Read", "Glob", "Grep"];
const CLAUDE_TOOLS_WORKSPACE_WRITE = ["Bash", "Read", "Write", "Edit", "Glob", "Grep"];

function executableOnPath(name, env, platform) {
  const candidates = platform === "win32" ? [`${name}.exe`, `${name}.cmd`] : [name];
  for (const directory of (env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    for (const candidate of candidates) {
      const executable = path.join(directory, candidate);
      try {
        accessSync(executable, constants.X_OK);
        return executable;
      } catch {}
    }
  }
  return null;
}

export function resolveClaudeCodeExecutable({
  env = process.env,
  platform = process.platform,
} = {}) {
  const explicit = env.CLAUDE_CODE_EXECUTABLE?.trim();
  if (explicit) return explicit;
  return executableOnPath("claude", env, platform) ?? "claude";
}

export function resolveAgentExecutable(kind, options = {}) {
  if (kind === "claude-code") return resolveClaudeCodeExecutable(options);
  return resolveCodexExecutable(options);
}

/**
 * Arguments for one unattended background turn.
 *
 * Unattended means no human can answer an approval prompt, so both runtimes are
 * configured to decide on their own within the granted sandbox. `read-only` maps
 * to the runtime's planning/inspection mode; `workspace-write` grants edits
 * inside the workspace. `danger-full-access` is intentionally not accepted here.
 */
export function buildAgentTurnArgs(kind, {
  workspacePath,
  sandbox = "workspace-write",
  networkAccess = true,
  model,
  reasoningEffort,
  sessionId,
}) {
  if (sandbox !== "read-only" && sandbox !== "workspace-write") {
    throw new Error(`Unattended turns support read-only or workspace-write, received '${sandbox}'`);
  }
  return kind === "claude-code"
    ? claudeCodeArgs({ workspacePath, sandbox, model, sessionId })
    : codexArgs({ workspacePath, sandbox, networkAccess, model, reasoningEffort });
}

function codexArgs({ workspacePath, sandbox, networkAccess, model, reasoningEffort }) {
  const args = [
    "exec",
    "--json",
    "--color",
    "never",
    "-C",
    workspacePath,
    "-s",
    sandbox,
    "-c",
    'approval_policy="never"',
  ];
  if (sandbox === "workspace-write" && networkAccess) {
    // The turn reaches the taskboard over loopback to claim and report, and Codex
    // denies all network inside workspace-write until this is set. There is no
    // loopback-only setting (SandboxWorkspaceWrite has only writable_roots,
    // network_access, exclude_tmpdir_env_var and exclude_slash_tmp), so this is
    // general egress. Turning it off leaves Codex unable to claim; Claude Code
    // needs no equivalent grant.
    args.push("-c", "sandbox_workspace_write.network_access=true");
  }
  if (model) args.push("-m", model);
  if (reasoningEffort) args.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
  args.push("-");
  return args;
}

function claudeCodeArgs({ workspacePath, sandbox, model, sessionId }) {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--add-dir",
    workspacePath,
    "--permission-mode",
    sandbox === "read-only" ? "plan" : "acceptEdits",
    "--allowedTools",
    ...(sandbox === "read-only" ? CLAUDE_TOOLS_READ_ONLY : CLAUDE_TOOLS_WORKSPACE_WRITE),
  ];
  if (sessionId) args.push("--session-id", sessionId);
  if (model) args.push("--model", model);
  return args;
}

/**
 * Environment for one unattended turn.
 *
 * The spawning service already knows which runtime it launched, so it states it
 * outright instead of letting `taskctl` guess from the environment. Guessing is
 * wrong here: when the taskboard server itself runs inside an agent session, that
 * session's markers leak into every child and would misattribute the work.
 *
 * `TASKBOARD_AGENT` deliberately sits outside the `CODEX_TASKBOARD_` namespace,
 * which is stripped from agent turns on purpose.
 */
export function agentTurnEnv(kind, env = process.env) {
  const foreign = kind === "claude-code" ? "CODEX_THREAD_ID" : "CLAUDE_CODE_SESSION_ID";
  const next = { ...env, TASKBOARD_AGENT: kind };
  delete next[foreign];
  return next;
}

/**
 * How an agent refers to its own conversation id from inside its own shell.
 *
 * Codex assigns the id itself and exports it into the turn's environment, so the
 * prompt must defer to a shell variable. Claude Code accepts a caller-supplied
 * `--session-id`, so the literal value is already known before the spawn.
 */
export function agentThreadIdToken(kind, sessionId) {
  return kind === "claude-code" ? sessionId : "$CODEX_THREAD_ID";
}

/**
 * Both runtimes emit newline-delimited JSON, but they disagree on shape.
 * This reduces either stream to the two facts a background turn needs:
 * the agent's own session id, and whether the turn ended well.
 */
export function createAgentTurnReader(kind) {
  return kind === "claude-code" ? claudeCodeReader() : codexReader();
}

function codexReader() {
  const state = { sessionId: null, outcome: null, error: "", text: "" };
  return {
    state,
    consume(raw) {
      if (raw?.type === "thread.started" && typeof raw.thread_id === "string") {
        state.sessionId = raw.thread_id;
        return;
      }
      if (
        raw?.type === "item.completed"
        && raw.item?.type === "agent_message"
        && typeof raw.item.text === "string"
      ) {
        state.text = raw.item.text;
        return;
      }
      if (raw?.type === "turn.completed") {
        state.outcome ??= "completed";
        return;
      }
      if (raw?.type === "turn.failed") {
        state.outcome = "failed";
        state.error ||= String(raw.error?.message ?? "Codex turn failed");
        return;
      }
      if (raw?.type === "error") {
        state.error ||= String(raw.message ?? raw.error?.message ?? "Codex reported an error");
      }
    },
  };
}

function claudeCodeReader() {
  const state = { sessionId: null, outcome: null, error: "", text: "" };
  return {
    state,
    consume(raw) {
      if (typeof raw?.session_id === "string" && !state.sessionId) {
        state.sessionId = raw.session_id;
      }
      if (raw?.type === "assistant") {
        for (const block of raw.message?.content ?? []) {
          if (block?.type === "text" && typeof block.text === "string") state.text = block.text;
        }
        return;
      }
      if (raw?.type === "result") {
        if (raw.is_error === true || raw.subtype !== "success") {
          state.outcome = "failed";
          state.error ||= String(raw.result ?? raw.subtype ?? "Claude Code turn failed");
          return;
        }
        state.outcome ??= "completed";
        if (typeof raw.result === "string" && raw.result.trim()) state.text = raw.result;
      }
    },
  };
}
