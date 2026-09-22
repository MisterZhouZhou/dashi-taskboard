import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getResourceCalendar } from "../api";
import type { ResourceCalendarIssue, ResourceCalendarMonth } from "../types";
import { useTaskboardI18n } from "../i18n";
import { LinearIcon } from "./LinearIcon";

const MONTH_RANGE_YEARS = 10;
// 色相二分旋转序列：相邻序号的色相差 180°/90°/45°…，
// 需求按顺序取色时彼此反差最大化；亮度/饱和度保证明暗底都清晰。
const COLOR_HUES = [0, 180, 90, 270, 45, 225, 135, 315, 20, 200, 110, 290];

function paletteColor(index: number): string {
  return `hsl(${COLOR_HUES[index % COLOR_HUES.length]} 78% 58%)`;
}

function formatMonthOption(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

function currentMonthValue(): string {
  const now = new Date();
  return formatMonthOption(now.getFullYear(), now.getMonth() + 1);
}

interface ResourceCalendarViewProps {
  me: string | null;
  jiraBaseUrl: string | null;
  onBack: () => void;
  onError: (message: string | null) => void;
}

export function ResourceCalendarView({ me, jiraBaseUrl, onBack }: ResourceCalendarViewProps) {
  const { locale, text } = useTaskboardI18n();
  const [month, setMonth] = useState(currentMonthValue);
  const [calendar, setCalendar] = useState<ResourceCalendarMonth | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[] | null>(null);
  const [detail, setDetail] = useState<{
    member: string;
    iso: string;
    items: ResourceCalendarIssue[];
    anchor: DOMRect;
  } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const monthOptions = useMemo(() => {
    const now = new Date();
    const options: string[] = [];
    for (let offset = -MONTH_RANGE_YEARS * 12; offset <= MONTH_RANGE_YEARS * 12; offset += 1) {
      const date = new Date(now.getFullYear(), now.getMonth() + offset, 1);
      options.push(formatMonthOption(date.getFullYear(), date.getMonth() + 1));
    }
    return options.reverse();
  }, []);

  const todayIso = useMemo(() => {
    const now = new Date();
    return formatMonthOption(now.getFullYear(), now.getMonth() + 1) === month
      ? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
      : null;
  }, [month]);

  const allMembers = useMemo(() => (
    calendar?.rows.map((row) => row.member) ?? []
  ), [calendar]);

  /** 本月需求 → 颜色索引：按 key 排序顺序分配，反差最大化。 */
  const groupColorIndex = useMemo(() => {
    const groups = new Set<string>();
    for (const row of calendar?.rows ?? []) {
      for (const cell of row.cells) {
        for (const issue of cell.items) groups.add(issue.parentKey ?? issue.key);
      }
    }
    const map = new Map<string, number>();
    [...groups].sort().forEach((group, index) => map.set(group, index));
    return map;
  }, [calendar]);

  const issueColor = useCallback((issue: ResourceCalendarIssue): string => (
    paletteColor(groupColorIndex.get(issue.parentKey ?? issue.key) ?? 0)
  ), [groupColorIndex]);
  // 默认只选中自己，避免首次全量拉取过慢。
  const visibleMembers = selected ?? (me ? [me] : []);

  const load = useCallback((targetMonth: string, members: string[]) => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void getResourceCalendar(targetMonth, members, controller.signal).then(
      (data) => {
        setCalendar(data);
        setLoading(false);
      },
      (failure) => {
        if ((failure as Error).name === "AbortError") return;
        setError(failure instanceof Error ? failure.message : String(failure));
        setLoading(false);
      },
    );
  }, []);

  useEffect(() => {
    load(month, visibleMembers);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, visibleMembers.join(",")]);

  const membersRef = useRef<HTMLDetailsElement>(null);
  const monthComboRef = useRef<HTMLDivElement>(null);
  const [monthOpen, setMonthOpen] = useState(false);
  const [monthPanelYear, setMonthPanelYear] = useState(() => Number(currentMonthValue().slice(0, 4)));

  // 点击面板外部时收起成员筛选。
  useEffect(() => {
    const element = membersRef.current;
    if (!element) return;
    const close = (event: PointerEvent) => {
      if (element.open && !element.contains(event.target as Node)) element.open = false;
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  // 月份下拉：点击外部收起。
  useEffect(() => {
    if (!monthOpen) return;
    const close = (event: PointerEvent) => {
      if (monthComboRef.current && !monthComboRef.current.contains(event.target as Node)) {
        setMonthOpen(false);
      }
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [monthOpen]);

  const hoverTimerRef = useRef<number | null>(null);
  const hoverOpenRef = useRef(false);

  useEffect(() => {
    if (!detail) return;
    const close = () => {
      hoverOpenRef.current = false;
      setDetail(null);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [detail]);

  useEffect(() => () => {
    if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current);
  }, []);

  /** 悬浮 300ms 打开该方块任务浮层，移出即关（点击打开的不受影响）。 */
  const bindCellEvents = (
    issue: ResourceCalendarIssue,
    row: { member: string },
    dayIndex: number,
  ) => ({
    onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      if (hoverTimerRef.current !== null) {
        window.clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = null;
      }
      const anchor = event.currentTarget.getBoundingClientRect();
      hoverOpenRef.current = false;
      setDetail((current) => (
        current?.iso === calendar?.days[dayIndex].iso && current?.member === row.member
          ? null
          : { member: row.member, iso: calendar!.days[dayIndex].iso, items: [issue], anchor }
      ));
    },
    onMouseEnter: (event: React.MouseEvent<HTMLButtonElement>) => {
      const target = event.currentTarget;
      hoverTimerRef.current = window.setTimeout(() => {
        const anchor = target.getBoundingClientRect();
        hoverOpenRef.current = true;
        setDetail((current) => (
          current?.iso === calendar?.days[dayIndex].iso && current?.member === row.member
            ? current
            : { member: row.member, iso: calendar!.days[dayIndex].iso, items: [issue], anchor }
        ));
      }, 300);
    },
    onMouseLeave: () => {
      if (hoverTimerRef.current !== null) {
        window.clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = null;
      }
      if (hoverOpenRef.current) {
        hoverOpenRef.current = false;
        setDetail(null);
      }
    },
  });

  const visibleRows = useMemo(() => (
    calendar?.rows.filter((row) => visibleMembers.includes(row.member)) ?? []
  ), [calendar, visibleMembers]);

  const weekdayLabel = locale.startsWith("zh") ? "日一二三四五六".split("") : ["S", "M", "T", "W", "T", "F", "S"];

  return (
    <div className="resource-calendar" ref={containerRef}>
      <header className="resource-calendar-header">
        <button className="button secondary" type="button" onClick={onBack}>
          {text("返回看板", "Back to board")}
        </button>
        <h2>{text("资源日历", "Resource calendar")}</h2>
        <div className="resource-calendar-month" ref={monthComboRef}>
          <button
            type="button"
            className="resource-calendar-month-trigger"
            aria-haspopup="listbox"
            aria-expanded={monthOpen}
            aria-label={text("选择月份", "Select month")}
            onClick={() => {
              setMonthPanelYear(Number(month.slice(0, 4)));
              setMonthOpen((open) => !open);
            }}
          >
            <span className="resource-calendar-month-fl">{text("月份", "Month")}</span>
            <span>{month}</span>
            <LinearIcon name="chevronDown" />
          </button>
          {monthOpen && (
            <div className="resource-calendar-month-panel" onPointerDown={(event) => event.stopPropagation()}>
              <div className="resource-calendar-month-panel-hd">
                <button type="button" aria-label={text("上一年", "Previous year")} onClick={() => setMonthPanelYear((year) => year - 1)}>‹</button>
                <span>{monthPanelYear}</span>
                <button type="button" aria-label={text("下一年", "Next year")} onClick={() => setMonthPanelYear((year) => year + 1)}>›</button>
              </div>
              <div className="resource-calendar-month-grid">
                {Array.from({ length: 12 }, (_, index) => {
                  const option = `${monthPanelYear}-${String(index + 1).padStart(2, "0")}`;
                  const inRange = monthOptions.includes(option);
                  return (
                    <button
                      key={option}
                      type="button"
                      disabled={!inRange}
                      className={`resource-calendar-month-cell${option === month ? " is-on" : ""}`}
                      onClick={() => {
                        setMonth(option);
                        setMonthOpen(false);
                      }}
                    >
                      {text(`${index + 1}月`, `${index + 1}`)}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
        <button
          className="button secondary"
          type="button"
          disabled={loading}
          onClick={() => load(month, visibleMembers)}
        >
          {loading ? text("加载中…", "Loading…") : text("刷新", "Refresh")}
        </button>
        <details className="resource-calendar-members" ref={membersRef}>
          <summary>{text("成员", "Members")}{` ${visibleMembers.length}/${allMembers.length || "…"}`}</summary>
          <div className="resource-calendar-members-panel">
            {allMembers.map((member) => (
              <label key={member}>
                <input
                  type="checkbox"
                  checked={visibleMembers.includes(member)}
                  onChange={(event) => {
                    setSelected((current) => {
                      const base = current ?? (me ? [me] : []);
                      const next = event.target.checked
                        ? [...new Set([...base, member])]
                        : base.filter((name) => name !== member);
                      return next;
                    });
                  }}
                />
                <span>{member}{member === me ? " ·我" : ""}</span>
              </label>
            ))}
          </div>
        </details>
      </header>
      {error && <p className="project-automation-error" role="alert">{error}</p>}
      {calendar && (
        <div className="resource-calendar-scroll">
          <table className="resource-calendar-table">
            <thead>
              <tr>
                <th className="sticky-dept">{text("部门", "Dept")}</th>
                <th className="sticky-member">{text("成员", "Member")}</th>
                {calendar.days.map((day) => (
                  <th
                    key={day.iso}
                    className={`${day.nonWorkday ? "is-nonworkday" : ""} ${day.iso === todayIso ? "is-today" : ""}`}
                    title={day.iso}
                  >
                    <span>{day.day}</span>
                    <small>{weekdayLabel[day.weekday]}</small>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => (
                <tr key={row.member}>
                  <td className="sticky-dept">{row.dept}</td>
                  <td className="sticky-member">{row.member}{row.member === me ? " ·我" : ""}</td>
                  {row.cells.map((cell, dayIndex) => (
                    <td
                      key={dayIndex}
                      className={`${cell.nonWorkday ? "is-nonworkday" : ""} ${calendar.days[dayIndex].iso === todayIso ? "is-today" : ""}`}
                    >
                      {cell.items.length === 1 ? (
                        <button
                          type="button"
                          className="resource-calendar-block"
                          style={{ background: issueColor(cell.items[0]) }}
                          data-done={cell.items[0].done ? "true" : undefined}
                          {...bindCellEvents(cell.items[0], row, dayIndex)}
                        >
                          <span className="sr-only">{cell.items[0].key}</span>
                        </button>
                      ) : cell.items.length > 1 ? (
                        <span className="resource-calendar-blocks">
                          {cell.items.map((issue) => (
                            <button
                              key={issue.key}
                              type="button"
                              className="resource-calendar-block"
                              style={{ background: issueColor(issue) }}
                              data-done={issue.done ? "true" : undefined}
                              {...bindCellEvents(issue, row, dayIndex)}
                            >
                              <span className="sr-only">{issue.key}</span>
                            </button>
                          ))}
                        </span>
                      ) : null}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {detail && (() => {
        const container = containerRef.current;
        const containerRect = container?.getBoundingClientRect();
        const containerHeight = container?.clientHeight ?? 600;
        const estimate = 64 + detail.items.length * 52;
        const belowTop = detail.anchor.bottom - (containerRect?.top ?? 0) + 6;
        const top = belowTop + estimate > containerHeight
          ? Math.max(8, detail.anchor.top - (containerRect?.top ?? 0) - estimate - 6)
          : belowTop;
        return (
          <div
            className="resource-calendar-detail"
            style={{
              left: Math.max(8, Math.min(
                detail.anchor.left - (containerRect?.left ?? 0),
                Math.max(8, (container?.clientWidth ?? 400) - 336),
              )),
              top,
            }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <header>
              <strong>{`${detail.member} · ${detail.iso}`}</strong>
              <button type="button" onClick={() => setDetail(null)} aria-label={text("关闭", "Close")}>×</button>
            </header>
            <div className="resource-calendar-detail-list">
              {detail.items.map((issue) => (
                <div key={issue.key} className="resource-calendar-detail-item">
                  <span
                    className="resource-calendar-dot"
                    style={{ background: issueColor(issue), opacity: issue.done ? 0.4 : 1 }}
                  />
                  <div className="resource-calendar-detail-body">
                    <div className="resource-calendar-detail-main">
                      <strong>{issue.key}</strong>
                      <span>{issue.summary}</span>
                      {issue.done && <em>{text("已完成", "done")}</em>}
                      {jiraBaseUrl && (
                        <a
                          href={`${jiraBaseUrl}/browse/${encodeURIComponent(issue.key)}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Jira
                        </a>
                      )}
                    </div>
                    {issue.parentSummary && (
                      <div className="resource-calendar-detail-parent">
                        <span className="resource-calendar-detail-parent-label">{text("父任务：", "Parent: ")}</span>
                        <span title={issue.parentKey}>{issue.parentSummary}</span>
                        {jiraBaseUrl && issue.parentKey !== issue.key && (
                          <a
                            href={`${jiraBaseUrl}/browse/${encodeURIComponent(issue.parentKey)}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Jira
                          </a>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
