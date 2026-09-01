# Taskboard Agent 执行可观测性 Implementation Plan

**Goal:** 在当前 Taskboard 应用内，为手动“立即执行”和定时自动认领提供同一套可持久化、可实时推送的 Agent 反馈流，并在任务详情与顶部右侧执行中心中展示。

**Architecture:** 新增独立的 `execution_runs` 与 `execution_events` 本地 SQLite 数据模型。Codex CLI/Claude Code CLI 的原始 JSONL 由服务端归一化为统一事件，写入数据库后通过现有 `/api/events` SSE 广播；任务详情按 `taskId` 过滤，顶部右侧执行中心按全部 Taskboard run 聚合。`threadBinding` 继续表示任务当前负责会话，执行记录单独保存每一轮历史，不复用 `ai_chat_events`。

**Tech Stack:** Node.js 22.20、`node:sqlite`/`DatabaseSync`、Node HTTP、现有 `EventHub` SSE、React 19、TypeScript、Vite、Node test runner、Vitest/jsdom。

## Global Constraints

- 只记录当前 Taskboard 服务发起或管理的本地 Agent 执行；不扫描外部终端会话，不改 Codex App 外部历史。
- 覆盖 `manual` 与 `auto-claim` 两种来源，以及 `codex` 与 `claude-code` 两种执行器。
- 展示真实 Agent 事件；不增加虚假的百分比、预计剩余时间或无法由运行时证明的阶段。
- 现有 `threadId`/`threadBinding` 语义不变：它们表示任务当前负责会话；每次重新执行创建新的 Execution Run。
- 继续保留任务状态最终以 Taskboard 数据库回读为准，不能只用 CLI 退出码判断成功。
- 当前工作树已有自动认领相关未提交改动；实施时必须保留这些改动，只修改本功能涉及的行和文件。
- 不在本期修改 `cloud/` D1 schema；执行 API 使用 `/api/local/executions`，云端仍通过本地 companion 管理本地执行。
- 所有命令使用 Node 22：`export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"`。

---

### Task 1: 定义执行领域类型与 SQLite 持久化

**Files:**
- Create: `shared/execution.mjs`
- Modify: `server/database.mjs:476-1118`（迁移）和新增 Execution Run/Event 方法
- Modify: `web/src/types.ts`（ExecutionRun、ExecutionEvent、状态和来源类型）
- Test: `test/execution-database.test.mjs`

**Interfaces:**
- Consumes: `TaskboardDatabase` 现有 SQLite 连接和 `now()` 时间格式。
- Produces:
  - `ExecutionRunStatus = queued | running | completed | failed | interrupted`
  - `ExecutionSource = manual | auto-claim`
  - `createExecutionRun(input) -> ExecutionRun`
  - `getExecutionRun(runId) -> ExecutionRun | null`
  - `listExecutionRuns({ status, projectId, taskId, limit }) -> ExecutionRun[]`
  - `listExecutionEvents(runId, afterSequence = 0) -> ExecutionEvent[]`
  - `appendExecutionEvent(runId, input) -> { run, event }`
  - `finishExecutionRun(runId, status, error = null) -> ExecutionRun`

- [ ] **Step 1: Add the failing database test**

测试创建一次 run、追加有序事件、更新摘要、完成 run，以及同一任务可以保存多次 run：

```js
const run = database.createExecutionRun({
  projectId: project.id,
  taskId: task.id,
  taskIdentifier: task.identifier,
  source: "manual",
  agent: "codex",
});
assert.equal(run.status, "queued");
const first = database.appendExecutionEvent(run.id, {
  type: "agent_message",
  role: "agent",
  content: "开始读取任务",
});
const second = database.appendExecutionEvent(run.id, {
  type: "command_started",
  role: "command",
  content: "执行 taskctl issue get",
  command: "taskctl issue get TEST-1 --json",
});
assert.equal(second.event.sequence, first.event.sequence + 1);
assert.equal(database.getExecutionRun(run.id).lastEventSummary, "执行 taskctl issue get");
assert.equal(database.finishExecutionRun(run.id, "completed").status, "completed");
```

