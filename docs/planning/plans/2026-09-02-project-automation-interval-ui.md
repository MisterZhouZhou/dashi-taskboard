# 项目自动认领间隔 UI 实施计划

**Goal:** 将自定义自动认领分钟数改为整齐的单行两端布局，并移除重复的上一轮执行结果提示。

**Architecture:** 继续使用 `ProjectAutomationMenu` 现有的草稿状态、`submitChange` 和 `onChange` 数据链路；仅调整自定义间隔的 DOM/CSS 呈现，不改变 `intervalMinutes` 契约、校验或持久化。删除 `lastIssue`/`lastOutcome` 展示分支，保留联网限制和不可用原因提示。

**Tech Stack:** React + TypeScript、现有 CSS、Vite 类型检查与 Web 构建。

## Global Constraints

- 所有回复使用中文。
- 只修改已批准范围内的 `web/src/components/ProjectAutomationMenu.tsx` 与 `web/src/styles.css`；设计文档和本计划属于规划产物。
- 不新增测试用例，不执行测试驱动；只做直接操作路径验证和现有类型/构建检查。
- 保留现有整数校验、`1～1440` 范围、失焦/Enter 提交行为及必要状态说明。

---

### Task 1: 重排自定义分钟数控件

**Files:**
- Modify: `web/src/components/ProjectAutomationMenu.tsx:410-435`
- Modify: `web/src/styles.css:12199-12247`
- Test: 不新增测试文件

**Interfaces:**
- Consumes: `customInterval`, `customIntervalError`, `commitCustomInterval`
- Produces: 现有 `submitChange({ ...draft, intervalMinutes })` 调用保持不变

- [ ] **Step 1: 调整组件结构**
  将自定义容器改为 `project-automation-field project-automation-custom-interval`，左侧保留“自定义分钟数”标签，右侧新增控件组包裹数字输入框和单位；错误提示作为该字段下方的独立块保留。
- [ ] **Step 2: 调整布局样式**
  让字段采用 `justify-content: space-between` 与现有设置行一致；控件组使用 `display: inline-flex`、垂直居中和固定间距；输入框保留可用宽度、右对齐数字和现有焦点样式。
- [ ] **Step 3: 检查窄宽度表现**
  确保标签不挤压右侧控件，错误提示可换行且不改变提交行为。

### Task 2: 移除重复的上一轮执行结果提示

**Files:**
- Modify: `web/src/components/ProjectAutomationMenu.tsx:567-589`
- Test: 不新增测试文件

**Interfaces:**
- Consumes: `autoClaim.lastIssue`, `autoClaim.lastAgent`, `autoClaim.lastOutcome`, `autoClaim.lastError`（仅移除视图消费）
- Produces: 保留 `unavailableReason` 与 `error` 的现有提示渲染

- [ ] **Step 1: 删除上一轮结果 JSX 分支**
  移除 `!native && autoClaim?.lastIssue` 对应的 `<p className="project-automation-note">` 及其状态文案计算，不改自动认领状态数据。
- [ ] **Step 2: 保留必要提示**
  确认联网限制说明、`unavailableReason` 和错误提示仍按现有条件渲染。

### Task 3: 直接路径验证

**Files:**
- Verify: `web/src/components/ProjectAutomationMenu.tsx`
- Verify: `web/src/styles.css`

**Interfaces:**
- Consumes: 本地 Taskboard 运行时的项目自动认领设置入口
- Produces: 自定义分钟数布局、保存后的值和必要提示的可观察结果

- [ ] **Step 1: 静态检查**
  Run: `npm run typecheck`
  Expected: TypeScript 检查成功。
- [ ] **Step 2: 构建检查**
  Run: `npm run build:web`
  Expected: Web 构建成功，仅允许出现已有的 chunk 体积警告。
- [ ] **Step 3: 格式检查**
  Run: `git diff --check`
  Expected: 无空白错误。
- [ ] **Step 4: 真实 UI 路径**
  在运行中的 Taskboard 打开项目自动化菜单，选择“自定义”，验证标签与输入控件同一行两端对齐；输入有效整数并失焦，确认保存值刷新；确认上一轮执行结果不再展示，必要状态说明仍按条件出现。

## Checkpoint

完成上述修改和验证后，汇报变更文件、验证结果与任何环境限制；不提交或合并代码，除非用户另行要求。

