"use client";

import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";

import { debuggerFlowFromEvents, groupCoverageGaps, mergeDebugEvents, severityTone } from "../lib/workspace-ui";

type DebugEvent = {
  id: string;
  stage: string;
  eventType: string;
  severity: string;
  message: string;
  payloadJson: Record<string, unknown>;
  createdAt: string;
};
type DebugSummary = {
  currentStage: string;
  activeTask: { taskType: string; pageKey: string | null; repositoryRole: string | null } | null;
  taskCounts: Record<string, number>;
  pageKeys: { written: string[]; reused: string[]; affected: string[] };
  coverage: { counts: Record<string, unknown> | null; gaps: Array<{ pageKey: string | null; reason: string | null }> };
  lastError: string | null;
};

export function GenerationDebugger({ generationRunId }: { generationRunId: string }) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<DebugEvent[]>([]);
  const [summary, setSummary] = useState<DebugSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cursorRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    async function poll() {
      try {
        const afterId = cursorRef.current;
        const params = afterId ? `?afterId=${encodeURIComponent(afterId)}` : "?limit=200";
        const response = await fetch(`/api/generation-runs/${generationRunId}/debug-events${params}`, { cache: "no-store" });
        const body = await response.json();
        if (cancelled) return;
        if (!response.ok) throw new Error(body?.error?.message ?? "Debug events unavailable.");
        setEvents((existing) => mergeDebugEvents(existing, body.events ?? []));
        cursorRef.current = body.nextAfterId ?? cursorRef.current;
        setSummary(body.summary);
        setError(null);
      } catch (pollError) {
        if (!cancelled) setError(pollError instanceof Error ? pollError.message : "Debug events unavailable.");
      }
    }

    poll();
    const id = window.setInterval(poll, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [generationRunId, open]);

  const flow = debuggerFlowFromEvents(events);
  const gaps = groupCoverageGaps(summary?.coverage.gaps ?? []);
  const indicator = error ? "error" : open ? "live" : "paused";

  return (
    <div style={debuggerWrapStyle}>
      <button type="button" onClick={() => setOpen((value) => !value)} style={buttonStyle}>
        <span>Generation debugger</span>
        <span style={buttonMetaStyle}>{open ? "collapse" : "expand"}</span>
      </button>
      {open ? (
        <section style={panelStyle} aria-label="Generation debugger">
          <div style={summaryStripStyle}>
            <StatusPill value={indicator} />
            <Metric label="Stage" value={summary?.currentStage ?? "not available yet"} />
            <Metric label="Active task" value={activeTaskLabel(summary)} />
            <Metric label="Queued" value={String(summary?.taskCounts.queued ?? 0)} />
            <Metric label="Written" value={String(summary?.pageKeys.written.length ?? 0)} />
            <Metric label="Reused" value={String(summary?.pageKeys.reused.length ?? 0)} />
            <Metric label="Affected" value={String(summary?.pageKeys.affected.length ?? 0)} />
            <Metric label="Gaps" value={String(summary?.coverage.gaps.length ?? 0)} />
            <Metric label="Last error" value={summary?.lastError ?? error ?? "none"} tone={summary?.lastError || error ? "red" : "neutral"} />
          </div>

          <div style={flowStyle}>
            {flow.map((lane) => (
              <div key={lane.key} style={laneStyle}>
                <span style={laneLabelStyle}>{lane.label}</span>
                <strong style={laneCountStyle}>{lane.count}</strong>
                <span style={laneValueStyle}>{lane.latest}</span>
              </div>
            ))}
          </div>

          <div style={debuggerGridStyle}>
            <div style={timelineStyle}>
              <div style={panelHeaderStyle}>
                <strong>Newest events</strong>
                <span style={mutedStyle}>{events.length}/200 visible</span>
              </div>
              {events.length === 0 ? <p style={emptyStyle}>not available yet</p> : null}
              {events.slice().reverse().map((event) => (
                <div key={event.id} style={eventRowStyle}>
                  <div style={eventTopStyle}>
                    <strong style={eventTypeStyle}>{event.eventType}</strong>
                    <span style={timeStyle}>{new Date(event.createdAt).toLocaleTimeString()}</span>
                  </div>
                  <p style={eventMessageStyle}>{event.message}</p>
                  <div style={eventMetaStyle}>
                    <ToneBadge severity={event.severity} />
                    <span>{event.stage}</span>
                  </div>
                </div>
              ))}
            </div>

            <aside style={inspectorStyle}>
              <div>
                <div style={panelHeaderStyle}>
                  <strong>Inspector</strong>
                  <span style={mutedStyle}>existing events only</span>
                </div>
                <p style={inspectorLineStyle}>
                  <span style={mutedStyle}>Active task</span>
                  <strong>{activeTaskLabel(summary)}</strong>
                </p>
              </div>

              <ChipGroup title="Written pages" values={summary?.pageKeys.written ?? []} />
              <ChipGroup title="Reused pages" values={summary?.pageKeys.reused ?? []} />
              <ChipGroup title="Affected pages" values={summary?.pageKeys.affected ?? []} />

              <div style={gapGroupStyle}>
                <strong>Coverage gaps</strong>
                {gaps.length === 0 ? <p style={emptyStyle}>not available yet</p> : null}
                {gaps.map((gap) => (
                  <div key={`${gap.reason}:${gap.pageKey}`} style={gapRowStyle}>
                    <span>{gap.reason}</span>
                    <strong>{gap.pageKey}</strong>
                    <span style={mutedStyle}>{gap.count}</span>
                  </div>
                ))}
              </div>
            </aside>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function StatusPill({ value }: { value: "live" | "paused" | "error" }) {
  const color = value === "error" ? "#991b1b" : value === "live" ? "#166534" : "#525252";
  const background = value === "error" ? "#fee2e2" : value === "live" ? "#dcfce7" : "#f5f5f5";
  return <strong style={{ ...statusPillStyle, color, background }}>{value}</strong>;
}

function Metric({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "neutral" | "red" }) {
  return (
    <div style={metricStyle}>
      <span style={mutedStyle}>{label}</span>
      <strong style={{ color: tone === "red" ? "#991b1b" : "#111827" }}>{value}</strong>
    </div>
  );
}

function ToneBadge({ severity }: { severity: string }) {
  const tone = severityTone(severity);
  return <span style={{ ...toneBadgeStyle, ...toneStyles[tone] }}>{severity}</span>;
}

function ChipGroup({ title, values }: { title: string; values: string[] }) {
  return (
    <div style={chipGroupStyle}>
      <strong>{title}</strong>
      <div style={chipsStyle}>
        {values.length === 0 ? <span style={emptyChipStyle}>not available yet</span> : null}
        {values.map((value) => <span key={value} style={chipStyle}>{value}</span>)}
      </div>
    </div>
  );
}

function activeTaskLabel(summary: DebugSummary | null) {
  if (!summary?.activeTask) return "none";
  const role = summary.activeTask.repositoryRole ? `${summary.activeTask.repositoryRole} ` : "";
  const page = summary.activeTask.pageKey ? ` · ${summary.activeTask.pageKey}` : "";
  return `${role}${summary.activeTask.taskType}${page}`;
}

const debuggerWrapStyle: CSSProperties = { marginTop: 12 };
const buttonStyle: CSSProperties = {
  alignItems: "center",
  background: "#fafafa",
  border: "1px solid #d4d4d4",
  borderRadius: 6,
  cursor: "pointer",
  display: "flex",
  fontWeight: 700,
  gap: 10,
  justifyContent: "space-between",
  padding: "7px 10px",
  width: "100%"
};
const buttonMetaStyle: CSSProperties = { color: "#737373", fontSize: 12, fontWeight: 500 };
const panelStyle: CSSProperties = { borderTop: "1px solid #d4d4d4", display: "grid", gap: 12, marginTop: 10, paddingTop: 12 };
const summaryStripStyle: CSSProperties = { alignItems: "stretch", display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(118px, 1fr))" };
const statusPillStyle: CSSProperties = { alignItems: "center", borderRadius: 6, display: "flex", fontSize: 12, justifyContent: "center", padding: "8px 10px", textTransform: "uppercase" };
const metricStyle: CSSProperties = { background: "#fff", border: "1px solid #e5e5e5", borderRadius: 6, display: "grid", gap: 2, minWidth: 0, padding: "7px 9px" };
const flowStyle: CSSProperties = { display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))" };
const laneStyle: CSSProperties = { border: "1px solid #e5e5e5", borderRadius: 6, display: "grid", gap: 4, minWidth: 0, padding: 8 };
const laneLabelStyle: CSSProperties = { color: "#525252", fontSize: 11, textTransform: "uppercase" };
const laneCountStyle: CSSProperties = { fontSize: 18, fontVariantNumeric: "tabular-nums" };
const laneValueStyle: CSSProperties = { color: "#404040", fontSize: 12, overflowWrap: "anywhere" };
const debuggerGridStyle: CSSProperties = { display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(min(260px, 100%), 1fr))" };
const timelineStyle: CSSProperties = { alignContent: "start", display: "grid", gap: 8, minWidth: 0 };
const inspectorStyle: CSSProperties = { alignContent: "start", borderLeft: "1px solid #e5e5e5", display: "grid", gap: 14, minWidth: 0, paddingLeft: 12 };
const panelHeaderStyle: CSSProperties = { alignItems: "center", display: "flex", gap: 8, justifyContent: "space-between" };
const eventRowStyle: CSSProperties = { border: "1px solid #e5e5e5", borderRadius: 6, display: "grid", gap: 5, padding: 10 };
const eventTopStyle: CSSProperties = { alignItems: "center", display: "flex", gap: 8, justifyContent: "space-between" };
const eventTypeStyle: CSSProperties = { fontSize: 13, overflowWrap: "anywhere" };
const eventMessageStyle: CSSProperties = { color: "#262626", margin: 0, overflowWrap: "anywhere" };
const eventMetaStyle: CSSProperties = { alignItems: "center", color: "#737373", display: "flex", flexWrap: "wrap", fontSize: 12, gap: 6 };
const toneBadgeStyle: CSSProperties = { borderRadius: 6, fontSize: 11, fontWeight: 700, padding: "2px 6px" };
const toneStyles = {
  neutral: { background: "#f5f5f5", color: "#404040" },
  amber: { background: "#fef3c7", color: "#92400e" },
  red: { background: "#fee2e2", color: "#991b1b" }
} as const;
const chipGroupStyle: CSSProperties = { display: "grid", gap: 7 };
const chipsStyle: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 6 };
const chipStyle: CSSProperties = { background: "#f5f5f5", borderRadius: 6, color: "#262626", fontSize: 12, padding: "3px 7px", overflowWrap: "anywhere" };
const emptyChipStyle: CSSProperties = { ...chipStyle, color: "#737373" };
const gapGroupStyle: CSSProperties = { display: "grid", gap: 7 };
const gapRowStyle: CSSProperties = { alignItems: "center", border: "1px solid #e5e5e5", borderRadius: 6, display: "grid", gap: 4, gridTemplateColumns: "minmax(0, 1fr) auto auto", padding: 8 };
const inspectorLineStyle: CSSProperties = { display: "grid", gap: 3, margin: "8px 0 0", overflowWrap: "anywhere" };
const mutedStyle: CSSProperties = { color: "#737373", fontSize: 12, margin: 0, minWidth: 0, overflowWrap: "anywhere" };
const timeStyle: CSSProperties = { ...mutedStyle, whiteSpace: "nowrap" };
const emptyStyle: CSSProperties = { color: "#737373", margin: 0 };
