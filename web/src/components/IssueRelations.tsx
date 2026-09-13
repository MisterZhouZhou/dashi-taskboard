import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import type {
  IssueRelationType,
  Task,
  TaskRelationSummary,
} from "../types";
import { useTaskboardI18n } from "../i18n";
import { ActorAvatar } from "./ActorAvatar";
import { LinearIcon } from "./LinearIcon";
import {
  BlockingRelationIcon,
  PlusIcon,
  RelationIcon,
  StatusIcon,
} from "./SemanticIcons";

export interface RelationMutationResult {
  task: Task;
  relatedTask: Task;
}

export function IssuePickerContent({
  candidates,
  selectedIds,
  disabled,
  onSelect,
  onEscape,
}: {
  candidates: Task[];
  selectedIds?: ReadonlySet<string>;
  disabled?: boolean;
  onSelect: (task: Task) => void | Promise<void>;
  onEscape: () => void;
}) {
  const { text } = useTaskboardI18n();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [savingId, setSavingId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const results = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return candidates;
    return candidates.filter((task) => (
      (task.externalKey ?? task.identifier).toLocaleLowerCase().includes(normalized)
      || task.title.toLocaleLowerCase().includes(normalized)
    ));
  }, [candidates, query]);

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  useEffect(() => {
    optionRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  async function choose(task: Task) {
    setSavingId(task.id);
    try {
      await onSelect(task);
    } catch {
    } finally {
      setSavingId(null);
    }
  }

  return (
    <>
      <div className="issue-relation-search">
        <LinearIcon name="search" />
        <input
          ref={inputRef}
          value={query}
          role="combobox"
          aria-expanded="true"
          aria-controls="issue-relation-results"
          aria-activedescendant={results[activeIndex] ? `relation-option-${results[activeIndex].id}` : undefined}
          placeholder={text("搜索议题…", "Search issues…")}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Enter") {
              if (event.metaKey || event.ctrlKey) return;
              event.preventDefault();
              const activeResult = results[activeIndex];
              if (activeResult) void choose(activeResult);
            } else if (event.key === "Escape") {
              event.preventDefault();
              onEscape();
            } else if (event.key === "ArrowDown" && results.length > 0) {
              event.preventDefault();
              setActiveIndex((index) => (index + 1) % results.length);
            } else if (event.key === "ArrowUp" && results.length > 0) {
              event.preventDefault();
              setActiveIndex((index) => (index - 1 + results.length) % results.length);
            }
          }}
        />
      </div>
      <div
        className={`issue-relation-results${selectedIds ? " has-selections" : ""}`}
        id="issue-relation-results"
        role="listbox"
      >
        {results.length > 0 ? results.map((candidate, index) => {
          const selected = selectedIds?.has(candidate.id) ?? false;
          const className = [
            index === activeIndex ? "is-active" : "",
            selected ? "is-selected" : "",
          ].filter(Boolean).join(" ");
          return (
            <button
              ref={(element) => {
                optionRefs.current[index] = element;
              }}
              id={`relation-option-${candidate.id}`}
              className={className}
              type="button"
              role="option"
              aria-selected={selectedIds ? selected : index === activeIndex}
              disabled={disabled || savingId !== null}
              key={candidate.id}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => void choose(candidate)}
            >
              <StatusIcon status={candidate.status} size={14} />
              <span className="issue-relation-option-id">{candidate.externalKey ?? candidate.identifier}</span>
              <span className="issue-relation-option-title">{candidate.title}</span>
              {selectedIds && (
                <span className="issue-relation-option-check">
                  {selected && <LinearIcon name="check" />}
                </span>
              )}
            </button>
          );
        }) : (
          <p className="issue-relation-empty">{text("没有匹配的议题", "No matching issues")}</p>
        )}
      </div>
    </>
  );
}

interface RelationActions {
  task: Task;
  tasks: Task[];
  onOpenTask: (task: TaskRelationSummary) => void;
  onAddRelation: (
    task: Task,
    type: IssueRelationType,
    relatedTaskId: string,
  ) => Promise<RelationMutationResult>;
  onRemoveRelation: (
    task: Task,
    type: IssueRelationType,
    relatedTaskId: string,
  ) => Promise<RelationMutationResult>;
}

