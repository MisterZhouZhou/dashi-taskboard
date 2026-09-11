# 任务详情父子任务树 Implementation Plan

**Goal:** 在任务详情中以当前任务为根递归展示全部后代任务，并让进入子任务后按详情进入链逐级返回父任务详情。

**Architecture:** 复用前端已加载的 `Task[]`、`Task.relations.subIssues` 和现有关系 mutation，不新增后端接口或数据库字段。在 `IssueRelations.tsx` 内实现递归任务树，在 `TaskDetail.tsx` 用树替换原父任务/子任务平铺区域；在 `App.tsx` 用带详情深度的 history state 保持详情链导航。

**Tech Stack:** React 19、TypeScript、Vite、现有 `Task`/`TaskRelationSummary` 类型、浏览器 History API、Node test、TypeScript 编译检查。

## Global Constraints

- 从当前分支 `feat/multi-agent-auto-claim` 已创建的功能分支 `feat/task-detail-tree` 上实现。
- 保留工作区原有 `package-lock.json` 修改，不修改、不提交该文件。
- 当前任务是树根；树只显示当前任务及可从 `tasks` 解析出的后代，不把父任务作为树节点。
- 保留设置、更换、移除父任务和添加、移除子任务的现有关系操作。
- 不新增后端树 API、数据库迁移、无关重构或 speculative fallback。
- 不使用 superpowers。
- 按项目规则，先完成并直接验证主操作路径；在用户确认功能可用前不主动扩展防御性测试或回归测试范围。

---

### Task 1: 建立任务树数据和递归节点渲染

**Files:**
- Modify: `web/src/components/IssueRelations.tsx:150-430`
- Test/verify: `web/src/components/IssueRelations.tsx` 的 TypeScript 类型检查和后续现有关系检查

**Interfaces:**
- Consumes: `Task`, `TaskRelationSummary`, `RelationActions`, `Task.relations.subIssues`, `onOpenTask`, `onAddRelation`, `onRemoveRelation`
- Produces: `IssueTaskTree(props: RelationActions): JSX.Element`；内部递归节点 `IssueTaskTreeNode`

- [ ] **Step 1: 定义树组件接口和任务索引**

  在 `IssueRelations.tsx` 中保留现有 `RelationActions` 接口，并新增树组件所需的内部节点类型：

  ```ts
  interface IssueTaskTreeNodeProps {
    task: Task;
    rootTaskId: string;
    depth: number;
    taskById: ReadonlyMap<string, Task>;
    expandedIds: ReadonlySet<string>;
    onToggle: (taskId: string) => void;
    onOpenTask: (task: TaskRelationSummary) => void;
    onRemoveChild: (child: Task, parentId: string) => void;
    canEditRelations: boolean;
  }
  ```

  `IssueTaskTree` 使用 `new Map(tasks.map((candidate) => [candidate.id, candidate]))` 建立索引，根节点使用传入的 `task`。

- [ ] **Step 2: 实现递归节点**

  `IssueTaskTreeNode` 对当前节点执行以下逻辑：

  1. 从 `task.relations.subIssues` 读取直接子任务摘要。
  2. 使用 `taskById.get(summary.id)` 解析完整任务；无法解析时跳过该关系项，不生成虚假的任务对象。
  3. 有子任务时显示展开/收起按钮；没有子任务时不显示空占位控制。
  4. 节点主体沿用 `IssueRelationRow` 的状态图标、编号、标题和负责人头像，并调用 `onOpenTask(summary)`。
  5. 展开时递归渲染解析成功的子任务，缩进由 `depth` 映射到 CSS 自定义属性或层级 class。
  6. 子节点右侧沿用移除父子关系操作，调用 `onRemoveRelation(child, "parent", task.id)`。

  节点按钮需要有稳定的 `aria-expanded`、`aria-label`，并确保移除按钮点击不会触发打开详情。

- [ ] **Step 3: 实现根节点的关系操作**

  `IssueTaskTree` 根节点保留当前关系编辑能力：

  - 根节点上方或同一 header 内显示当前父任务的紧凑关系入口，复用现有父任务候选过滤规则和 `IssuePicker`。
  - 根节点显示“添加子议题”入口，候选过滤继续排除当前任务、当前祖先和已有直接子任务。
  - 父任务不进入树节点列表。
  - 保存中状态分别锁定当前父任务操作或对应子任务移除操作，不改变阻塞、被阻塞、相关任务关系。

- [ ] **Step 4: 设置展开状态**

  `IssueTaskTree` 初始将根节点和可解析后代加入 `expandedIds`，满足进入详情即可查看完整树；点击展开/收起只更新组件本地 state，不写入任务数据。

