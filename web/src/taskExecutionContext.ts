import type { DevelopmentContext, Task } from "./types";

export function resolveEffectiveDevelopmentContext(task: Task, tasks: Task[]) {
  if (task.developmentContext) return { context: task.developmentContext, sourceTask: task };
  if (!task.inheritParentContext) return { context: null, sourceTask: null };

  const taskById = new Map(tasks.map((candidate) => [candidate.id, candidate]));
  const visited = new Set<string>([task.id]);
  let parentId = task.relations.parent?.id ?? null;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = taskById.get(parentId);
    if (!parent) break;
    if (parent.developmentContext) return { context: parent.developmentContext, sourceTask: parent };
    parentId = parent.relations.parent?.id ?? null;
  }
  return { context: null, sourceTask: null };
}

export function buildParentContextSummary(task: Task, tasks: Task[]): string {
  if (!task.inheritParentContext || !task.relations.parent) return "";
  const parent = tasks.find((candidate) => candidate.id === task.relations.parent?.id);
  if (!parent) return "";
  const description = parent.description.trim().replace(/\s+/g, " ").slice(0, 600);
  return [
    `父任务：${parent.identifier} ${parent.title}`,
    description ? `父任务目标摘要：${description}` : "",
  ].filter(Boolean).join("\n");
}
