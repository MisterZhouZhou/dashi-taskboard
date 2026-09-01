import { useEffect, useMemo, useState } from "react";
import {
  getExecutionRun,
  listExecutionRuns,
  subscribeExecutionEvents,
} from "../api";
import { useTaskboardI18n } from "../i18n";
import type { ExecutionEvent, ExecutionRun } from "../types";

export interface ExecutionEventStreamProps {
  taskId?: string;
  runId?: string | null;
  compact?: boolean;
  hideWhenEmpty?: boolean;
}

function eventLabel(event: ExecutionEvent, text: (zh: string, en: string) => string): string {
  switch (event.type) {
    case "command_started": return text("开始执行命令", "Command started");
    case "command_output": return text("命令输出", "Command output");
    case "command_completed": return text("命令完成", "Command completed");
    case "file_change": return text("文件变更", "File changes");
    case "tool_call": return text("工具调用", "Tool call");
    case "error": return text("错误", "Error");
    case "run_completed": return text("执行完成", "Execution completed");
    case "run_failed": return text("执行失败", "Execution failed");
    case "run_interrupted": return text("执行中断", "Execution interrupted");
    default: return text("Agent", "Agent");
  }
}

function mergeExecutionEvents(events: ExecutionEvent[]): ExecutionEvent[] {
  const merged = new Map<string, ExecutionEvent>();
  for (const event of events) {
    const itemId = typeof event.data?.itemId === "string" ? event.data.itemId : null;
    const key = event.type === "tool_call" && itemId ? `tool:${itemId}` : `event:${event.id}`;
    merged.set(key, event);
  }
  return [...merged.values()].sort((left, right) => left.sequence - right.sequence);
}

function formatTime(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { timeStyle: "medium" }).format(new Date(value));
}

function runStatusLabel(run: ExecutionRun, text: (zh: string, en: string) => string): string {
  switch (run.status) {
    case "running": return text("执行中", "Running");
    case "completed": return text("已完成", "Completed");
    case "failed": return text("失败", "Failed");
    case "interrupted": return text("已中断", "Interrupted");
    default: return text("排队中", "Queued");
  }
}

export function ExecutionEventStream({ taskId, runId = null, compact = false, hideWhenEmpty = false }: ExecutionEventStreamProps) {
  const { locale, text } = useTaskboardI18n();
  const [runs, setRuns] = useState<ExecutionRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(runId);
  const [events, setEvents] = useState<ExecutionEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const activeRun = useMemo(
    () => runs.find((run) => run.id === selectedRunId) ?? null,
    [runs, selectedRunId],
  );

  useEffect(() => {
    setSelectedRunId(runId);
  }, [runId]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const load = async () => {
      try {
        if (runId) {
          const snapshot = await getExecutionRun(runId, controller.signal);
          if (controller.signal.aborted) return;
          setRuns([snapshot.run]);
          setEvents(mergeExecutionEvents(snapshot.events));
          return;
        }
        const nextRuns = await listExecutionRuns({ taskId, limit: 20 }, controller.signal);
        if (controller.signal.aborted) return;
        setRuns(nextRuns);
        const nextRun = nextRuns.find((run) => run.status === "running") ?? nextRuns[0] ?? null;
        setSelectedRunId(nextRun?.id ?? null);
        if (nextRun) setEvents(mergeExecutionEvents((await getExecutionRun(nextRun.id, controller.signal)).events));
        else setEvents([]);
      } catch {
        if (!controller.signal.aborted) {
          setRuns([]);
          setEvents([]);
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [runId, taskId]);

  useEffect(() => subscribeExecutionEvents((payload) => {
    if (payload.run?.taskId && taskId && payload.run.taskId !== taskId) return;
    if (runId && payload.runId && payload.runId !== runId) return;
    if (payload.run) {
      setRuns((current) => [payload.run!, ...current.filter((run) => run.id !== payload.run!.id)]);
    }
    if (payload.event && (!selectedRunId || payload.event.runId === selectedRunId)) {
      setEvents((current) => mergeExecutionEvents([...current, payload.event!]));
    }
  }), [runId, selectedRunId, taskId]);

  useEffect(() => {
    if (!selectedRunId || runId) return;
    const controller = new AbortController();
    void getExecutionRun(selectedRunId, controller.signal)
      .then((snapshot) => {
        if (!controller.signal.aborted) {
          setEvents(mergeExecutionEvents(snapshot.events));
          setRuns((current) => [snapshot.run, ...current.filter((run) => run.id !== snapshot.run.id)]);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [runId, selectedRunId]);

  if (loading) return <div className="execution-empty">{text("读取执行记录…", "Loading execution records…")}</div>;
  if (runs.length === 0) return hideWhenEmpty ? null : <div className="execution-empty">{text("暂无执行记录", "No execution records")}</div>;

  return (
    <section className={`execution-stream${compact ? " is-compact" : ""}`} aria-label={text("Agent 执行过程", "Agent execution") }>
      {!runId && runs.length > 1 && (
        <div className="execution-run-tabs">
          {runs.map((run) => (
            <button
              key={run.id}
              type="button"
              className={run.id === selectedRunId ? "is-active" : ""}
              onClick={() => setSelectedRunId(run.id)}
            >
              <span>{run.taskIdentifier}</span>
              <small>{runStatusLabel(run, text)}</small>
            </button>
          ))}
        </div>
      )}
      {activeRun && (
        <header className="execution-stream-header">
          <div>
            <strong>{activeRun.agent === "claude-code" ? "Claude Code" : "Codex CLI"}</strong>
            <span>{text(activeRun.source === "manual" ? "手动执行" : "自动认领", activeRun.source === "manual" ? "Manual" : "Auto-claim")}</span>
          </div>
          <span className={`execution-status is-${activeRun.status}`}>{runStatusLabel(activeRun, text)}</span>
        </header>
      )}
      <div className="execution-event-list">
        {events.map((event) => (
          <article className={`execution-event is-${event.role}`} key={event.id}>
            <div className="execution-event-meta">
              <span>{eventLabel(event, text)}</span>
              <time dateTime={event.createdAt}>{formatTime(event.createdAt, locale)}</time>
            </div>
            {event.command && <pre className="execution-command">$ {event.command}</pre>}
            {event.content && <div className="execution-event-content">{event.content}</div>}
            {event.output && <details className="execution-output"><summary>{text("查看输出", "View output")}</summary><pre>{event.output}</pre></details>}
            {event.files && event.files.length > 0 && <ul className="execution-files">{event.files.map((file) => <li key={file}>{file}</li>)}</ul>}
          </article>
        ))}
      </div>
    </section>
  );
}
