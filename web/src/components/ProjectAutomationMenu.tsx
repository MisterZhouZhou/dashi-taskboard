import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LinearIcon } from "./LinearIcon";
import { ProjectIcon, RecurrenceIcon } from "./SemanticIcons";
import { TaskPropertyPicker } from "./TaskPropertyPicker";
import { TaskboardIcon } from "./TaskboardIcon";
import { useTaskboardI18n } from "../i18n";
import type {
  AiChatModel,
  AutoClaimExecutor,
  AutoClaimSandbox,
  ProjectAutoClaim,
} from "../types";

type AutomationStatus = "ACTIVE" | "PAUSED";
type AutomationQuotaState = "available" | "blocked" | "unknown" | "unavailable";
type IntervalMinutes = 5 | 10 | 15 | 30 | 60;

interface AutomationOptions {
  enabledByUser: boolean;
  quotaAware: boolean;
  intervalMinutes: IntervalMinutes;
  model: string;
  reasoningEffort: string;
}

interface AutomationState extends AutomationOptions {
  status: AutomationStatus;
  quota?: {
    state: AutomationQuotaState;
    checkedAt: number;
    resetsAt?: number;
    reason?: "api-key";
  };
}

/**
 * One flat draft covering both backends. The caller routes it: `codex-native`
 * fields go to the Codex app's cron, the rest to the taskboard server.
 */
export interface AutomationDraft extends AutomationOptions {
  executor: AutoClaimExecutor;
  sandbox: AutoClaimSandbox;
  networkAccess: boolean;
}

interface ProjectAutomationMenuProps {
  automation?: Partial<AutomationState>;
  autoClaim?: ProjectAutoClaim;
  executor: AutoClaimExecutor;
  models: AiChatModel[];
  pending: boolean;
  error: string | null;
  nativeUnavailableReason: string | null;
  serverUnavailableReason: string | null;
  onOpen: () => void;
  onChange: (draft: AutomationDraft) => void;
}

const EFFORT_LABELS: Record<string, readonly [string, string]> = {
  low: ["轻度", "Low"],
  medium: ["中", "Medium"],
  high: ["高", "High"],
  xhigh: ["极高 (xhigh)", "Extra high (xhigh)"],
  max: ["最高", "Maximum"],
  ultra: ["极高 (ultra)", "Ultra"],
};

function automationOptions(
  models: AiChatModel[],
  executor: AutoClaimExecutor,
  automation?: Partial<AutomationState>,
  autoClaim?: ProjectAutoClaim,
): AutomationDraft {
  const model = models.find((candidate) => candidate.slug === automation?.model) ?? models[0];
  const reasoningEffort = model?.supportedReasoningEfforts.includes(automation?.reasoningEffort ?? "")
    ? automation?.reasoningEffort
    : model?.defaultReasoningEffort;
  const native = executor === "codex-native";
  return {
    executor,
    enabledByUser: native
      ? automation?.enabledByUser ?? false
      : autoClaim?.enabled ?? false,
    quotaAware: automation?.quotaAware ?? false,
    intervalMinutes: (native
      ? automation?.intervalMinutes
      : autoClaim?.intervalMinutes) as IntervalMinutes ?? 5,
    model: model?.slug ?? "",
    reasoningEffort: reasoningEffort ?? "",
    sandbox: autoClaim?.sandbox ?? "workspace-write",
    networkAccess: autoClaim?.networkAccess ?? true,
  };
}

const EXECUTOR_LABELS: Record<AutoClaimExecutor, readonly [string, string]> = {
  "codex-native": ["Codex 原生会话", "Codex native session"],
  codex: ["Codex CLI", "Codex CLI"],
  "claude-code": ["Claude Code CLI", "Claude Code CLI"],
};

/** Short form for the trigger and the last-run line, where the row label is absent. */
const AGENT_SHORT_LABELS: Record<string, readonly [string, string]> = {
  codex: ["Codex", "Codex"],
  "claude-code": ["Claude Code", "Claude Code"],
};

const SANDBOX_LABELS: Record<AutoClaimSandbox, readonly [string, string]> = {
  "read-only": ["只读（不改文件）", "Read-only"],
  "workspace-write": ["可改工作目录", "Workspace write"],
};