Run: `node --test test/execution-database.test.mjs`
Expected: FAIL because the execution tables and methods do not exist.

- [ ] **Step 2: Add the migration and database methods**

在 `#migrate()` 中新增：

```sql
CREATE TABLE IF NOT EXISTS execution_runs (...);
CREATE TABLE IF NOT EXISTS execution_events (...);
CREATE INDEX IF NOT EXISTS execution_runs_status_started
  ON execution_runs(status, started_at DESC);
CREATE INDEX IF NOT EXISTS execution_runs_task_started
  ON execution_runs(task_id, started_at DESC);
CREATE INDEX IF NOT EXISTS execution_events_run_sequence
  ON execution_events(run_id, sequence);
```

`execution_events.run_id` 引用 `execution_runs.id` 并使用 `ON DELETE CASCADE`。`appendExecutionEvent` 在事务中计算同一 run 的下一个 `sequence`，同时更新 `last_event_at` 和 `last_event_summary`。输出字段按事件类型分别写入 `command`、`output`、`files` 和 JSON `data`。

- [ ] **Step 3: Add shared constants and TypeScript types**

`shared/execution.mjs` 导出状态、来源和事件类型集合，服务端验证只接受这些值。`web/src/types.ts` 导出与 API JSON 一致的 `ExecutionRun`、`ExecutionEvent` 和 `ExecutionRunStatus`。

- [ ] **Step 4: Verify the task**

Run: `node --test test/execution-database.test.mjs`
Expected: PASS，覆盖迁移、顺序、摘要、完成状态和多轮历史。

Checkpoint: `git add shared/execution.mjs server/database.mjs web/src/types.ts test/execution-database.test.mjs && git commit -m "feat: add taskboard execution run storage"`

---

### Task 2: 归一化并记录 Codex/Claude CLI 事件

**Files:**
- Create: `server/execution-service.mjs`
- Modify: `server/agent-runtime.mjs`（让 reader 返回可持久化的归一化事件，同时保留现有 `state`）
- Modify: `server/auto-claim.mjs:223-314`
- Modify: `server/app.mjs:1915-1918`
- Test: `test/execution-service.test.mjs`
- Test: `test/auto-claim.test.mjs`

**Interfaces:**
- Consumes: `createAgentTurnReader(kind).consume(raw)`、`TaskboardDatabase` 执行方法和现有 `spawnCodexTurn({ onRawEvent })`。
- Produces:
  - `ExecutionService.createRun(input) -> ExecutionRun`
  - `ExecutionService.consume(runId, kind, raw) -> ExecutionEvent | null`
  - `ExecutionService.finish(runId, status, error) -> ExecutionRun`
  - `createAgentTurnReader(kind).consume(raw) -> NormalizedAgentEvent | null`

- [ ] **Step 1: Add failing normalization tests**

覆盖 Codex 的 `thread.started`、`item.started/updated/completed`、`turn.failed`，以及 Claude Code 的 assistant、tool/result 事件，要求事件类型统一为 `agent_message`、`command_started`、`command_output`、`command_completed`、`file_change`、`tool_call`、`error`、`run_completed`、`run_failed`。

Run: `node --test test/execution-service.test.mjs`
Expected: FAIL because the service and Claude-to-unified event contract do not exist.

- [ ] **Step 2: Implement `ExecutionService`**

该服务负责：

1. 创建 queued run；
2. 将归一化事件写入 `TaskboardDatabase`；
3. 以 `execution.created`、`execution.event`、`execution.updated`、`execution.finished` 回调通知 `EventHub`；
4. 在 `consume` 收到 `thread.started` 时回写 run 的 `threadId`；
5. 对 Agent 文本、命令、输出和文件路径设置单条大小上限，超出部分截断后再入库；
6. 运行完成时写入最终事件并更新 run 状态。

- [ ] **Step 3: Connect auto-claim**