export function IssuePicker({
  label,
  candidates,
  disabled,
  onSelect,
}: {
  label: string;
  candidates: Task[];
  disabled?: boolean;
  onSelect: (task: Task) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  return (
    <div className="issue-relation-picker" ref={rootRef}>
      <button
        className="issue-relation-add"
        type="button"
        disabled={disabled}
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <PlusIcon color="currentColor" size={13} />
        <span>{label}</span>
      </button>
      {open && (
        <div className="issue-relation-popover">
          <IssuePickerContent
            candidates={candidates}
            disabled={disabled}
            onEscape={() => setOpen(false)}
            onSelect={async (task) => {
              await onSelect(task);
              setOpen(false);
            }}
          />
        </div>
      )}
    </div>
  );
}

function descendantIds(task: Task, tasks: Task[]) {
  const descendants = new Set<string>();
  const queue = [...task.relations.subIssues.map((item) => item.id)];
  const taskById = new Map(tasks.map((candidate) => [candidate.id, candidate]));
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (descendants.has(id)) continue;
    descendants.add(id);
    const child = taskById.get(id);
    if (child) queue.push(...child.relations.subIssues.map((item) => item.id));
  }
  return descendants;
}

function IssueRelationRow({
  issue,
  onOpen,
  onRemove,
  removing,
  showAssignee = false,
}: {
  issue: TaskRelationSummary;
  onOpen: () => void;
  onRemove: () => void;
  removing: boolean;
  showAssignee?: boolean;
}) {
  const { text } = useTaskboardI18n();
  return (
    <div className="issue-relation-row">
      <button className="issue-relation-target" type="button" onClick={onOpen}>
        <StatusIcon status={issue.status} size={14} />
        <span className="issue-relation-id">{issue.externalKey ?? issue.identifier}</span>
        <span className="issue-relation-title">{issue.title}</span>
        {showAssignee && <ActorAvatar actor={issue.assignee} className="issue-relation-assignee" />}
      </button>
      <button
        className="issue-relation-remove"
        type="button"
        aria-label={text(
          `移除 ${issue.externalKey ?? issue.identifier}`,
          `Remove ${issue.externalKey ?? issue.identifier}`,
        )}
        disabled={removing}
        onClick={onRemove}
      >
        <LinearIcon name="close" />
      </button>
    </div>
  );
}

interface IssueTaskTreeNodeProps {
  task: Task;
  depth: number;
  taskById: ReadonlyMap<string, Task>;
  expandedIds: ReadonlySet<string>;
  onToggle: (taskId: string) => void;
  onOpenTask: (task: TaskRelationSummary) => void;
  onRemoveChild: (child: Task, parentId: string) => void;
  removingId: string | null;
  parentId?: string;
}

