# Taskboard Agent 执行可观测性设计

- 日期：2026-09-01
- 状态：已获产品方向确认，待用户审阅文档后进入实施计划
- 范围：当前 Taskboard 应用内由 Taskboard 发起或管理的 Agent 执行

## 1. 背景与目标

当前 Taskboard 的手动“立即执行”和项目自动认领会启动 Codex CLI 或 Claude Code CLI。用户目前只能看到有限的摘要状态：是否运行、最近任务、执行器、最终成功或失败。执行过程中产生的 Agent 文本、bash/命令执行、命令输出、文件变更和错误没有在 Taskboard 中持续展示，因此运行过程对用户来说是黑盒。

本设计的目标是：

1. 在任务详情中实时查看当前任务的真实 Agent 反馈过程。
2. 在当前 Taskboard 顶部右侧增加“执行中心”，以侧边栏形式查看当前应用内所有项目的执行过程。
3. 任务详情和执行中心使用同一份执行记录与事件流，避免两个界面状态不一致。
4. 展示 Agent 实际产生的反馈，不伪造百分比、预计剩余时间或无法从运行时可靠推导的阶段。
5. 同时覆盖手动“立即执行”和定时自动认领，并支持 Codex CLI 与 Claude Code CLI。

不在本期范围内：扫描电脑上未由 Taskboard 发起的外部 Codex/Claude 会话、完整终端仿真、无限量日志保存、日志下载、复杂审计与执行重放。

## 2. 已确认的用户路径

### 2.1 任务详情路径

```text
用户打开任务详情
→ 点击“立即执行”
→ Taskboard 创建一次 Agent Execution Run
→ Codex/Claude CLI 启动并输出事件
→ Taskboard 归一化并保存/推送事件
→ 任务详情实时追加 Agent 反馈、bash、输出、文件变更和错误
→ 执行完成、失败或中断
```

### 2.2 全局执行中心路径

```text
用户点击顶部右侧“执行中心”
→ 右侧抽屉打开
→ 展示当前 Taskboard 所有项目的运行中执行和最近执行
→ 运行中条目显示该执行的最新 Agent 反馈摘要
→ 用户点击某条执行
→ 在抽屉内展开该 Execution Run 的完整实时事件流
→ 用户可进入对应任务详情
```

### 2.3 自动认领路径

```text
自动认领定时器发现可执行任务
→ 创建一次来源为 auto-claim 的 Execution Run
→ 启动选定的 Codex CLI 或 Claude Code CLI
→ 记录同样的结构化事件
→ 任务详情和执行中心实时显示
→ Taskboard 根据任务真实状态确认认领结果
```

## 3. 统一数据模型

### 3.1 Execution Run

一个 `Execution Run` 表示一次完整的 Agent 执行轮次。建议字段：

```text
id                  执行记录 ID
projectId           Taskboard 项目 ID
taskId              任务 ID
taskIdentifier      任务标识，例如 VER-14
source              manual | auto-claim
agent               codex | claude-code
threadId            本轮 Agent 会话 ID，可为空直到运行时返回
status              queued | running | completed | failed | interrupted
startedAt           启动时间
finishedAt          结束时间，可为空
lastEventAt         最近事件时间
lastEventSummary    最近事件摘要，供全局列表快速展示
error               最终错误，可为空
```

`Execution Run` 与任务的 `threadBinding` 关系：

- `threadBinding` 表示任务当前负责会话的绑定，执行认领成功后由本轮会话更新。
- `Execution Run` 表示本次执行轮次，即使执行失败、未认领成功或任务被重新执行，也需要保留。
- 任务重新执行时创建新的 `Execution Run`，不覆盖旧的执行历史。

### 3.2 Execution Event

一个 `Execution Event` 表示 Agent 运行过程中的一条可观察事件。建议字段：

```text
id                  事件 ID
runId               所属执行记录
sequence            同一执行内的递增序号
type                事件类型
role                agent | command | tool | system | error
content             可直接展示的文本
command             命令内容，可为空
output              命令输出，可为空
files               文件变更路径，可为空
data                事件类型扩展数据，可为空
createdAt           事件时间
```

第一版事件类型：