在 `createTaskboardServer()` 创建 `ExecutionService`，传给 `AutoClaimService`。`runIssueNow` 和定时 `tick` 分别传入 `source: "manual"` 或 `source: "auto-claim"`。`#dispatch` 在调用 `spawnCodexTurn` 前创建 run，在 `onRawEvent` 中调用 `execution.consume`，在最终真实任务状态判断后调用 `execution.finish`。

`threadBinding` 仍由 Agent 通过 `taskctl` 写入任务；Execution Run 只记录本轮 `threadId` 和过程，不替代任务绑定。

- [ ] **Step 4: Verify the task**

Run: `node --test test/execution-service.test.mjs test/auto-claim.test.mjs`
Expected: PASS，且原有自动认领的 missing workspace、首次执行和人工重新派发测试继续通过。

Checkpoint: `git add server/execution-service.mjs server/agent-runtime.mjs server/auto-claim.mjs server/app.mjs test/execution-service.test.mjs test/auto-claim.test.mjs && git commit -m "feat: capture agent execution events"`

---

### Task 3: 增加执行记录查询 API 和 SSE 事件

**Files:**
- Modify: `server/app.mjs:2810`（复用 `/api/events`）和 `/api/local` 路由区域
- Modify: `web/src/api.ts`
- Modify: `test/server.test.mjs`
- Test: `test/execution-api.test.mjs`

**Interfaces:**
- Consumes: `ExecutionService` 查询和 `EventHub.emit()`。
- Produces:
  - `GET /api/local/executions?status=running&limit=50`
  - `GET /api/local/executions?projectId=:id&taskId=:id&limit=50`
  - `GET /api/local/executions/:runId`
  - `GET /api/local/executions/:runId/events?after=:sequence`
  - `listExecutionRuns(filters, signal?) -> Promise<ExecutionRun[]>`
  - `getExecutionRun(runId, signal?) -> Promise<ExecutionRunSnapshot>`
  - `listExecutionEvents(runId, after?, signal?) -> Promise<ExecutionEvent[]>`
  - `subscribeExecutionEvents(onEvent, onError?) -> () => void`

- [ ] **Step 1: Add failing route tests**

测试：

- 查询 running run 返回当前 Taskboard 内所有项目的运行记录；
- `projectId`、`taskId` 和 `limit` 参数按白名单验证；
- 查询单个 run 同时返回 run 和事件；
- `after` 只返回更大的 `sequence`；
- 不存在的 run 返回 `404 EXECUTION_NOT_FOUND`；
- `/api/events` 能收到 `execution.created/event/updated/finished`。

Run: `node --test test/execution-api.test.mjs`
Expected: FAIL because routes and API functions do not exist.

- [ ] **Step 2: Implement local routes**

在 `server/app.mjs` 增加参数解析、分页上限和 JSON 响应。继续使用现有 `/api/events` SSE，不新建第二条 SSE 连接协议；ExecutionService 发出的事件包含 `runId`、`projectId`、`taskId`、`sequence`、`type`、`content` 和 `at`。

- [ ] **Step 3: Implement frontend API contract**

在 `web/src/api.ts` 按现有 `request()` 和 `resolveTaskboardUrl()` 约定封装查询，并用 `EventSource` 订阅 `execution.*` 事件。断线后由组件使用 `after` 序号重新读取，禁止只依赖内存事件。

- [ ] **Step 4: Verify the task**

Run: `node --test test/execution-api.test.mjs test/server.test.mjs`
Expected: PASS，现有健康检查、事件流和权限边界不回归。

Checkpoint: `git add server/app.mjs web/src/api.ts test/execution-api.test.mjs test/server.test.mjs && git commit -m "feat: expose execution events API"`

---

### Task 4: 接入任务详情的实时执行反馈

**Files:**
- Create: `web/src/components/ExecutionEventStream.tsx`
- Create: `web/src/components/ExecutionEventStream.test.tsx`
- Modify: `web/src/components/TaskDetail.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/styles.css`

**Interfaces:**
- Consumes: `listExecutionRuns({ taskId })`、`getExecutionRun(runId)`、`listExecutionEvents()`、`subscribeExecutionEvents()`。
- Produces: `ExecutionEventStream` props：