- [ ] **Step 5: 运行类型检查，确认树接口可编译**

  Run: `npm run typecheck`

  Expected: TypeScript 检查通过；若失败，只修复本任务新增的树接口、递归 JSX 或事件类型错误。

---

### Task 2: 用任务树替换详情中的两个平铺区域

**Files:**
- Modify: `web/src/components/TaskDetail.tsx:70-115,1090-1125,1260-1295`
- Modify: `web/src/components/IssueRelations.tsx` 导出项
- Test/verify: `test/issue-relations.test.mjs`（仅在现有断言因组件替换而失败时做最小同步）

**Interfaces:**
- Consumes: `TaskDetailProps.tasks`, `TaskDetailProps.task`, existing relation mutation callbacks
- Produces: `TaskDetail` renders `<IssueTaskTree ... />` in the former parent/sub-issue locations

- [ ] **Step 1: 替换 import 和详情 JSX**

  从 `TaskDetail.tsx` 移除 `IssueParentLink`、`IssueSubIssues` 的 import，改为引入 `IssueTaskTree`。

  删除标题区域中的 `<IssueParentLink ... />` 和正文中的 `<IssueSubIssues ... />`，在原父子关系区域的合适单一位置渲染：

  ```tsx
  <IssueTaskTree
    task={currentTask}
    tasks={tasks}
    onOpenTask={onOpenTask}
    onAddRelation={(anchor, type, relatedTaskId) => applyRelationMutation(
      () => onAddRelation(anchor, type, relatedTaskId),
    )}
    onRemoveRelation={(anchor, type, relatedTaskId) => applyRelationMutation(
      () => onRemoveRelation(anchor, type, relatedTaskId),
    )}
  />
  ```

  `IssueRelationSidebar` 保持原位置和 props，不做改动。

- [ ] **Step 2: 清理不再使用的平铺样式和保留通用样式**

  在 `web/src/styles.css` 中：

  - 新增 `.issue-task-tree`、`.issue-task-tree-node`、层级缩进、展开按钮和根节点操作区域样式。
  - 复用 `.issue-relation-row`、`.issue-relation-target`、`.issue-relation-remove` 的视觉基础。
  - 删除或停止使用仅服务于旧 `.issue-parent-link` / `.issue-sub-issues` 平铺布局的规则；不改动关系侧栏 `.issue-relation-sidebar` 规则。
  - 保持窄屏媒体查询下树节点可横向收缩、标题省略和操作按钮可点击。

- [ ] **Step 3: 同步现有静态关系断言（如需要）**

  Run: `node --test test/issue-relations.test.mjs`

  Expected: 若现有测试只断言旧组件必须存在，则将断言改为检查 `IssueTaskTree`、递归节点、`onOpenTask`、`onAddRelation`、`onRemoveRelation` 和关系侧栏仍存在；不新增与本功能无关的测试矩阵。

- [ ] **Step 4: 运行类型检查**

  Run: `npm run typecheck`

  Expected: `TaskDetail.tsx`、`IssueRelations.tsx`、样式引用无 TypeScript 错误。

---

### Task 3: 实现详情链的逐级返回

**Files:**
- Modify: `web/src/App.tsx:800-830,1615-1665,1685-1718`
- Test/verify: `test/issue-detail-route.test.mjs`

**Interfaces:**
- Consumes: `openTaskDetail(Pick<Task, "identifier" | "projectId">)`, `closeTaskDetail()`, `readIssueIdentifier()`, `buildIssueUrl()`, `popstate`
- Produces: history state field `taskboardDetailDepth: number` and route synchronization that preserves detail depth

- [ ] **Step 1: 为详情 history 定义深度状态约定**

  在 `App.tsx` 中定义内部常量和类型：

  ```ts
  const DETAIL_HISTORY_DEPTH_KEY = "taskboardDetailDepth";
  type DetailHistoryState = HistoryState & { taskboardDetailDepth?: number };
  ```

  初始从 URL 直接打开任务详情时不假设存在父详情，深度按 `0` 处理；只有本次会话由 `openTaskDetail` 创建的详情 URL 才写入深度。

- [ ] **Step 2: 修改 `openTaskDetail` 写入详情深度**

  保留现有项目切换、已读标记、滚动位置和 URL 构造逻辑，只增加 history state：

  1. 从看板打开时，将不含 issue 的 board URL `replaceState` 为深度 `0`。
  2. 从看板打开的详情 URL `pushState` 为深度 `1`。
  3. 在已有详情中打开子任务时，读取当前 history state 深度并加一后 `pushState`。
  4. 将当前深度存入 `detailHistoryDepthRef`，避免异步渲染期间依赖过时 URL。

