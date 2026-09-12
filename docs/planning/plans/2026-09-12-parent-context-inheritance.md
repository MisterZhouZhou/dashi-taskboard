# 子任务继承父任务执行上下文 Implementation Plan

**Goal:** 为子任务增加可持久化的“继承父任务执行上下文”开关，使功能拆分任务复用父任务的开发环境和只读背景，同时保持独立探索任务与 Codex 会话隔离。

**Architecture:** 在任务实体上新增 `inheritParentContext` 布尔字段，不把配置放入父子关系表。前端创建/详情 UI 管理该字段；运行 Agent 前通过纯函数按“子任务自身上下文 > 最近父任务上下文 > 项目默认目录”解析有效开发上下文，并仅在开关开启时生成父任务摘要。后端本地 SQLite 与 Cloud D1 同步增加字段，已有任务默认关闭。

**Tech Stack:** React 19、TypeScript、Vite、Node HTTP API、SQLite、Cloudflare D1 migration、Node test。

## Global Constraints

- 当前分支为 `feat/task-detail-tree`；继续在该分支实现，不创建新分支。
- 保留工作区已有的 `package-lock.json` 未提交变更，不修改、不提交。
- 不继承父任务 Codex `threadBinding`、评论、附件、负责人、状态、优先级、截止日期或标签。
- 子任务自己的 `developmentContext` 永远优先于父任务上下文。
- 独立创建后再关联父任务时，不能自动打开继承开关。
- 从父任务范围创建子任务时，继承开关默认打开，但用户可关闭。
- 不复制父任务描述到子任务；只在启动 Agent 时注入受限长度的只读摘要。
- 不执行 TDD 流程；实现完成后运行聚焦类型检查、API/数据库测试和真实 Agent 启动路径验证。
- 不扩展父子状态同步、多父任务合并或任务属性模板能力。

---

### Task 1: 持久化字段和 API 类型贯通

**Files:**
- Modify: `web/src/types.ts:Task,TaskDraft`
- Modify: `web/src/api.ts:createTask,updateTask`
- Modify: `server/app.mjs:parseTaskCreate,parseTaskPatch`
- Modify: `server/database.mjs:task row mapping, schema initialization, createTask, updateTask`
- Create: `cloud/migrations/0012_task_inherit_parent_context.sql`
- Test: `test/server.test.mjs`, `test/cloud-shared-worker.test.mjs`, `test/cloud-migration.test.mjs`

**Interfaces:**
- Consumes: existing `TaskDraft`, `POST /api/tasks`, `PATCH /api/tasks/:id`, local SQLite task rows, Cloud D1 task rows
- Produces: `Task.inheritParentContext: boolean`, `TaskDraft.inheritParentContext: boolean`, API create/patch field `inheritParentContext`

- [ ] **Step 1: Extend client and server task contracts**

  Add a required boolean to `Task` and `TaskDraft`:

  ```ts
  inheritParentContext: boolean;
  ```

  Add `inheritParentContext` to the allowed create/patch keys in `server/app.mjs`. Parse it as a boolean; when omitted on create, use `false` so existing independent tasks remain independent. When omitted on patch, preserve the existing value.

- [ ] **Step 2: Add local SQLite storage and migration**

  Add `inherit_parent_context INTEGER NOT NULL DEFAULT 0` to the initial task schema in `server/database.mjs` and add an idempotent existing-database migration alongside the current `PRAGMA table_info(tasks)` migrations.

  Update all task row mapping paths so API task objects always expose a boolean:

  ```js
  inheritParentContext: row.inherit_parent_context === 1
  ```

  Update `createTask` INSERT values and `updateTask` column mapping. A task update that does not include the field must leave the existing value unchanged.

- [ ] **Step 3: Add Cloud D1 migration**

  Create `cloud/migrations/0012_task_inherit_parent_context.sql`:

  ```sql
  ALTER TABLE tasks
    ADD COLUMN inherit_parent_context INTEGER NOT NULL DEFAULT 0;
  ```

  Keep the migration additive and compatible with existing cloud rows. Confirm the cloud worker’s task serialization returns the new column through the existing mapping.

- [ ] **Step 4: Wire web API payloads**

  Ensure `createTask()` and `updateTask()` serialize the new field through the existing `TaskDraft` spread. Do not add a separate endpoint.

- [ ] **Step 5: Run focused persistence checks**

  Run: `npm run typecheck && node --test test/server.test.mjs test/cloud-shared-worker.test.mjs test/cloud-migration.test.mjs`

  Expected: existing API/database/cloud tests pass, old rows read as `inheritParentContext: false`, and create/patch responses round-trip true/false values.

**Checkpoint:** `parent-context-persistence`

---

### Task 2: 创建任务时的继承开关和默认值

**Files:**
- Modify: `web/src/components/TaskEditor.tsx:NewTaskCreateOptions,NewTaskEditorDraft,state,relation menu,save payload`
- Modify: `web/src/App.tsx:taskToDraft,saveEditor,editor initialization`
- Test: `test/task-editor-create-status.test.mjs`, `test/issue-relations.test.mjs`