function IssueTaskTreeNode({
  task,
  depth,
  taskById,
  expandedIds,
  onToggle,
  onOpenTask,
  onRemoveChild,
  removingId,
  parentId,
}: IssueTaskTreeNodeProps) {
  const { text } = useTaskboardI18n();
  const children = task.relations.subIssues
    .filter((summary) => summary.id !== task.id)
    .map((summary) => ({ summary, task: taskById.get(summary.id) }))
    .filter((item): item is { summary: TaskRelationSummary; task: Task } => Boolean(item.task));
  const expanded = expandedIds.has(task.id);

  return (
    <div className="issue-task-tree-node" style={{ "--issue-tree-depth": depth } as CSSProperties}>
      <div className="issue-relation-row">
        {children.length > 0 ? (
          <button
            className="issue-task-tree-toggle"
            type="button"
            aria-expanded={expanded}
            aria-label={expanded
              ? text("收起子任务", "Collapse sub-issues")
              : text("展开子任务", "Expand sub-issues")}
            onClick={() => onToggle(task.id)}
          >
            <LinearIcon name={expanded ? "chevronDown" : "chevronRight"} />
          </button>
        ) : <span className="issue-task-tree-toggle-spacer" aria-hidden="true" />}
        <button
          className="issue-relation-target"
          type="button"
          onClick={() => onOpenTask({
            id: task.id,
            identifier: task.identifier,
            externalKey: task.externalKey,
            projectId: task.projectId,
            title: task.title,
            status: task.status,
            priority: task.priority,
            assignee: task.assignee,
            archivedAt: task.archivedAt,
          })}
        >
          <StatusIcon status={task.status} size={14} />
          <span className="issue-relation-title">{task.title}</span>
          {(depth > 0 || parentId !== undefined) && (
            <ActorAvatar actor={task.assignee} className="issue-relation-assignee" />
          )}
        </button>
        {depth > 0 && (
          <button
            className="issue-relation-remove"
            type="button"
            aria-label={text(
              `移除 ${task.externalKey ?? task.identifier}`,
              `Remove ${task.externalKey ?? task.identifier}`,
            )}
            disabled={removingId === task.id}
            onClick={() => {
              const confirmed = window.confirm(text(
                `确定要从当前任务中移除“${task.title}”吗？这只会解除父子关系，不会删除任务。`,
                `Remove “${task.title}” from this task? This only removes the parent relationship; the task will not be deleted.`,
              ));
              if (confirmed) onRemoveChild(task, parentId ?? "");
            }}
          >
            <LinearIcon name="close" />
          </button>
        )}
      </div>
      {expanded && children.length > 0 && (
        <div className={`issue-task-tree-children${depth === 0 ? " issue-task-tree-list" : ""}`}>
          {children.map(({ task: child }) => (
            <IssueTaskTreeNode
              key={child.id}
              task={child}
              depth={depth + 1}
              taskById={taskById}
              expandedIds={expandedIds}
              onToggle={onToggle}
              onOpenTask={onOpenTask}
              onRemoveChild={onRemoveChild}
              removingId={removingId}
              parentId={task.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function IssueTaskTree({
  task,
  tasks,
  onOpenTask,
  onAddRelation,
  onRemoveRelation,
}: RelationActions) {
  const { text } = useTaskboardI18n();
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const taskById = useMemo(() => new Map(tasks.map((candidate) => [candidate.id, candidate])), [tasks]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => {
    const ids = new Set<string>();
    const queue = [task.id];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (ids.has(id)) continue;
      ids.add(id);
      const child = id === task.id ? task : taskById.get(id);
      child?.relations.subIssues.forEach((item) => {
        if (taskById.has(item.id)) queue.push(item.id);
      });
    }
    return ids;
  });
  useEffect(() => {
    setExpandedIds((current) => {
      const next = new Set(current);
      next.add(task.id);
      return next;
    });
  }, [task.id]);

  const parent = task.relations.parent;
  const directIds = new Set(task.relations.subIssues.map((item) => item.id));
  const ancestors = new Set<string>([task.id]);
  let ancestor = parent;
  while (ancestor && !ancestors.has(ancestor.id)) {
    ancestors.add(ancestor.id);
    ancestor = taskById.get(ancestor.id)?.relations.parent ?? null;
  }
  const childCandidates = tasks.filter((candidate) => (
    candidate.archivedAt === null
    && !ancestors.has(candidate.id)
    && !directIds.has(candidate.id)
  ));
  const rootChildren = task.relations.subIssues
    .filter((summary) => summary.id !== task.id)
    .map((summary) => ({ summary, task: taskById.get(summary.id) }))
    .filter((item): item is { summary: TaskRelationSummary; task: Task } => Boolean(item.task));

  return (
    <section className="issue-task-tree" aria-labelledby="task-tree-heading">
      <header className="issue-task-tree-header">
        <h2 id="task-tree-heading">{text("任务层级", "Task hierarchy")}</h2>
        <IssuePicker
          label={text("添加子任务", "Add sub-issue")}
          candidates={childCandidates}
          disabled={savingKey !== null}
          onSelect={async (candidate) => {
            setSavingKey(candidate.id);
            try {
              await onAddRelation(candidate, "parent", task.id);
            } finally {
              setSavingKey(null);
            }
          }}
        />
      </header>
      {rootChildren.length > 0 && (
        <div className="issue-task-tree-list">
          {rootChildren.map(({ task: child }) => (
            <IssueTaskTreeNode
              key={child.id}
              task={child}
              depth={0}
              taskById={taskById}
              expandedIds={expandedIds}
              onToggle={(taskId) => setExpandedIds((current) => {
                const next = new Set(current);
                if (next.has(taskId)) next.delete(taskId); else next.add(taskId);
                return next;
              })}
              onOpenTask={onOpenTask}
              onRemoveChild={(childTask, parentId) => {
                if (!parentId) return;
                setSavingKey(childTask.id);
                void onRemoveRelation(childTask, "parent", parentId)
                  .catch(() => undefined)
                  .finally(() => setSavingKey(null));
              }}
              removingId={savingKey}
              parentId={task.id}
            />
          ))}
        </div>
      )}
    </section>
  );
}

const RELATION_GROUPS = [
  {
    type: "blocked_by",
    field: "blockedBy",
    chineseLabel: "阻塞于",
    englishLabel: "Blocked by",
    chineseAddLabel: "添加阻塞议题",
    englishAddLabel: "Add blocker",
    chineseHint: "这些议题全部标记为「完成」后，本议题才会被自动认领；在此之前会被跳过。",
    englishHint: "This issue is only auto-claimed once every issue listed here is marked done; until then it is skipped.",
    tone: "blocked-by",
  },
  {
    type: "blocks",
    field: "blocks",
    chineseLabel: "阻塞",
    englishLabel: "Blocks",
    chineseAddLabel: "添加被阻塞议题",
    englishAddLabel: "Add blocked issue",
    chineseHint: "本议题标记为「完成」后，这些议题才会被自动认领。反向关系，不影响本议题何时开始。",
    englishHint: "The issues listed here wait until this one is marked done. This is the reverse relation and does not gate this issue.",
    tone: "blocks",
  },
  {
    type: "related",
    field: "related",
    chineseLabel: "相关议题",
    englishLabel: "Related issues",
    chineseAddLabel: "添加相关议题",
    englishAddLabel: "Add related issue",
    chineseHint: "",
    englishHint: "",
    tone: "related",
  },
] as const;

export function IssueRelationSidebar({
  task,
  tasks,
  onOpenTask,
  onAddRelation,
  onRemoveRelation,
}: RelationActions) {
  const { text } = useTaskboardI18n();
  const [savingKey, setSavingKey] = useState<string | null>(null);

  return (
    <section className="issue-relation-sidebar" aria-labelledby="relations-heading">
      <h2 id="relations-heading">{text("关系", "Relations")}</h2>
      {RELATION_GROUPS.map((group) => {
        const label = text(group.chineseLabel, group.englishLabel);
        const issues = task.relations[group.field];
        const existing = new Set(issues.map((issue) => issue.id));
        const candidates = tasks.filter((candidate) => (
          candidate.archivedAt === null
          && candidate.id !== task.id
          && !existing.has(candidate.id)
        ));
        return (
          <div className={`issue-relation-group is-${group.tone}`} key={group.type}>
            <header>
              <span>
                {group.type === "related" ? (
                  <RelationIcon color="currentColor" size={14} />
                ) : (
                  <BlockingRelationIcon
                    type={group.type}
                    color="currentColor"
                    title={text(group.chineseHint, group.englishHint)}
                    aria-label={text(group.chineseHint, group.englishHint)}
                  />
                )}
                {label}
              </span>
              <IssuePicker
                label={text(group.chineseAddLabel, group.englishAddLabel)}
                candidates={candidates}
                disabled={savingKey !== null}
                onSelect={async (candidate) => {
                  const key = `${group.type}:${candidate.id}`;
                  setSavingKey(key);
                  try {
                    await onAddRelation(task, group.type, candidate.id);
                  } finally {
                    setSavingKey(null);
                  }
                }}
              />
            </header>
            {issues.map((issue) => (
              <IssueRelationRow
                issue={issue}
                key={issue.id}
                removing={savingKey === `${group.type}:${issue.id}`}
                onOpen={() => onOpenTask(issue)}
                onRemove={() => {
                  const key = `${group.type}:${issue.id}`;
                  setSavingKey(key);
                  void onRemoveRelation(task, group.type, issue.id)
                    .catch(() => undefined)
                    .finally(() => setSavingKey(null));
                }}
              />
            ))}
          </div>
        );
      })}
    </section>
  );
}
