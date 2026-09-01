import { normalizeCodexEvent } from "./ai-chat-process.mjs";
import {
  EXECUTION_EVENT_TYPES,
  EXECUTION_EVENT_ROLES,
} from "../shared/execution.mjs";

const MAX_EVENT_TEXT = 65_536;
const MAX_COMMAND_OUTPUT = 131_072;

function capped(value, limit = MAX_EVENT_TEXT) {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function detail(value) {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value).slice(0, MAX_EVENT_TEXT);
  } catch {
    return null;
  }
}

function normalized(type, role, content, fields = {}) {
  if (!EXECUTION_EVENT_TYPES.includes(type) || !EXECUTION_EVENT_ROLES.includes(role)) return null;
  return {
    type,
    role,
    content: capped(content),
    ...(fields.command ? { command: capped(fields.command) } : {}),
    ...(fields.output ? { output: capped(fields.output, MAX_COMMAND_OUTPUT) } : {}),
    ...(fields.files ? { files: fields.files.slice(0, 100).map((file) => capped(file, 1_024)) } : {}),
    ...(fields.data ? { data: fields.data } : {}),
    ...(fields.summary ? { summary: capped(fields.summary, 240) } : {}),
  };
}

function normalizeCodex(raw) {
  const event = normalizeCodexEvent(raw);
  if (!event) return null;
  if (event.kind === "thread.started") return { threadId: event.threadId };
  if (event.type === "turn.completed") return normalized("run_completed", "system", "执行器已完成本轮运行", { data: event.data });
  if (event.type === "turn.failed") return normalized("run_failed", "error", event.content, { data: event.data });
  if (event.type === "error") return normalized("error", "error", event.content, { data: event.data });

  const data = event.data ?? {};
  if (event.type === "agent_message") {
    return normalized("agent_message", "agent", event.content, { data });
  }
  if (event.type === "command_execution") {
    const sourceType = data.status === "started"
      ? "command_started"
      : data.status === "completed"
        ? "command_completed"
        : "command_output";
    return normalized(sourceType, "command", event.content || data.command || "", {
      command: data.command,
      output: data.output,
      data,
      summary: data.command || event.content,
    });
  }
  if (event.type === "file_change") {
    return normalized("file_change", "system", event.content, {
      files: Array.isArray(data.files) ? data.files : [],
      data,
      summary: event.content,
    });
  }
  if (event.type === "mcp_tool_call" || event.type === "web_search" || event.type === "todo_list") {
    return normalized("tool_call", "tool", event.content, { data, summary: event.content });
  }
  return normalized("agent_message", event.role === "error" ? "error" : "system", event.content, { data });
}

function normalizeClaude(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (typeof raw.session_id === "string" && raw.type !== "result") {
    const threadId = raw.session_id;
    if (raw.type === "system" && raw.subtype === "init") return { threadId };
  }
  if (raw.type === "assistant") {
    const blocks = Array.isArray(raw.message?.content) ? raw.message.content : [];
    const events = blocks.flatMap((block) => {
      if (block?.type === "text" && typeof block.text === "string") {
        return [normalized("agent_message", "agent", block.text)];
      }
      if (block?.type === "tool_use") {
        const name = capped(block.name);
        return [normalized("tool_call", "tool", name, {
          data: { name, input: block.input ?? null },
          summary: name,
        })];
      }
      return [];
    }).filter(Boolean);
    return events.length === 1 ? events[0] : events.length > 1 ? { events } : null;
  }
  if (raw.type === "user" && raw.message?.content) {
    const content = Array.isArray(raw.message.content)
      ? raw.message.content.map((block) => block?.content ?? block?.text ?? "").filter(Boolean).join("\n")
      : String(raw.message.content);
    return content ? normalized("command_output", "command", content, { output: content }) : null;
  }
  if (raw.type === "result") {
    if (raw.is_error === true || raw.subtype !== "success") {
      return normalized("run_failed", "error", raw.result || raw.subtype || "Claude Code 执行失败", {
        data: { subtype: raw.subtype ?? null },
      });
    }
    return normalized("run_completed", "system", raw.result || "执行器已完成本轮运行", {
      data: { subtype: raw.subtype ?? "success" },
    });
  }
  if (raw.type === "error") return normalized("error", "error", raw.message || raw.error?.message || "执行器报告错误");
  return null;
}

export function normalizeAgentEvent(kind, raw) {
  const result = kind === "claude-code" ? normalizeClaude(raw) : normalizeCodex(raw);
  return result?.events ?? (result ? [result] : []);
}

export class ExecutionService {
  constructor({ database, events }) {
    this.database = database;
    this.events = events;
  }

  createRun(input) {
    const run = this.database.createExecutionRun({ ...input, status: "running" });
    this.database.appendExecutionEvent(run.id, {
      type: "agent_message",
      role: "system",
      content: `${input.agent === "claude-code" ? "Claude Code" : "Codex CLI"} 已启动（${input.source === "manual" ? "手动执行" : "自动认领"}）`,
    });
    const current = this.database.getExecutionRun(run.id);
    this.events?.emit("execution.created", { run: current });
    return current;
  }

  consume(runId, kind, raw) {
    const results = normalizeAgentEvent(kind, raw);
    let latest = null;
    for (const event of results) {
      if (event.threadId) {
        latest = this.database.updateExecutionRunThread(runId, event.threadId);
        this.events?.emit("execution.updated", { run: latest });
        continue;
      }
      const appended = this.database.appendExecutionEvent(runId, event);
      latest = appended.event;
      this.events?.emit("execution.event", { runId, run: appended.run, event: appended.event });
      this.events?.emit("execution.updated", { run: this.database.getExecutionRun(runId) });
    }
    return latest;
  }

  finish(runId, status, error = null) {
    const run = this.database.finishExecutionRun(runId, status, error);
    const type = status === "completed" ? "run_completed" : status === "interrupted" ? "run_interrupted" : "run_failed";
    const existingEvents = this.database.listExecutionEvents(runId);
    const appended = existingEvents.at(-1)?.type === type
      ? { run: this.database.getExecutionRun(runId), event: existingEvents.at(-1) }
      : this.database.appendExecutionEvent(runId, {
        type,
        role: status === "failed" ? "error" : "system",
        content: error || (status === "completed" ? "执行完成" : status === "interrupted" ? "执行已中断" : "执行失败"),
      });
    const finalRun = this.database.finishExecutionRun(runId, status, error);
    if (appended.event && existingEvents.at(-1)?.id !== appended.event.id) {
      this.events?.emit("execution.event", { runId, run: appended.run, event: appended.event });
    }
    this.events?.emit("execution.finished", { run: finalRun });
    return finalRun;
  }

  listRuns(filters) {
    return this.database.listExecutionRuns(filters);
  }

  getRun(runId) {
    const run = this.database.getExecutionRun(runId);
    if (!run) return null;
    return { run, events: this.database.listExecutionEvents(runId) };
  }

  listEvents(runId, afterSequence = 0) {
    return this.database.listExecutionEvents(runId, afterSequence);
  }
}
