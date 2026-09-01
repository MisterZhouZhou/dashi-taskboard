import { useEffect, useMemo, useState } from "react";
import {
  listExecutionRuns,
  subscribeExecutionEvents,
} from "../api";
import { useTaskboardI18n } from "../i18n";
import type { ExecutionRun } from "../types";
import { ExecutionEventStream } from "./ExecutionEventStream";

function sortRuns(runs: ExecutionRun[]): ExecutionRun[] {
  return [...runs].sort((left, right) => {
    const leftRunning = left.status === "running" ? 0 : 1;
    const rightRunning = right.status === "running" ? 0 : 1;
    if (leftRunning !== rightRunning) return leftRunning - rightRunning;
    return right.startedAt.localeCompare(left.startedAt) || right.id.localeCompare(left.id);
  });
}

export interface ExecutionCenterProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenTask: (taskId: string) => void;
}

export function ExecutionCenter({ open, onOpenChange, onOpenTask }: ExecutionCenterProps) {
  const { text } = useTaskboardI18n();
  const [runs, setRuns] = useState<ExecutionRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const runningCount = useMemo(
    () => runs.filter((run) => run.status === "running").length,
    [runs],
  );

  useEffect(() => {
    const controller = new AbortController();
    const load = () => {
      void listExecutionRuns({ limit: 50 }, controller.signal)
        .then((next) => {
          if (!controller.signal.aborted) setRuns(sortRuns(next));
        })
        .catch(() => {});
    };
    load();
    const interval = window.setInterval(load, open ? 10_000 : 30_000);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [open]);

  useEffect(() => subscribeExecutionEvents((payload) => {
    if (payload.run) {
      setRuns((current) => sortRuns([payload.run!, ...current.filter((run) => run.id !== payload.run!.id)]));
    }
  }), []);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onOpenChange, open]);

  return (
    <>
      <button
        className={`execution-center-trigger${runningCount > 0 ? " is-active" : ""}`}
        type="button"
        aria-label={text(
          `执行中心${runningCount > 0 ? `，${runningCount} 个任务运行中` : ""}`,
          `Execution center${runningCount > 0 ? `, ${runningCount} task${runningCount === 1 ? "" : "s"} running` : ""}`,
        )}
        title={text("执行中心", "Execution center")}
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        <span>{text("执行中心", "Executions")}</span>
        {runningCount > 0 && <span className="execution-center-badge">{runningCount}</span>}
      </button>
      {open && (
        <div className="execution-center-layer">
          <button className="execution-center-backdrop" type="button" aria-label={text("关闭执行中心", "Close execution center")} onClick={() => onOpenChange(false)} />
          <aside className="execution-center-drawer" aria-label={text("执行中心", "Execution center")}>
            <header className="execution-center-header">
              <div>
                <h2>{text("执行中心", "Execution center")}</h2>
                <span>{runningCount > 0 ? text(`${runningCount} 个任务运行中`, `${runningCount} task${runningCount === 1 ? "" : "s"} running`) : text("当前没有运行中的任务", "No tasks running")}</span>
              </div>
              <button className="icon-button" type="button" aria-label={text("关闭执行中心", "Close execution center")} onClick={() => onOpenChange(false)}>×</button>
            </header>
            {selectedRunId ? (
              <div className="execution-center-detail">
                <button className="execution-center-back" type="button" onClick={() => setSelectedRunId(null)}>← {text("返回执行列表", "Back to executions")}</button>
                <ExecutionEventStream runId={selectedRunId} />
              </div>
            ) : (
              <div className="execution-center-list">
                {runs.length === 0 && <div className="execution-empty">{text("暂无执行记录", "No execution records")}</div>}
                {runs.map((run) => (
                  <article className={`execution-run-card is-${run.status}`} key={run.id}>
                    <button type="button" className="execution-run-open" onClick={() => setSelectedRunId(run.id)}>
                      <div className="execution-run-card-heading"><strong>{run.taskIdentifier}</strong><span>{run.status === "running" ? text("执行中", "Running") : run.status === "completed" ? text("已完成", "Completed") : run.status === "failed" ? text("失败", "Failed") : text("已中断", "Interrupted")}</span></div>
                      <div className="execution-run-card-title">{run.taskTitle}</div>
                      <div className="execution-run-card-meta">{run.projectName} · {run.agent === "claude-code" ? "Claude Code" : "Codex CLI"} · {run.source === "manual" ? text("手动执行", "Manual") : text("自动认领", "Auto-claim")}</div>
                      {run.lastEventSummary && <div className="execution-run-card-summary">{run.lastEventSummary}</div>}
                    </button>
                    <button className="execution-run-task-link" type="button" onClick={() => onOpenTask(run.taskId)}>{text("打开任务", "Open task")}</button>
                  </article>
                ))}
              </div>
            )}
          </aside>
        </div>
      )}
    </>
  );
}
