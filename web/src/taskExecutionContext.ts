import type { Attachment, Comment, Task } from "./types";

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

const PARENT_COMMENT_LIMIT = 8;
const PARENT_COMMENT_CHARS = 500;
const PARENT_DESCRIPTION_CHARS = 1_000;

function truncate(value: string, max: number): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

/**
 * 子任务继承的父任务上下文：目标 + 评论（用户指令与 agent 进展汇报都保留，
 * 按时间正序限量）+ 附件清单 + 祖父任务标题，让接续执行的 agent 知道
 * 父任务做到了什么程度。
 */
export function buildParentContextSummary(
  task: Task,
  tasks: Task[],
  parentComments: Comment[] = [],
  parentAttachments: Attachment[] = [],
): string {
  if (!task.inheritParentContext || !task.relations.parent) return "";
  const pool = new Map<string, Task>();
  for (const candidate of tasks) pool.set(candidate.id, candidate);
  const parent = pool.get(task.relations.parent.id);
  if (!parent) return "";

  const lines: string[] = [];
  lines.push(`父任务：${parent.identifier} ${parent.title}（${parent.status}）`);
  const description = truncate(parent.description, PARENT_DESCRIPTION_CHARS);
  if (description) lines.push(`父任务目标：${description}`);

  if (parentComments.length > 0) {
    const ordered = [...parentComments].sort((left, right) => (
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
    ));
    const omitted = Math.max(0, ordered.length - PARENT_COMMENT_LIMIT);
    const visible = omitted > 0 ? ordered.slice(-PARENT_COMMENT_LIMIT) : ordered;
    lines.push(`父任务评论（${ordered.length} 条${omitted > 0 ? `，省略更早 ${omitted} 条` : ""}）：`);
    visible.forEach((comment, index) => {
      const role = comment.authorType === "agent" ? "agent" : "用户";
      const body = truncate(comment.body, PARENT_COMMENT_CHARS) || "（空）";
      lines.push(`${index + 1}. [${role}] ${comment.authorName} ${comment.createdAt.slice(0, 10)}：${body}`);
      for (const commentAttachment of comment.attachments) {
        lines.push(`   附件：${commentAttachment.filename}`);
      }
    });
  }

  if (parentAttachments.length > 0) {
    lines.push(`父任务附件：${parentAttachments.map((a) => a.filename).join("、")}`);
  }

  const grandparent = parent.relations.parent ? pool.get(parent.relations.parent.id) : undefined;
  if (grandparent) {
    lines.push(`祖父任务：${grandparent.identifier} ${grandparent.title}`);
  }
  return lines.join("\n");
}