export function ProjectAutomationMenu({
  automation,
  autoClaim,
  executor,
  models,
  pending,
  error,
  nativeUnavailableReason,
  serverUnavailableReason,
  onOpen,
  onChange,
}: ProjectAutomationMenuProps) {
  const { locale, text } = useTaskboardI18n();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const wasPendingRef = useRef(pending);
  const [open, setOpen] = useState(false);
  const [pickerMenu, setPickerMenu] = useState<
    "executor" | "interval" | "model" | "reasoning" | "sandbox" | null
  >(null);
  const [position, setPosition] = useState({ left: 0, top: 0, ready: false });
  const [draft, setDraft] = useState<AutomationDraft>(
    () => automationOptions(models, executor, automation, autoClaim),
  );
  const native = draft.executor === "codex-native";
  const unavailableReason = native ? nativeUnavailableReason : serverUnavailableReason;
  const quota = automation?.quota;
  const nativeStatus = automation?.status ?? "PAUSED";
  const stateLabel = native
    ? !automation?.enabledByUser
      ? text("已暂停", "Paused")
      : automation.quotaAware && quota?.state === "blocked"
        ? text("额度暂停", "Paused by quota")
        : automation.quotaAware && quota?.state === "unavailable"
          ? text("额度不可用", "Quota unavailable")
          : automation.quotaAware && (!quota || quota.state === "unknown")
            ? text("额度未知", "Quota unknown")
            : nativeStatus === "ACTIVE"
              ? text("运行中", "Running")
              : text("已暂停", "Paused")
    : autoClaim?.running
      ? text("正在执行", "Working")
      : draft.enabledByUser
        ? text("等待下一轮", "Waiting")
        : text("已暂停", "Paused");
  const running = native ? nativeStatus === "ACTIVE" : Boolean(autoClaim?.running);
  const selectedModel = models.find((model) => model.slug === draft.model) ?? models[0];
  const disabled = pending
    || Boolean(unavailableReason)
    || (native && !selectedModel);

  useEffect(() => {
    if (!open) return;
    setDraft(automationOptions(models, executor, automation, autoClaim));
  }, [autoClaim, automation, executor, models, open]);

  useEffect(() => {
    if (!open) setPickerMenu(null);
  }, [open]);

  useEffect(() => {
    if (wasPendingRef.current && !pending) {
      setDraft(automationOptions(models, executor, automation, autoClaim));
    }
    wasPendingRef.current = pending;
  }, [autoClaim, automation, executor, pending]);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) return;
    const trigger = triggerRef.current.getBoundingClientRect();
    const menu = menuRef.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(trigger.right - menu.width, window.innerWidth - menu.width - 8));
    const top = trigger.bottom + 8 + menu.height <= window.innerHeight
      ? trigger.bottom + 8
      : Math.max(8, trigger.top - menu.height - 8);
    setPosition({ left, top, ready: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function closeFromOutside(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function closeFromViewportChange() {
      setOpen(false);
    }
    function closeFromEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && !pickerMenu) {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromEscape);
    window.addEventListener("resize", closeFromViewportChange);
    window.addEventListener("scroll", closeFromViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromEscape);
      window.removeEventListener("resize", closeFromViewportChange);
      window.removeEventListener("scroll", closeFromViewportChange, true);
    };
  }, [open, pickerMenu]);

  const submitChange = (next: AutomationDraft) => {
    if (pending) return;
    setDraft(next);
    onChange(next);
  };

  const menu = open ? createPortal(
    <div
      ref={menuRef}
      className="project-automation-menu no-drag"
      role="dialog"
      aria-label={text("自动认领待办设置", "Auto-claim settings")}
      style={{ left: position.left, top: position.top, visibility: position.ready ? "visible" : "hidden" }}
    >
      <div className="project-automation-menu-heading">
        <strong>{text("自动认领待办", "Auto-claim tasks")}</strong>
        <span className={running ? "is-active" : "is-paused"}>
          {stateLabel}
        </span>
      </div>
      <div className="project-automation-field">
        <span>{text("执行器", "Executor")}</span>
        <TaskPropertyPicker
          value={draft.executor}
          options={(["codex-native", "codex", "claude-code"] as AutoClaimExecutor[]).map((value) => ({
            value,
            label: text(...EXECUTOR_LABELS[value]),
            icon: <ProjectIcon color="currentColor" size={14} />,
          }))}
          open={pickerMenu === "executor"}
          disabled={pending}
          className="project-automation-picker"
          triggerClassName="project-automation-picker-trigger"
          ariaLabel={text("执行器", "Executor")}
          onOpenChange={(open) => setPickerMenu(open ? "executor" : null)}
          onChange={(value) => submitChange({
            ...draft,
            executor: value as AutoClaimExecutor,
          })}
        />
      </div>
      <div className="project-automation-switch">
        <span>{text("自动认领开关", "Auto-claim")}</span>
        <button
          type="button"
          className={`board-setting-switch${draft.enabledByUser ? " is-on" : ""}`}
          role="switch"
          aria-checked={draft.enabledByUser}
          disabled={disabled}
          onClick={() => submitChange({
            ...draft,
            enabledByUser: !draft.enabledByUser,
          })}
        >
          <span aria-hidden="true" />
        </button>
      </div>
      {native && (
      <div className="project-automation-switch">
        <span>{text("根据额度启用/关闭", "Use quota limits")}</span>
        <button
          type="button"
          className={`board-setting-switch${draft.quotaAware ? " is-on" : ""}`}
          role="switch"
          aria-checked={draft.quotaAware}
          disabled={disabled}
          onClick={() => submitChange({
            ...draft,
            quotaAware: !draft.quotaAware,
          })}
        >
          <span aria-hidden="true" />
        </button>
      </div>
      )}
      {native && draft.quotaAware && (
        <div className={`project-automation-quota is-${quota?.state ?? "unknown"}`}>
          {quota?.state === "available" && text("当前额度可用", "Quota is available")}
          {quota?.state === "blocked" && (
            quota.resetsAt
              ? text(
                `额度已用尽，预计 ${formatResetTime(quota.resetsAt, locale)} 恢复`,
                `Quota is exhausted. Expected reset: ${formatResetTime(quota.resetsAt, locale)}.`,
              )
              : text("额度已用尽，自动认领已暂停", "Quota is exhausted. Auto-claim is paused.")
          )}
          {quota?.state === "unavailable" && (
            quota.reason === "api-key"
              ? text(
                "API Key 模式不支持读取 Codex App 额度",
                "API key mode cannot read the Codex app quota.",
              )
              : text("当前账户无法读取额度", "This account cannot read quota information.")
          )}
          {(!quota || quota.state === "unknown") && text(
            "额度状态未知，自动认领已暂停",
            "Quota status is unknown. Auto-claim is paused.",
          )}
        </div>
      )}
      <div className="project-automation-field">
        <span>{text("间隔", "Interval")}</span>
        <TaskPropertyPicker
          value={String(draft.intervalMinutes)}
          options={[5, 10, 15, 30, 60].map((minutes) => ({
            value: String(minutes),
            label: text(`${minutes} 分钟`, `${minutes} min`),
            icon: <RecurrenceIcon color="currentColor" size={14} />,
          }))}
          open={pickerMenu === "interval"}
          disabled={disabled}
          className="project-automation-picker"
          triggerClassName="project-automation-picker-trigger"
          ariaLabel={text("间隔", "Interval")}
          onOpenChange={(open) => setPickerMenu(open ? "interval" : null)}
          onChange={(value) => submitChange({
            ...draft,
            intervalMinutes: Number(value) as IntervalMinutes,
          })}
        />
      </div>
      {!native && (
        <div className="project-automation-field">
          <span>{text("权限", "Permission")}</span>
          <TaskPropertyPicker
            value={draft.sandbox}
            options={(["workspace-write", "read-only"] as AutoClaimSandbox[]).map((value) => ({
              value,
              label: text(...SANDBOX_LABELS[value]),
              icon: <LinearIcon name="displayOptions" />,
            }))}
            open={pickerMenu === "sandbox"}
            disabled={pending}
            className="project-automation-picker"
            triggerClassName="project-automation-picker-trigger"
            ariaLabel={text("权限", "Permission")}
            onOpenChange={(open) => setPickerMenu(open ? "sandbox" : null)}
            onChange={(value) => submitChange({
              ...draft,
              sandbox: value as AutoClaimSandbox,
            })}
          />
        </div>
      )}
      {draft.executor === "codex" && (
        <div className="project-automation-switch">
          <span>{text("允许联网", "Allow network")}</span>
          <button
            type="button"
            className={`board-setting-switch${draft.networkAccess ? " is-on" : ""}`}
            role="switch"
            aria-checked={draft.networkAccess}
            disabled={disabled}
            onClick={() => submitChange({
              ...draft,
              networkAccess: !draft.networkAccess,
            })}
          >
            <span aria-hidden="true" />
          </button>
        </div>
      )}
      {draft.executor === "codex" && !draft.networkAccess && (
        <p className="project-automation-note">
          {text(
            "关闭后 Codex 沙箱会连回环也一起挡掉，它将无法认领议题。Codex 没有仅回环选项，开启即为一般联网。",
            "With this off, the Codex sandbox also blocks loopback, so it cannot claim issues. Codex has no loopback-only option, so on means general network access.",
          )}
        </p>
      )}
      {native && selectedModel && (
        <>
          <div className="project-automation-field">
            <span>{text("模型", "Model")}</span>
            <TaskPropertyPicker
              value={draft.model}
              options={models.map((model) => ({
                value: model.slug,
                label: model.displayName,
                icon: <ProjectIcon color="currentColor" size={14} />,
              }))}
              open={pickerMenu === "model"}
              disabled={disabled}
              className="project-automation-picker"
              triggerClassName="project-automation-picker-trigger"
              ariaLabel={text("模型", "Model")}
              onOpenChange={(open) => setPickerMenu(open ? "model" : null)}
              onChange={(value) => {
                const model = models.find((candidate) => candidate.slug === value);
                if (!model) return;
                submitChange({
                  ...draft,
                  model: value,
                  reasoningEffort: model.supportedReasoningEfforts.includes(draft.reasoningEffort)
                    ? draft.reasoningEffort
                    : model.defaultReasoningEffort,
                });
              }}
            />
          </div>
          <div className="project-automation-field">
            <span>{text("推理强度", "Reasoning effort")}</span>
            <TaskPropertyPicker
              value={draft.reasoningEffort}
              options={selectedModel.supportedReasoningEfforts.map((effort) => ({
                value: effort,
                label: EFFORT_LABELS[effort] ? text(...EFFORT_LABELS[effort]) : effort,
                icon: <LinearIcon name="displayOptions" />,
              }))}
              open={pickerMenu === "reasoning"}
              disabled={disabled}
              className="project-automation-picker"
              triggerClassName="project-automation-picker-trigger"
              ariaLabel={text("推理强度", "Reasoning effort")}
              onOpenChange={(open) => setPickerMenu(open ? "reasoning" : null)}
              onChange={(value) => submitChange({
                ...draft,
                reasoningEffort: value,
              })}
            />
          </div>
        </>
      )}
      {!native && autoClaim?.lastIssue && (
        <p className="project-automation-note">
          {(() => {
            const ran = autoClaim.lastAgent
              ? text(...AGENT_SHORT_LABELS[autoClaim.lastAgent])
              : null;
            const who = ran ? `${ran} ` : "";
            if (autoClaim.lastOutcome === "running") {
              return text(
                `${who}正在处理 ${autoClaim.lastIssue}`,
                `${who}is working on ${autoClaim.lastIssue}`,
              );
            }
            if (autoClaim.lastOutcome === "failed") {
              return text(
                `上一轮 ${who}处理 ${autoClaim.lastIssue} 失败：${autoClaim.lastError ?? ""}`,
                `Last run: ${who}failed on ${autoClaim.lastIssue} — ${autoClaim.lastError ?? ""}`,
              );
            }
            return text(
              `上一轮 ${who}已完成 ${autoClaim.lastIssue}`,
              `Last run: ${who}completed ${autoClaim.lastIssue}`,
            );
          })()}
        </p>
      )}
      {unavailableReason && <p className="project-automation-note">{unavailableReason}</p>}
      {error && error !== unavailableReason && <p className="project-automation-error" role="alert">{error}</p>}
    </div>,
    document.body,
  ) : null;

  // Who is on duty: the agent mid-run when there is one, otherwise the configured
  // default. Without this the board never says which CLI does the work.
  const onDutyAgent = running && autoClaim?.lastAgent
    ? autoClaim.lastAgent
    : executor === "codex-native" ? null : executor;
  const onDuty = onDutyAgent ? text(...AGENT_SHORT_LABELS[onDutyAgent]) : null;
  const triggerLabel = running
    ? text("自动认领中", "Auto-claiming")
    : text("自动化", "Automation");
  const triggerText = onDuty ? `${triggerLabel} · ${onDuty}` : triggerLabel;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`project-automation-trigger no-drag ${running ? "is-active" : "is-paused"}`}
        aria-label={triggerText}
        aria-busy={pending}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={triggerText}
        onClick={() => {
          if (!open) {
            setPosition((current) => ({ ...current, ready: false }));
            onOpen();
          }
          setOpen((current) => !current);
        }}
      >
        <TaskboardIcon name={running ? "automationPause" : "automationPlay"} />
        <span>{triggerText}</span>
      </button>
      {menu}
    </>
  );
}

function formatResetTime(value: number, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value * 1_000));
}