```ts
type ExecutionEventStreamProps = {
  taskId: string;
  text: (zh: string, en: string) => string;
  onOpenThread: (binding: CodexThreadBinding) => void;
};
```

- [ ] **Step 1: Add failing component tests**

覆盖：

- running run 显示执行器、来源、运行时长和事件；
- `command_started` 显示 bash/命令；
- `command_output` 显示可折叠输出；
- `file_change` 显示文件路径；
- `error` 显示错误；
- 同一任务多次 run 分组显示；
- 完成、失败和中断状态可区分；
- 收到新的 SSE 事件时只追加对应 run。

Run: `npx vitest run web/src/components/ExecutionEventStream.test.tsx --environment jsdom`
Expected: FAIL because the component does not exist.

- [ ] **Step 2: Implement event stream**

创建可复用的事件渲染组件，按 `createdAt`、`sequence` 排序。当前 run 自动滚动到最新事件；用户向上查看历史时暂停自动滚动。长命令输出默认折叠，事件正文使用真实 `content`，不生成虚假阶段。

- [ ] **Step 3: Wire into `TaskDetail`**

在任务详情当前处理区域增加“执行过程”区域，传入当前任务 ID。详情只加载该任务的 runs；执行期间实时接收事件；完成后保留最近执行历史；原有“立即执行”按钮、threadBinding 对话入口和评论区域不改变。

- [ ] **Step 4: Verify the task**

Run: `npx vitest run web/src/components/ExecutionEventStream.test.tsx web/src/components/MarkdownDocument.test.tsx --environment jsdom && npm run typecheck`
Expected: PASS，组件测试和 TypeScript 检查通过。

Checkpoint: `git add web/src/components/ExecutionEventStream.tsx web/src/components/ExecutionEventStream.test.tsx web/src/components/TaskDetail.tsx web/src/App.tsx web/src/styles.css && git commit -m "feat: show task execution feedback"`

---

### Task 5: 增加顶部右侧全局执行中心抽屉

**Files:**
- Create: `web/src/components/ExecutionCenter.tsx`
- Create: `web/src/components/ExecutionCenter.test.tsx`
- Modify: `web/src/App.tsx:3415-3612`
- Modify: `web/src/styles.css`

**Interfaces:**
- Consumes: `listExecutionRuns()`、`getExecutionRun()`、`listExecutionEvents()`、`subscribeExecutionEvents()`、`openTaskDetail()`。
- Produces: `ExecutionCenter` props：

```ts
type ExecutionCenterProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  language: TaskboardLanguage;
  onOpenTask: (taskId: string) => void;
};
```

- [ ] **Step 1: Add failing component tests**

覆盖：

- 入口位于自动化入口旁；
- running 数量徽标正确显示，零运行时不显示；
- 点击入口打开右侧抽屉；
- 运行中记录固定置顶；
- 最近执行按时间倒序；
- 运行中条目显示项目、任务、Agent 和最新真实反馈摘要；
- 点击条目展开同一抽屉内的完整事件流；
- 点击任务标识调用任务详情导航；
- `Escape` 和关闭按钮关闭抽屉。

Run: `npx vitest run web/src/components/ExecutionCenter.test.tsx --environment jsdom`
Expected: FAIL because the component and header entry do not exist。

- [ ] **Step 2: Implement the header entry**

在 `workspace-header` 的 `.header-actions` 中将执行中心入口紧邻 `ProjectAutomationMenu`。使用现有图标体系；入口拥有按钮和徽标无障碍名称。全局 running count 来自全部 execution runs，不受当前项目筛选影响。

- [ ] **Step 3: Implement the drawer**

抽屉宽度 400～440px，从右侧进入。主列表分为：

```text
运行中
最近执行
```

运行中固定置顶；点击 run 后切换到抽屉内的详细事件流，提供“返回执行列表”。抽屉关闭期间仍保持后台执行和事件持久化；重新打开时重新读取摘要和事件。

- [ ] **Step 4: Wire global refresh and task navigation**

