# 多 agent 自动认领：剩余开发计划

分支 `feat/multi-agent-auto-claim`。功能主体（agent 归属、调度器、runtime、UI）已实现并跑通真实链路，
本文只记录剩余项与已被否决的项，完成后即可删除。

## 剩余项

- [x] **1. Codex 沙箱网络放开改为显式选项**

  `server/agent-runtime.mjs` 原先在 Codex + `workspace-write` 下无条件加了
  `-c sandbox_workspace_write.network_access=true`。这是为了让无人值守的 turn 能通过回环调用
  taskctl 认领与回写，但 Codex 0.149.0 的 `SandboxWorkspaceWrite` 结构只有
  `writable_roots` / `network_access` / `exclude_tmpdir_env_var` / `exclude_slash_tmp`
  四个字段，没有域名白名单或回环专用开关（二进制里的 `allowed_domains` 属于受管策略侧，
  与 `managed_allowed_domains_only` 同族，不是 sandbox 网络策略）。

  既然无法收窄，就改为显式、可关、有说明的配置项 —— 但**默认仍为开**：Codex 的
  workspace-write 沙箱连回环一起挡，默认关掉等于让 Codex CLI 自动认领彻底不可用。

  落地：`project_auto_claim.network_access`（默认 1，含既有库的 ALTER 迁移）、
  `parseAutoClaimSettings` 布尔校验、`buildAgentTurnArgs({ networkAccess })`、
  以及仅在执行器为 Codex CLI 时出现的「允许联网」开关与关闭后的说明文案。

  实测：`networkAccess=false` 时 Codex 拿到
  `SERVICE_UNAVAILABLE: Cannot reach taskboard service / fetch failed`；
  `true` 时正常返回议题 JSON。UI 文案因此是实测结论而非断言。

- [x] **2. Claude Code 头像**

  查下来主因不是缺资源，而是我引入首字母回退时留下的对比度 bug：`.actor-avatar-agent`
  为「logo 铺满整个盒子」而写（`background: transparent`、`border-radius: 0`），
  而 `.actor-avatar` 又设了 `color: white`，于是回退的首字母是**白字落在透明的浅色底上**，
  几乎看不见。

  修法是加 `actor-avatar-initial` 修饰类并把实心圆补回来，没有伪造任何 logo。
  作用域必须写成 `.actor-avatar-agent.actor-avatar-initial` —— 第一版只写
  `.actor-avatar-initial`，因为和 `.actor-avatar-user` 同特异性且位置更靠后，
  把用户头像的紫色 `#7167bf` 也一起改掉了；`.task-card` 下的那条同理需要提特异性。

  实测三种形态：Codex Agent 仍是 logo + 透明底；Claude Code 是 `#4a6da7` 实心圆白字「C」
  （白字对该底色约 5.2:1，过 AA）；本地用户回到 `#7167bf`。

- [x] **3. 清理验证残留**

  已删除 `/tmp` 下 8 个探针脚本与临时输出，以及两个 scratch 仓库
  （`taskboard-verify-repo`、`taskboard-verify-repo-2`）。`/tmp/tb-server.log` 保留，
  因为开发服务仍在写它。

  **`.data/` 故意保留**：它被 `.gitignore` 忽略、不会进仓库，而且是目前唯一能看到功能
  实际运行的地方（`verify-scratch` 项目 + VER-1..9）。在用户完成 UI 视觉确认之前删掉它
  等于毁掉唯一的演示环境，且不可逆。要清就是一句 `rm -rf .data`。

- [x] **4. 最终全量回归并汇总**

  `typecheck` 通过；`node --test` **321 passed / 5 failed**；组件测试 9/9；web 生产构建通过。

  那 5 个失败在本次改动前就存在，原因是本机 Node 22.16 还不默认剥离 `.ts` 类型
  （`ERR_UNKNOWN_FILE_EXTENSION`），而这些测试直接 import `.ts`。CI 用 `node-version: 22`
  会解析到 22.18+，届时应为绿。已 stash 验证过基线同样失败，与本次无关。

  另外记一笔：`test/ai-chat-runner.test.mjs` 的
  「same-thread turns are locked, different threads run concurrently」偶发失败一次，
  单独重跑 3/3 通过、全量重跑也通过，是并发压力下的时序抖动，非本次引入。

  提交与 PR 等用户确认，不自行提交。

## 已否决

- **`eligibleIssue` 改为按 priority 排序** — 否决。`listTasks` 按 `sort_order` 排，
  而 `sort_order` 是用户在看板上拖拽的结果（`App.tsx` 用前后卡片中点写入，`sortTasks` 按它排，
  `BoardColumn` 直接渲染不再二次排序）。因此当前取的就是「用户拖到列顶的那一个」，
  是比 priority 标签更强的显式意图。改成按 priority 排会让拖拽失效。

- **为 `auto-claim.mjs` / `agent-runtime.mjs` 补测试** — 否决。AGENTS.md 规则 4/5 要求
  功能被用户确认前不主动添加测试与护栏，且「用户确认可用」本身不构成添加测试的授权。
  仅在用户明确要求或出现具体故障场景时补。