```text
agent_message       Agent 文本反馈
command_started     开始执行 bash/命令
command_output      命令输出
command_completed   命令结束
file_change         文件变更
tool_call            工具调用
error               错误
run_completed       执行完成
run_failed          执行失败
run_interrupted     执行中断
```

实现时应统一去掉上述列表中 `tool_call` 前的多余空格，实际类型名保持 `tool_call`。

事件必须保留原始运行时能够提供的事实，不根据单条事件推测百分比或预计剩余时间。

## 4. 后端事件链路

### 4.1 事件来源

当前后台已经从 CLI JSONL 读取并区分 Codex/Claude Code 的运行结果。执行服务需要把读取到的运行时事件转换为统一的 `Execution Event`，而不是只在最后保留 `sessionId`、`outcome` 和 `error`。

归一化规则：

- Codex 的 `agent_message` 转为 `agent_message`。
- Codex 的命令执行事件转为 `command_started`、`command_output`、`command_completed`。
- Codex 的文件变更事件转为 `file_change`。
- Claude Code 的 assistant、tool、result 事件映射到相同的统一类型。
- 运行时错误转为 `error`，最终结果转为 `run_completed`、`run_failed` 或 `run_interrupted`。
- 事件顺序以 Taskboard 收到事件的顺序为准，由 `sequence` 保证同一 run 内稳定排序。

### 4.2 持久化

建议新增独立的执行记录与事件表，而不是直接复用 `ai_chat_events`：

- 自动认领可以使用 Codex CLI 或 Claude Code CLI，不一定创建本地 AI Chat thread。
- 自动认领执行轮次与本地 AI Chat 的生命周期、查询入口和中断语义不同。
- 独立表可以让任务执行历史按任务、项目和全局 run 查询，而不混入用户 AI 对话。

建议查询能力：

```text
GET /api/local/executions?status=running
GET /api/local/executions?projectId=...
GET /api/local/executions?taskId=...
GET /api/local/executions/:runId
GET /api/local/executions/:runId/events
```

第一版只需要支持当前 Taskboard 服务的数据，不需要跨实例查询。

### 4.3 实时推送

沿用当前 Taskboard 的本地实时事件机制，通过 SSE 或现有实时修订通知触发刷新。推荐执行事件使用独立事件名，以便前端在不刷新整个任务列表的情况下追加日志：

```text
execution.created
execution.updated
execution.event
execution.finished
```

实时推送至少包含：

```text
runId
projectId
taskId
sequence
type
content
createdAt
```

前端断线重连后，必须通过 `GET /api/local/executions/:runId/events` 补齐遗漏事件，而不是依赖事件总线永久保存消息。

## 5. 任务详情 UI

任务详情新增“执行过程”区域，放在当前任务的主要处理信息附近。当前执行时显示：

```text
VER-14 · 正在执行
Codex CLI · 手动执行 · 已运行 1 分 12 秒

Agent：我先读取任务描述和全部评论。

$ taskctl issue get VER-14 --json
$ taskctl comment list VER-14 --json

Agent：已读取最新内容，开始认领任务。

$ taskctl issue move VER-14 --status in_progress ...

修改文件：
- src/example.ts
- src/example.test.ts
```

行为要求：

- 当前 run 的事件实时追加。
- Agent 文本、命令、命令输出、文件变更、工具调用和错误使用不同的视觉样式。
- 命令输出默认可折叠，避免长输出淹没任务详情。
- 当前 run 完成后保留最终结果，并显示完成/失败/中断状态。
- 同一任务多次执行按 run 分组，可展开查看每一轮。
- 点击 threadId 或会话入口仍可打开对应的 Codex 对话。
- 任务详情只显示当前任务的 run，不显示其他任务事件。

## 6. 顶部右侧执行中心

### 6.1 入口

执行中心与自动化入口位于顶部右侧同一区域：

```text
[自动化] [执行中心]
```

入口要求：

- 有运行中任务时显示数量徽标，例如 `2`。
- 没有运行中任务时不显示数量徽标。
- 提供可访问名称，例如“执行中心，2 个任务运行中”。
- 不改变当前路由，不关闭当前任务详情。

### 6.2 抽屉布局

点击后从右侧打开抽屉，建议桌面宽度为 400～440px：