**Interfaces:**
- Consumes: `NewTaskRelationDraft.parentId`, `TaskDraft.inheritParentContext`, `createTask()`, existing parent relation write flow
- Produces: creation payload with explicit `inheritParentContext`; default-on behavior for parent-scoped creation and default-off behavior for independent creation

- [ ] **Step 1: Add editor state and draft plumbing**

  Add `inheritParentContext` to `NewTaskEditorDraft` and `NewTaskCreateOptions` where needed. Initialize new-task state to `false`, and initialize edit-task state from `task.inheritParentContext`.

  When a parent is selected during creation through the parent relation menu, set the default to `true` only if the editor was opened in a parent-scoped create flow. Do not silently turn it on when an existing standalone task is later linked.

- [ ] **Step 2: Add the checkbox UI**

  In the create editor’s relation/context area, render a checkbox labeled:

  ```text
  继承父任务执行上下文
  ```

  Show it when a parent is selected. The checked value is user-editable. For an edit form, show the current persisted value. Do not show the control for root tasks with no parent.

- [ ] **Step 3: Pass the field through `saveEditor`**

  Include `inheritParentContext` in the `TaskDraft` sent to `createTaskRequest`/`updateTaskRequest`.

  Preserve the distinction:

  - Creating with `parentId` from the parent-scoped flow: default true unless user unchecks.
  - Creating independently: false.
  - Adding a parent relation after creation: do not mutate the field automatically.

  Keep the existing post-create `addTaskRelation()` calls unchanged except for using the new task payload.

- [ ] **Step 4: Keep editor reopen/cancel state consistent**

  Include the checkbox value in `NewTaskEditorDraft` so cancel/reopen behavior does not lose the user’s choice. Ensure “create another” resets it to the correct default for the next task.

- [ ] **Step 5: Verify creation paths**

  Run: `npm run typecheck && node --test test/task-editor-create-status.test.mjs test/issue-relations.test.mjs`

  Expected: editor source checks pass; a parent-scoped create sends true by default, an independent create sends false, and relation selection does not rewrite an existing task’s setting.

**Checkpoint:** `parent-context-create-defaults`

---

### Task 3: 任务详情中的继承开关和来源展示

**Files:**
- Modify: `web/src/components/TaskDetail.tsx:taskToDraft usage, development context property row`
- Modify: `web/src/styles.css:development context controls`
- Test: `test/board-interactions.test.mjs`, `test/issue-relations.test.mjs`

**Interfaces:**
- Consumes: `Task.inheritParentContext`, `Task.relations.parent`, `onUpdate(task, changes)`
- Produces: detail UI that displays inherited source and persists a toggle without changing relations or session binding

- [ ] **Step 1: Add a detail-level toggle near development context**

  In the existing development-context property area, when `currentTask.relations.parent` exists, render a checkbox/switch with the label `继承父任务执行上下文` and the persisted checked value.

  If the task has no parent, omit the control. If the task has an explicit own `developmentContext`, show that it takes precedence while leaving the toggle available for future parent-context background inheritance.

- [ ] **Step 2: Show source text**

  When inheritance is enabled and an effective parent context exists, show:

  ```text
  继承自：<parent identifier> · <parent title>
  ```

  When disabled, show `当前任务独立执行`. When the task has its own context, show `当前任务配置优先`.

- [ ] **Step 3: Persist changes through the existing task update path**

  Extend `taskToDraft()` and the detail save call so toggling the control sends only the current task draft plus `inheritParentContext`. Preserve optimistic/version-conflict behavior already used by `saveTask`.

- [ ] **Step 4: Add focused styling**

  Match existing property rows, switches, and muted helper text. Do not change the task hierarchy tree styling or unrelated property groups.

- [ ] **Step 5: Verify detail behavior**

  Run: `npm run typecheck && node --test test/board-interactions.test.mjs test/issue-relations.test.mjs`

  Expected: the toggle is rendered only for tasks with parents, source text reflects the persisted state, and the existing relation sidebar/tree remains unchanged.

**Checkpoint:** `parent-context-detail-toggle`

---

### Task 4: 运行时解析继承上下文和父任务摘要

**Files:**
- Create: `web/src/taskExecutionContext.ts`
- Modify: `web/src/App.tsx:openTaskThread/embeddedInstruction/workspace resolution`
- Test: `test/task-execution-context.test.mjs` (create focused pure-function tests)

**Interfaces:**
- Consumes: `Task`, `Task[]`, `Task.relations.parent`, `inheritParentContext`, `developmentContext`, project workspace
- Produces:

  ```ts
  resolveEffectiveDevelopmentContext(task: Task, tasks: Task[]): {
    context: DevelopmentContext | null;
    sourceTask: Task | null;
  }
  buildParentContextSummary(task: Task, tasks: Task[]): string;
  ```