在 `App.tsx` 维护全局 run 摘要、当前展开 run、事件连接状态。收到 `execution.event` 更新对应 run 的最新摘要；收到完成事件刷新任务；SSE 重连按 `sequence` 补齐。关闭抽屉不停止 run。

- [ ] **Step 5: Verify the task**

Run: `npx vitest run web/src/components/ExecutionCenter.test.tsx web/src/components/ExecutionEventStream.test.tsx --environment jsdom && npm run typecheck`
Expected: PASS，任务详情和全局抽屉使用同一事件展示契约。

Checkpoint: `git add web/src/components/ExecutionCenter.tsx web/src/components/ExecutionCenter.test.tsx web/src/App.tsx web/src/styles.css && git commit -m "feat: add global execution center"`

---

### Task 6: 端到端直接路径验证与回归

**Files:**
- Modify: `package.json`（将组件测试命令扩展到新增组件测试）
- Modify: `test/server.test.mjs` 或新增 `test/execution-e2e.test.mjs`
- Modify: `docs/superpowers/specs/2026-09-01-taskboard-agent-execution-observability-design.md`（仅在实现与设计有已确认差异时更新）

**Interfaces:**
- Consumes: 任务详情“立即执行”、`POST /api/local/auto-claim/:projectId/run`、Execution API、SSE、Taskboard 任务状态和评论。
- Produces: 可重复的直接验证记录，覆盖失败、运行中、完成、历史和多项目聚合。

- [ ] **Step 1: Run focused backend and frontend checks**

Run:

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
node --test test/execution-database.test.mjs test/execution-service.test.mjs test/execution-api.test.mjs test/auto-claim.test.mjs
npx vitest run web/src/components/ExecutionEventStream.test.tsx web/src/components/ExecutionCenter.test.tsx web/src/components/MarkdownDocument.test.tsx --environment jsdom
npm run typecheck
```

Expected: 全部新增测试通过，现有自动认领测试和 Markdown 组件测试不回归。

- [ ] **Step 2: Verify missing-workspace path**

将一个项目映射到不存在目录，点击任务详情“立即执行”。Expected：API 返回 `409 WORKSPACE_MISSING`，不会创建 running Execution Run，详情显示明确错误。

- [ ] **Step 3: Verify manual success path**

准备真实存在的隔离工作目录和一个 `todo` 任务，点击“立即执行”。Expected：

```text
执行中心入口显示 1
任务详情实时出现 Agent 文本和 command 事件
Codex CLI 完成 taskctl 认领
任务状态变为 in_review
Execution Run 变为 completed
```

- [ ] **Step 4: Verify global multi-project path**

同时让两个项目各有一个 Taskboard 发起的 run。Expected：顶部执行中心显示数量 2，两个项目都出现在运行中列表；展开任一条目只显示其自身事件；点击任务标识进入对应任务详情。

- [ ] **Step 5: Verify restart/history path**

关闭并重新启动当前 Taskboard 服务后重新打开执行中心。Expected：已完成、失败和中断 run 仍可查询，事件顺序不变；运行中 run 按服务启动恢复策略显示为持久化状态并有明确状态，不丢失已写入事件。

- [ ] **Step 6: Final checks and checkpoint**

Run: `npm run check && git diff --check && git status --short --branch`
Expected: 在 Node 22 环境下通过；只保留本功能提交与原有工作树改动，不生成无关构建残留。

Checkpoint: `git commit -m "feat: add taskboard agent execution observability"`（仅在用户确认工作演示、必要 review 和集成授权后执行）。

## Review and delivery gate

- 这是多个数据层和实时进程边界的中等风险改动。完成直接路径验证并得到用户确认前，不进行额外 Pro review，也不合并或标记 Taskboard issue 为 `done`。
- 每个任务先做聚焦测试，再做相关类型/组件检查；不因为新增功能自动运行桌面打包。
- 实现过程中如果发现当前自动认领分支的未提交改动与本功能冲突，停止扩大范围，先报告冲突文件和最小协调方案。
