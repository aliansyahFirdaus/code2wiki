"use client";

import { useEffect, useState } from "react";

type DebugEvent = {
  id: string;
  stage: string;
  eventType: string;
  severity: string;
  message: string;
  createdAt: string;
};
type DebugSummary = {
  currentStage: string;
  activeTask: { taskType: string; pageKey: string | null } | null;
  taskCounts: Record<string, number>;
  pageKeys: { written: string[]; reused: string[]; affected: string[] };
  coverage: { counts: Record<string, unknown> | null; gaps: Array<{ pageKey: string | null; reason: string | null }> };
  lastError: string | null;
};

export function GenerationDebugger({ generationRunId }: { generationRunId: string }) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<DebugEvent[]>([]);
  const [afterId, setAfterId] = useState<string | null>(null);
  const [summary, setSummary] = useState<DebugSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    async function poll() {
      try {
        const params = afterId ? `?afterId=${encodeURIComponent(afterId)}` : "";
        const response = await fetch(`/api/generation-runs/${generationRunId}/debug-events${params}`, { cache: "no-store" });
        const body = await response.json();
        if (cancelled) return;
        if (!response.ok) throw new Error(body?.error?.message ?? "Debug events unavailable.");
        setEvents((existing) => [...existing, ...body.events]);
        setAfterId(body.nextAfterId ?? afterId);
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
  }, [afterId, generationRunId, open]);

  return (
    <div style={{ marginTop: 12 }}>
      <button type="button" onClick={() => setOpen((value) => !value)} style={buttonStyle}>
        {open ? "Hide debugger" : "Show debugger"}
      </button>
      {open ? (
        <div style={panelStyle}>
          <div style={timelineStyle}>
            {events.length === 0 ? <p style={mutedStyle}>No self-expanding generation events yet.</p> : null}
            {events.map((event) => (
              <div key={event.id} style={eventStyle}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <strong>{event.eventType}</strong>
                  <span style={mutedStyle}>{new Date(event.createdAt).toLocaleTimeString()}</span>
                </div>
                <p style={{ margin: "4px 0" }}>{event.message}</p>
                <p style={mutedStyle}>
                  {event.severity} · {event.stage}
                </p>
              </div>
            ))}
          </div>
          <aside style={summaryStyle}>
            <Chip label="Stage" value={summary?.currentStage ?? "unknown"} />
            <Chip label="Active" value={summary?.activeTask ? `${summary.activeTask.taskType}${summary.activeTask.pageKey ? ` · ${summary.activeTask.pageKey}` : ""}` : "none"} />
            <Chip label="Queued" value={String(summary?.taskCounts.queued ?? 0)} />
            <Chip label="Written" value={String(summary?.pageKeys.written.length ?? 0)} />
            <Chip label="Reused" value={String(summary?.pageKeys.reused.length ?? 0)} />
            <Chip label="Affected" value={String(summary?.pageKeys.affected.length ?? 0)} />
            <Chip label="Gaps" value={String(summary?.coverage.gaps.length ?? 0)} />
            {summary?.lastError ? <Chip label="Last error" value={summary.lastError} tone="error" /> : null}
            {error ? <p style={errorStyle}>{error}</p> : null}
          </aside>
        </div>
      ) : null}
    </div>
  );
}

function Chip({ label, value, tone }: { label: string; value: string; tone?: "error" }) {
  return (
    <div style={{ ...chipStyle, borderColor: tone === "error" ? "#fecaca" : "#e5e7eb" }}>
      <span style={mutedStyle}>{label}</span>
      <strong style={{ color: tone === "error" ? "#b91c1c" : "#111827" }}>{value}</strong>
    </div>
  );
}

const buttonStyle = { border: "1px solid #d1d5db", borderRadius: 6, background: "#fff", padding: "6px 10px", cursor: "pointer" };
const panelStyle = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginTop: 12 };
const timelineStyle = { display: "grid", gap: 8, alignContent: "start" };
const summaryStyle = { display: "grid", gap: 8, alignContent: "start" };
const eventStyle = { border: "1px solid #e5e7eb", borderRadius: 8, padding: 10 };
const chipStyle = { display: "grid", gap: 2, border: "1px solid #e5e7eb", borderRadius: 8, padding: 8 };
const mutedStyle = { color: "#6b7280", margin: 0, fontSize: 12 };
const errorStyle = { color: "#b91c1c", margin: 0 };