- [ ] **Step 3: 修改 `closeTaskDetail` 的返回分支**

  使顶部返回按钮按详情层级工作：

  - 当前深度大于 `1`：调用 `window.history.back()`，由 `popstate` 恢复上一任务详情。
  - 当前深度等于 `1`：清空详情状态并恢复看板 URL，保留现有跨项目恢复行为。
  - 当前 URL 是外部直接打开的详情且没有本次会话深度：沿用现有 `replaceState` 关闭详情，不盲目退出应用历史。

- [ ] **Step 4: 同步 `popstate` 中的深度**

  在 `syncRouteFromLocation()` 读取 `window.history.state?.[DETAIL_HISTORY_DEPTH_KEY]`：

  - 有 issue 时更新 `detailHistoryDepthRef`，再设置 `detailTaskIdentifier`。
  - 无 issue 时将 ref 清零并保持现有看板恢复逻辑。
  - 不改变项目切换、滚动位置恢复和 `selectedProjectId` 行为。

- [ ] **Step 5: 更新路由静态检查**

  在 `test/issue-detail-route.test.mjs` 增加最小 source assertion，检查：

  - `openTaskDetail` 在嵌套详情时使用递增详情深度并 `pushState`。
  - `closeTaskDetail` 在嵌套详情路径调用 `window.history.back()`。
  - `popstate` 仍调用 `syncRouteFromLocation`。

  Run: `node --test test/issue-detail-route.test.mjs`

  Expected: 路由 URL 保持项目和其他 query 参数；现有浏览器历史断言和新增详情深度断言通过。

---

### Task 4: 直接验证任务树和详情返回主路径

**Files:**
- Verify only: `web/src/components/IssueRelations.tsx`, `web/src/components/TaskDetail.tsx`, `web/src/App.tsx`, `web/src/styles.css`

**Interfaces:**
- Consumes: local Taskboard runtime, a project containing a parent task and at least one child task
- Produces: user-visible recursive tree and parent-preserving detail navigation

- [ ] **Step 1: 启动当前分支的本地 Web 运行时**

  Run: `npm run dev:web -- --host 127.0.0.1`

  Expected: Vite 开发服务启动；使用当前 Taskboard 本地运行时打开任务看板，不停止或替换协调器拥有的共享 App runtime。

- [ ] **Step 2: 验证用户报告的主路径**

  操作：

  1. 打开一个有子任务的父任务详情。
  2. 确认当前任务是树根，子任务显示为后代节点。
  3. 点击子任务节点。
  4. 点击顶部返回。

  Expected: 第 4 步回到刚才的父任务详情，而不是直接回到看板。

- [ ] **Step 3: 验证一个成功扩展路径**

  操作：

  1. 在树中确认孙任务递归显示。
  2. 收起并重新展开一个有子任务的节点。
  3. 添加或移除一个子任务关系。

  Expected: 展开状态可用；关系 mutation 成功后树结构刷新；阻塞、被阻塞、相关任务区域仍可见。

- [ ] **Step 4: 运行聚焦静态检查和构建**

  Run: `npm run typecheck && npm run build:web && node --test test/issue-detail-route.test.mjs test/issue-relations.test.mjs`

  Expected: 类型检查、Web 构建和两个关系/路由测试通过。此阶段不运行全平台 Tauri 打包，除非直接验证暴露出平台构建问题。

- [ ] **Step 5: 检查范围和工作区**

  Run: `git diff --check && git status --short --branch`

  Expected: 变更只涉及计划中的功能文件、设计/计划文档及必要的现有断言同步；原有 `package-lock.json` 修改保持不被本功能改写。

---

## Checkpoints

1. `tree-rendered`: 递归树组件可编译，TaskDetail 已切换到单一树区域。
2. `detail-navigation`: 父详情 -> 子详情 -> 返回父详情路径通过。
3. `task-detail-tree-ready`: 直接验证、聚焦检查和范围检查通过，等待用户确认后再进入后续评审或合并流程。

## Self-review

- 当前任务为根、递归后代、子任务点击和逐级返回均有对应任务。
- 父任务不作为树节点，但父任务关系编辑入口仍在根节点关系操作中。
- 阻塞/被阻塞/相关关系未纳入树替换范围。
- 未引入后端接口、数据库迁移或无关兼容层。
- 命令均使用仓库现有 npm scripts 或 Node test 入口。
- 设计文档路径为 `docs/planning/specs/2026-09-11-task-detail-tree-design.md`。