- [ ] **Step 1: Implement pure resolver**

  In `web/src/taskExecutionContext.ts`, implement a visited-set traversal:

  1. If the current task has its own `developmentContext`, return it with `sourceTask = current task`.
  2. If `inheritParentContext` is false, return null/current task boundary.
  3. Walk `relations.parent` through `tasks` while tracking visited IDs.
  4. Return the first ancestor with `developmentContext`.
  5. Stop safely on missing parent rows or cycles.

  Keep the resolver independent of browser APIs so it can be tested with fixture tasks.

- [ ] **Step 2: Build bounded parent summary**

  Generate a concise summary for the direct parent only, including identifier, title, and a bounded description/constraint excerpt. Do not include comments, attachments, or thread IDs. Return an empty string when inheritance is disabled or no parent exists.

- [ ] **Step 3: Use resolver in Agent startup**

  In `App.tsx`, replace direct use of `task.developmentContext` for effective workspace selection with the resolver result. Preserve existing remote/local worktree validation and project fallback behavior.

  Append the parent summary to `embeddedInstruction` only when inheritance is enabled. Keep task ID, task title, project/host identity, and the child task’s own thread creation payload unchanged.

- [ ] **Step 4: Preserve session isolation**

  Confirm the child task still calls the existing `taskboard:create-thread` flow with the child task ID and never uses `parent.threadBinding` or parent thread ID.

- [ ] **Step 5: Run resolver and startup checks**

  Run: `npm run typecheck && node --test test/task-execution-context.test.mjs test/taskboard-automation.test.mjs`

  Expected: resolver tests cover own context, inherited nearest ancestor, disabled inheritance, missing ancestor, cycle termination, and child-session isolation assertions.

**Checkpoint:** `parent-context-runtime`

---

### Task 5: Local/cloud integration verification and direct product path

**Files:**
- Verify: `server/database.mjs`, `server/app.mjs`, `cloud/migrations/0012_task_inherit_parent_context.sql`, `web/src/Task*`, `web/src/App.tsx`
- Test: `test/server.test.mjs`, `test/cloud-shared-worker.test.mjs`, `test/task-execution-context.test.mjs`

**Interfaces:**
- Consumes: local Taskboard runtime and a project with a parent task, a parent-scoped child, and an independently-created task later linked to the parent
- Produces: observable default values, detail toggle, effective worktree resolution, and child Agent prompt/session behavior

- [ ] **Step 1: Run focused checks**

  Run:

  ```bash
  npm run typecheck
  npm run build:web
  node --test test/server.test.mjs test/cloud-shared-worker.test.mjs test/cloud-migration.test.mjs test/task-editor-create-status.test.mjs test/task-execution-context.test.mjs test/issue-relations.test.mjs test/issue-detail-route.test.mjs
  ```

  Expected: all focused tests pass and Web build completes.

- [ ] **Step 2: Verify parent-scoped creation**

  In the real Taskboard UI, create a child under a parent task. Confirm the checkbox defaults on, the task detail displays the parent source, and the effective development context points to the parent when the child has no explicit context.

- [ ] **Step 3: Verify independent exploration**

  Create an exploration task without a parent, then associate it to the feature parent. Confirm the checkbox remains off and the task remains independently resolved until the user enables inheritance.

- [ ] **Step 4: Verify explicit child override**

  Set a child-specific worktree/context. Confirm the UI identifies the child context as effective and Agent startup does not replace it with the parent context.

- [ ] **Step 5: Verify child Agent isolation**

  Start the child Agent. Confirm the prompt contains bounded parent background when enabled, the selected workspace follows the resolver, and the created thread is bound to the child task rather than the parent.

- [ ] **Step 6: Check scope and workspace**

  Run: `git diff --check && git status --short --branch`

  Expected: changes are limited to the approved persistence, editor/detail UI, runtime resolver, migration, focused tests, and planning docs; the pre-existing `package-lock.json` modification remains untouched.

**Checkpoint:** `parent-context-inheritance-ready`

---

## Commits / Checkpoints

1. `parent-context-persistence`: schema, migrations, API, types.
2. `parent-context-create-defaults`: creation defaults and checkbox.
3. `parent-context-detail-toggle`: detail toggle and source presentation.
4. `parent-context-runtime`: resolver and Agent prompt/workspace integration.
5. `parent-context-inheritance-ready`: focused checks and direct product verification.

## Self-review

- Functional decomposition tasks inherit background and effective development context when enabled.
- Independent exploration tasks remain off by default when linked after creation.
- Parent descriptions are summarized at runtime, not copied into child data.
- Child Codex sessions remain independent.
- Explicit child development context wins over inherited context.
- Local SQLite and Cloud D1 persistence are both covered.
- No unrelated task status, ownership, relation, or thread behavior is changed.
- The plan honors the user’s instruction not to run TDD while still defining focused post-implementation verification.