```text
┌──────────────────────────────┐
│ 执行中心                  ×   │
├──────────────────────────────┤
│ 运行中 2                      │
│                              │
│ VER-31  修复登录跳转          │
│ 商城前端 · Codex CLI          │
│ 正在执行：npm run typecheck   │
│ 已运行 3 分钟                 │
│                              │
│ PAY-18  支付接口联调          │
│ 支付服务 · Claude Code        │
│ 正在修改文件                 │
│ 已运行 1 分钟                 │
├──────────────────────────────┤
│ 最近执行                      │
│ VER-14  已完成                │
│ WEB-22  执行失败              │
└──────────────────────────────┘
```

列表规则：

- 运行中固定置顶。
- 运行中按 `startedAt` 从早到晚排列。
- 最近执行按开始时间倒序排列。
- 每次执行单独显示，不把同一任务的多轮合并成一条。
- 运行中条目显示 `lastEventSummary`，由最近真实事件生成。
- 最近完成、失败和中断显示最终状态及错误摘要。

### 6.3 展开单次执行

点击执行列表项后，在同一抽屉内展开该 run 的详细事件流：

```text
[返回执行列表]

VER-31 · 修复登录跳转
Codex CLI · 手动执行

Agent 输出时间线
...
```

展开后继续接收实时事件。抽屉关闭期间事件仍然保存；重新打开时从服务端读取并补齐。

## 7. 前端状态与刷新策略

前端维护：

```text
executionRuns        全局执行记录摘要
selectedExecutionId  当前抽屉展开的 run
executionEvents      当前展开 run 的事件列表
executionConnection  SSE 连接状态
```

刷新策略：

1. 打开执行中心时加载运行中与最近执行摘要。
2. 有运行中记录时订阅执行事件流。
3. 收到 `execution.event` 时更新对应 run 的 `lastEventSummary`，并追加到已展开 run。
4. 收到 `execution.finished` 时更新状态并刷新对应任务。
5. SSE 断线时重连并按 `sequence` 补齐事件。
6. 关闭抽屉不停止后台执行，也不删除执行记录。

## 8. 输出与数据边界

第一版应以“可观察、可用、可控”为目标：

- 不显示虚假的百分比进度。
- 不声称能够预测剩余时间。
- 不把 CLI 退出码单独当成任务成功依据；最终结果仍以 Taskboard 任务状态和绑定回读为准。
- 单条 Agent 文本和命令输出需要设置合理上限，超出部分在 UI 中折叠或截断。
- 事件需要保留足够信息支持当前运行查看和最近历史回看，但暂不承诺永久无限保存。
- 不展示不必要的环境变量、token 或内部认证信息。

## 9. 验收标准

### 任务详情

- 点击“立即执行”后，能看到当前 run 的真实 Agent 输出。
- 能看到 bash/命令开始、输出和完成。
- 能看到文件变更和错误。
- 执行完成、失败或中断时有明确最终状态。
- 任务重新执行时，上一轮和本轮记录可以区分。

### 全局执行中心

- 顶部右侧存在执行中心入口。
- 入口显示运行中任务数量。
- 侧边栏优先显示所有运行中任务。
- 每个运行中任务显示项目、任务、执行器和最新反馈摘要。
- 点击条目可以展开完整事件流。
- 同一 Taskboard 内其他项目的执行也能看到。
- 点击任务标识可以进入任务详情。
- 关闭后重新打开，运行过程和历史事件不丢失。

### 可靠性

- 手动执行与定时自动认领使用同一套事件模型。
- Codex CLI 与 Claude Code CLI 使用同一套前端展示契约。
- 服务重启后，已完成执行的记录仍可查看。
- SSE 断线重连后不会重复或遗漏已持久化事件。
- 不影响现有任务状态、threadBinding 和历史评论语义。

## 10. 实施顺序建议

在本设计获得用户审阅后，按以下顺序进入实施计划：

1. 定义数据库迁移与 Execution Run/Event 领域类型。
2. 将 auto-claim 的 Codex/Claude 事件归一化并持久化。
3. 添加执行记录查询接口与实时事件推送。
4. 在任务详情接入当前任务的执行流。
5. 添加顶部右侧执行中心入口和右侧抽屉。
6. 接入全局列表、展开详情、任务跳转和断线补齐。
7. 按验收标准验证手动执行、自动认领、失败和多项目显示。
