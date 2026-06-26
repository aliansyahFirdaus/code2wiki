"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import {
  debugEventLabel,
  debuggerStepForEvent,
  debuggerStepForTask,
  debugStageLabel,
  generationStepState,
  generationSteps,
  groupCoverageGaps,
  mergeDebugEvents,
  runStatusLabel,
  severityTone,
  taskTypeLabel,
  type DebuggerStep,
  type GenerationStatus
} from "../lib/workspace-ui";
import { formatClockTime, formatDateTime } from "../lib/date-format";

type DebugEvent = {
  id: string;
  stage: string;
  eventType: string;
  severity: string;
  message: string;
  payloadJson: Record<string, unknown>;
  createdAt: string;
};

type DebugRun = {
  id: string;
  status: GenerationStatus;
  workspaceId: string;
  frontendRepositoryId: string;
  backendRepositoryId: string;
  frontendTag: string;
  frontendCommitSha: string;
  backendTag: string;
  backendCommitSha: string;
  totalEligibleFiles: number;
  indexedEligibleFiles: number;
  frontendTotalEligibleFiles: number;
  frontendIndexedEligibleFiles: number;
  backendTotalEligibleFiles: number;
  backendIndexedEligibleFiles: number;
  generatedStatementCount: number;
  generatedStatementWithEvidenceCount: number;
  incrementalReportJson: Record<string, unknown> | null;
  coverageReportJson: Record<string, unknown> | null;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
};

type DebugTask = {
  id: string;
  repositoryRole: string | null;
  taskType: string;
  status: string;
  branchState: string | null;
  priority: number;
  pageKey: string | null;
  parentTaskId: string | null;
  rootTaskId: string | null;
  dedupeKey: string;
  reason: string;
  payloadJson: Record<string, unknown>;
  resultJson: Record<string, unknown> | null;
  attempts: number;
  maxAttempts: number;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
};

type DebugSummary = {
  currentStage: string;
  activeTask: { id?: string; taskType: string; pageKey: string | null; repositoryRole: string | null } | null;
  taskCounts: Record<string, number>;
  pageKeys: { written: string[]; reused: string[]; affected: string[] };
  coverage: { counts: Record<string, unknown> | null; gaps: Array<{ pageKey: string | null; reason: string | null }> };
  analyze: {
    totalEligibleFiles: number;
    indexedEligibleFiles: number;
    frontendTotalEligibleFiles: number;
    frontendIndexedEligibleFiles: number;
    backendTotalEligibleFiles: number;
    backendIndexedEligibleFiles: number;
    factCount: number | null;
    evidenceCount: number | null;
    codeSummaryCount: number | null;
    scanScope: Record<string, unknown> | null;
    files: Record<string, unknown> | null;
    scanWarnings: string[];
  } | null;
  lastError: string | null;
};

const DEBUG_PAGE_SIZE = 10;
const UI_PAGE_SIZE = 10;

export function GenerationDebugger({ generationRunId }: { generationRunId: string }) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<DebugEvent[]>([]);
  const [summary, setSummary] = useState<DebugSummary | null>(null);
  const [run, setRun] = useState<DebugRun | null>(null);
  const [tasks, setTasks] = useState<DebugTask[]>([]);
  const [totalEventCount, setTotalEventCount] = useState(0);
  const [hasOlderEvents, setHasOlderEvents] = useState(false);
  const [loadingOlderEvents, setLoadingOlderEvents] = useState(false);
  const [selectedStep, setSelectedStep] = useState<DebuggerStep>("Explore");
  const [userSelectedStep, setUserSelectedStep] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cursorRef = useRef<string | null>(null);
  const oldestCursorRef = useRef<string | null>(null);
  const loadingOlderRef = useRef(false);

  useEffect(() => {
    if (open) return;
    setEvents([]);
    setSummary(null);
    setRun(null);
    setTasks([]);
    setTotalEventCount(0);
    setHasOlderEvents(false);
    setLoadingOlderEvents(false);
    setError(null);
    cursorRef.current = null;
    oldestCursorRef.current = null;
    loadingOlderRef.current = false;
  }, [generationRunId, open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    async function loadPage(query: string) {
      try {
        const response = await fetch(`/api/generation-runs/${generationRunId}/debug-events?${query}`, { cache: "no-store" });
        const body = await response.json();
        if (cancelled) return;
        if (!response.ok) throw new Error(body?.error?.message ?? "Debug events unavailable.");
        setEvents((existing) => mergeDebugEvents(existing, body.events ?? []));
        cursorRef.current = body.nextAfterId ?? cursorRef.current;
        oldestCursorRef.current = body.previousBeforeId ?? oldestCursorRef.current;
        setHasOlderEvents(Boolean(body.hasMoreBefore));
        setTotalEventCount(typeof body.totalEventCount === "number" ? body.totalEventCount : 0);
        setSummary(body.summary);
        setRun(body.run ?? null);
        setTasks(body.tasks ?? []);
        setError(null);
        return body;
      } catch (pollError) {
        if (!cancelled) setError(pollError instanceof Error ? pollError.message : "Debug events unavailable.");
        return null;
      }
    }

    async function poll() {
      const afterId = cursorRef.current;
      const query = afterId
        ? `afterId=${encodeURIComponent(afterId)}&limit=${DEBUG_PAGE_SIZE}`
        : `tail=1&limit=${DEBUG_PAGE_SIZE}`;
      await loadPage(query);
    }

    poll();
    const id = window.setInterval(poll, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [generationRunId, open]);

  const stepStates = generationStepState(run?.status ?? "QUEUED");
  const activeStep = stepStates.find((step) => step.state === "active" || step.state === "error")?.label ?? "Done";
  const previousActiveStepRef = useRef(activeStep);
  useEffect(() => {
    if (!userSelectedStep) {
      setSelectedStep(activeStep);
      previousActiveStepRef.current = activeStep;
      return;
    }
    if (previousActiveStepRef.current !== activeStep) {
      setSelectedStep(activeStep);
      previousActiveStepRef.current = activeStep;
    }
  }, [activeStep, userSelectedStep]);

  const stepTasks = useMemo(() => tasks.filter((task) => debuggerStepForTask(task.taskType) === selectedStep), [selectedStep, tasks]);
  const stepEvents = useMemo(() => events.filter((event) => debuggerStepForEvent(event) === selectedStep), [selectedStep, events]);
  const eventScroll = useInfiniteReveal(stepEvents.length, `${selectedStep}:${stepEvents.map((event) => event.id).join(",")}`);
  const visibleEvents = stepEvents.slice().reverse().slice(0, eventScroll.visibleCount);
  const indicator = error ? "error" : open ? "live" : "paused";

  async function loadOlderEvents() {
    const beforeId = oldestCursorRef.current;
    if (!beforeId || loadingOlderRef.current || !hasOlderEvents) return;
    loadingOlderRef.current = true;
    setLoadingOlderEvents(true);
    try {
      const response = await fetch(
        `/api/generation-runs/${generationRunId}/debug-events?beforeId=${encodeURIComponent(beforeId)}&limit=${DEBUG_PAGE_SIZE}`,
        { cache: "no-store" }
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error?.message ?? "Debug events unavailable.");
      setEvents((existing) => mergeDebugEvents(existing, body.events ?? []));
      oldestCursorRef.current = body.previousBeforeId ?? oldestCursorRef.current;
      setHasOlderEvents(Boolean(body.hasMoreBefore));
      setTotalEventCount(typeof body.totalEventCount === "number" ? body.totalEventCount : 0);
      setSummary(body.summary);
      setRun(body.run ?? null);
      setTasks(body.tasks ?? []);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Debug events unavailable.");
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlderEvents(false);
    }
  }

  useEffect(() => {
    if (!open || !hasOlderEvents || !eventScroll.hasMore || loadingOlderEvents) return;
    if (visibleEvents.length > 0) return;
    void loadOlderEvents();
  }, [eventScroll.hasMore, generationRunId, hasOlderEvents, loadingOlderEvents, open, selectedStep, visibleEvents.length]);

  useEffect(() => {
    if (!open || !hasOlderEvents || eventScroll.hasMore || loadingOlderEvents || !eventScroll.sentinelRef.current) return;
    const node = eventScroll.sentinelRef.current;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      void loadOlderEvents();
    }, { rootMargin: "160px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [eventScroll.hasMore, eventScroll.sentinelRef, hasOlderEvents, loadingOlderEvents, open]);

  return (
    <div className="grid gap-4">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex min-h-[44px] w-full items-center justify-between gap-4 rounded-[8px] border border-[#dfdfdf] bg-[#fafafa] px-4 py-3 text-left text-sm font-medium text-[#171717] motion-safe:transition-colors hover:border-[#c7c7c7] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#171717]"
      >
        <span>Live Debugger</span>
        <span className="text-xs font-medium text-[#707070]">{open ? "Collapse" : "Expand"}</span>
      </button>
      {open ? (
        <section className="grid gap-6 border-t border-[#ededed] pt-8" aria-label="Live generation debugger">
          <div className="grid gap-4 rounded-[8px] border border-[#dfdfdf] bg-[#fafafa] p-4">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <StatusDot value={indicator} />
                <strong className="text-sm font-medium">{run ? runStatusLabel(run.status) : summary?.currentStage ? debugStageLabel(summary.currentStage) : "Waiting for data"}</strong>
              </div>
              <span className="font-mono text-xs tabular-nums text-[#9a9a9a]">{visibleEvents.length}/{totalEventCount || stepEvents.length} total events</span>
            </div>
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
              <LabelValue label="Active task" value={activeTaskLabel(summary)} />
              <LabelValue label="Last issue" value={humanizeIssue(summary?.lastError ?? run?.errorMessage ?? error ?? "none")} accent={Boolean(summary?.lastError || run?.errorMessage || error)} />
            </div>
          </div>

          <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Debugger steps">
            {stepStates.map((step) => (
              <button
                key={step.label}
                type="button"
                role="tab"
                aria-selected={selectedStep === step.label}
                onClick={() => {
                  setSelectedStep(step.label);
                  setUserSelectedStep(true);
                }}
                className={`${selectedStep === step.label ? "border-[#171717] bg-[#171717] text-white" : step.state === "error" ? "border-[#ff2201]/40 bg-[#fff8f6] text-[#ff2201]" : "border-[#dfdfdf] bg-white text-[#707070]"} inline-flex min-h-[40px] shrink-0 items-center gap-2 rounded-[9999px] border px-4 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#171717]`}
              >
                <StepIcon state={step.state} />
                {step.label}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-12 gap-6">
            <div className="col-span-12 grid content-start gap-4 lg:col-span-7">
              <StepPanel step={selectedStep} run={run} summary={summary} tasks={stepTasks} events={stepEvents} error={error} />
            </div>
            <aside className="col-span-12 grid content-start gap-4 lg:col-span-5">
              <Panel title={`${selectedStep} events`}>
                {visibleEvents.length === 0 ? <EmptyText>No events loaded for this step yet.</EmptyText> : null}
                <div className="grid max-h-[520px] gap-3 overflow-y-auto pr-1">
                  {visibleEvents.map((event) => (
                    <EventCard key={event.id} event={event} active={activeEvent(event, summary)} />
                  ))}
                  <InfiniteScrollSentinel
                    sentinelRef={eventScroll.sentinelRef}
                    enabled={eventScroll.hasMore || hasOlderEvents}
                    loading={loadingOlderEvents || eventScroll.loading}
                    idleLabel={eventScroll.hasMore ? "Scroll for more loaded events" : "Scroll to load older events"}
                  />
                </div>
              </Panel>
            </aside>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function StepPanel({ step, run, summary, tasks, events, error }: { step: DebuggerStep; run: DebugRun | null; summary: DebugSummary | null; tasks: DebugTask[]; events: DebugEvent[]; error: string | null }) {
  if (step === "Queue") {
    return (
      <Panel title="Run queue">
        <KeyGrid items={[
          ["Run", run?.id ?? "loading"],
          ["Status", run ? runStatusLabel(run.status) : "loading"],
          ["Workspace", run?.workspaceId ?? "loading"],
          ["Created", formatDate(run?.createdAt)]
        ]} />
        <RepoPair run={run} />
      </Panel>
    );
  }
  if (step === "Clone") {
    return (
      <Panel title="Clone repo">
        <RepoPair run={run} />
        <EventBullets events={events} empty="No clone events yet." />
      </Panel>
    );
  }
  if (step === "Analyze") {
    const scanScope = summary?.analyze?.scanScope ?? latestRecord(events, "scanScope");
    const files = summary?.analyze?.files ?? latestRecord(events, "files");
    return (
      <Panel title="Analyze code">
        <div className="grid gap-3 md:grid-cols-2">
          <CoverageMeter label="Frontend files" indexed={summary?.analyze?.frontendIndexedEligibleFiles ?? run?.frontendIndexedEligibleFiles ?? 0} total={summary?.analyze?.frontendTotalEligibleFiles ?? run?.frontendTotalEligibleFiles ?? 0} />
          <CoverageMeter label="Backend files" indexed={summary?.analyze?.backendIndexedEligibleFiles ?? run?.backendIndexedEligibleFiles ?? 0} total={summary?.analyze?.backendTotalEligibleFiles ?? run?.backendTotalEligibleFiles ?? 0} />
        </div>
        <KeyGrid items={[
          ["Total indexed", `${summary?.analyze?.indexedEligibleFiles ?? run?.indexedEligibleFiles ?? 0}/${summary?.analyze?.totalEligibleFiles ?? run?.totalEligibleFiles ?? 0}`],
          ["Facts/evidence", analyzeCount(events, summary?.analyze ?? null, "factCount", "evidenceCount")],
          ["Summaries", latestNumber(events, "codeSummaryCount", summary?.analyze?.codeSummaryCount ?? null)]
        ]} />
        <KeyGrid items={[
          ["Root env guard", boolLabel(booleanPath(scanScope, "envGuardActive"))],
          ["Max-files guard", boolLabel(booleanPath(scanScope, "maxFilesGuardActive"))],
          ["FE roots", rootsLabel(recordPath(scanScope, "frontend"))],
          ["BE roots", rootsLabel(recordPath(scanScope, "backend"))]
        ]} />
        {summary?.analyze?.scanWarnings && summary.analyze.scanWarnings.length > 0 ? (
          <div className="grid gap-2 rounded-[6px] border border-[#ffdb13] bg-white p-3">
            <strong className="text-xs font-medium text-[#171717]">Analyze warnings</strong>
            {summary.analyze.scanWarnings.map((warning) => (
              <span key={warning} className="break-words text-xs leading-relaxed text-[#707070]">{warning}</span>
            ))}
          </div>
        ) : null}
        <div className="grid gap-4">
          <ScanFileSection
            title="Eligible files"
            frontendValues={stringArrayPath(files, "frontend", "eligibleFiles")}
            frontendCount={numberPath(files, "frontend", "eligibleCount")}
            backendValues={stringArrayPath(files, "backend", "eligibleFiles")}
            backendCount={numberPath(files, "backend", "eligibleCount")}
          />
          <ScanIgnoredSection
            title="Ignored files"
            frontendValues={ignoredFilesPath(files, "frontend")}
            frontendCount={numberPath(files, "frontend", "ignoredCount")}
            backendValues={ignoredFilesPath(files, "backend")}
            backendCount={numberPath(files, "backend", "ignoredCount")}
          />
        </div>
        <EventBullets events={events} empty="No analyze events yet." />
      </Panel>
    );
  }
  if (step === "Explore") {
    return (
      <Panel title="Explore product flow">
        <TaskList tasks={tasks} empty="No explore tasks queued yet." />
      </Panel>
    );
  }
  if (step === "Write") {
    return (
      <Panel title="Write wiki pages">
        <TaskList tasks={tasks} empty="No page write tasks yet." />
        <KeyGrid items={[
          ["Statements", `${run?.generatedStatementWithEvidenceCount ?? 0}/${run?.generatedStatementCount ?? 0}`],
          ["Written pages", String(summary?.pageKeys.written.length ?? 0)],
          ["Reused pages", String(summary?.pageKeys.reused.length ?? 0)]
        ]} />
      </Panel>
    );
  }
  if (step === "Check") {
    const gaps = groupCoverageGaps(summary?.coverage.gaps ?? []);
    return (
      <Panel title="Check evidence">
        <KeyGrid items={coverageItems(summary?.coverage.counts ?? null)} />
        {gaps.length === 0 ? <EmptyText>No coverage gaps reported.</EmptyText> : null}
        <div className="grid gap-2">
          {gaps.map((gap) => (
            <div key={`${gap.reason}:${gap.pageKey}`} className="grid gap-1 rounded-[6px] border border-[#dfdfdf] bg-white p-3 text-sm">
              <strong className="break-words font-medium">{gap.pageKey}</strong>
              <span className="break-words text-[#707070]">{humanizeIssue(gap.reason)}</span>
              <span className="font-mono text-xs tabular-nums text-[#9a9a9a]">{gap.count}x</span>
            </div>
          ))}
        </div>
        <TaskList tasks={tasks} empty="No coverage task yet." />
      </Panel>
    );
  }
  return (
    <Panel title="Run result">
      <KeyGrid items={[
        ["Final status", run ? runStatusLabel(run.status) : "loading"],
        ["Written pages", String(summary?.pageKeys.written.length ?? 0)],
        ["Reused pages", String(summary?.pageKeys.reused.length ?? 0)],
        ["Affected pages", String(summary?.pageKeys.affected.length ?? 0)],
        ["Failed tasks", String(summary?.taskCounts.failed ?? 0)],
        ["Review tasks", String(summary?.taskCounts.needsReview ?? 0)],
        ["Last issue", humanizeIssue(summary?.lastError ?? run?.errorMessage ?? error ?? "none")]
      ]} />
      <PageGroup label="Written" values={summary?.pageKeys.written ?? []} />
      <PageGroup label="Affected" values={summary?.pageKeys.affected ?? []} />
    </Panel>
  );
}

function RepoPair({ run }: { run: DebugRun | null }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <RepoCard role="FE" repository={run?.frontendRepositoryId ?? "loading"} tag={run?.frontendTag ?? "loading"} commit={run?.frontendCommitSha ?? "loading"} />
      <RepoCard role="BE" repository={run?.backendRepositoryId ?? "loading"} tag={run?.backendTag ?? "loading"} commit={run?.backendCommitSha ?? "loading"} />
    </div>
  );
}

function RepoCard({ role, repository, tag, commit }: { role: string; repository: string; tag: string; commit: string }) {
  return (
    <div className="grid min-w-0 gap-2 rounded-[6px] border border-[#dfdfdf] bg-white p-3 text-sm">
      <strong className="text-xs font-medium text-[#707070]">{role}</strong>
      <span className="break-words font-medium text-[#171717]">{repository}</span>
      <span className="break-words font-mono text-xs text-[#707070]">{tag}</span>
      <span className="break-words font-mono text-xs text-[#9a9a9a]">{commit}</span>
    </div>
  );
}

function TaskList({ tasks, empty }: { tasks: DebugTask[]; empty: string }) {
  const scroll = useInfiniteReveal(tasks.length, `tasks:${tasks.map((task) => task.id).join(",")}`);
  if (tasks.length === 0) return <EmptyText>{empty}</EmptyText>;
  return (
    <div className="grid gap-3">
      {tasks.slice(0, scroll.visibleCount).map((task) => (
        <div key={task.id} className={`${task.status === "FAILED" ? "border-[#ff2201]/40" : task.status === "NEEDS_REVIEW" ? "border-[#ffdb13]" : "border-[#dfdfdf]"} grid gap-2 rounded-[8px] border bg-white p-4`}>
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="grid min-w-0 gap-1">
              <strong className="break-words text-sm font-medium">{taskTypeLabel(task.taskType)}{task.pageKey ? ` · ${task.pageKey}` : ""}</strong>
              <span className="break-words text-xs text-[#707070]">{task.reason}</span>
            </div>
            <StatusBadge value={task.status} />
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            {task.repositoryRole ? <EventChip value={task.repositoryRole} /> : null}
            {task.branchState ? <EventChip value={humanizeIssue(task.branchState)} /> : null}
            <EventChip value={`priority ${task.priority}`} />
            <EventChip value={`attempt ${task.attempts}/${task.maxAttempts}`} />
          </div>
          <KeyGrid compact items={[
            ["Dedupe", task.dedupeKey],
            ["Root", task.rootTaskId ?? task.id],
            ["Parent", task.parentTaskId ?? "none"],
            ["Concept", stringFrom(task.payloadJson.conceptKey) ?? stringFrom(task.resultJson?.conceptKey) ?? "none"],
            ["Depth", numberFrom(task.payloadJson.depth) ?? "none"],
            ["Error", humanizeIssue(task.errorMessage ?? "none")]
          ]} />
        </div>
      ))}
      <InfiniteScrollSentinel sentinelRef={scroll.sentinelRef} enabled={scroll.hasMore} loading={scroll.loading} idleLabel={`Showing ${Math.min(scroll.visibleCount, tasks.length)}/${tasks.length} tasks`} />
    </div>
  );
}

function EventBullets({ events, empty }: { events: DebugEvent[]; empty: string }) {
  const orderedEvents = useMemo(() => events.slice().reverse(), [events]);
  const scroll = useInfiniteReveal(orderedEvents.length, `event-bullets:${orderedEvents.map((event) => event.id).join(",")}`);
  if (events.length === 0) return <EmptyText>{empty}</EmptyText>;
  return (
    <div className="grid gap-2">
      {orderedEvents.slice(0, scroll.visibleCount).map((event) => (
        <div key={event.id} className="rounded-[6px] border border-[#dfdfdf] bg-white p-3 text-sm">
          <strong className="font-medium">{debugEventLabel(event.eventType)}</strong>
          <p className="m-0 mt-1 break-words text-[#707070]">{event.message}</p>
        </div>
      ))}
      <InfiniteScrollSentinel sentinelRef={scroll.sentinelRef} enabled={scroll.hasMore} loading={scroll.loading} idleLabel={`Showing ${Math.min(scroll.visibleCount, orderedEvents.length)}/${orderedEvents.length} events`} />
    </div>
  );
}

function EventCard({ event, active }: { event: DebugEvent; active: boolean }) {
  const details = eventDetails(event);
  return (
    <div className={`${active ? "border-[#3ecf8e]" : "border-[#dfdfdf]"} grid gap-3 rounded-[8px] border bg-white p-4`}>
      <div className="flex min-w-0 items-center justify-between gap-4">
        <strong className="min-w-0 break-words text-sm font-medium">{debugEventLabel(event.eventType)}</strong>
        <time className="font-mono text-xs tabular-nums text-[#9a9a9a]" dateTime={event.createdAt}>{formatClockTime(event.createdAt)}</time>
      </div>
      <p className="m-0 break-words text-sm leading-relaxed text-[#707070]">{event.message}</p>
      {details.length > 0 ? (
        <div className="grid gap-1 rounded-[6px] border border-[#ededed] bg-[#fafafa] p-3">
          {details.map((detail) => (
            <span key={detail} className="break-words text-xs leading-relaxed text-[#707070]">{detail}</span>
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 text-xs text-[#9a9a9a]">
        <ToneBadge severity={event.severity} />
        <EventChip value={debugStageLabel(event.stage)} />
        {eventTaskLabel(event) ? <EventChip value={eventTaskLabel(event)!} /> : null}
        {stringPayload(event, "pageKey") ? <EventChip value={stringPayload(event, "pageKey")!} /> : null}
        {active ? <EventChip value="active task" active /> : null}
      </div>
    </div>
  );
}

function StatusDot({ value }: { value: "live" | "paused" | "error" }) {
  return (
    <strong className={`${value === "error" ? "border-[#ff2201]/30 bg-[#fafafa] text-[#ff2201]" : value === "live" ? "border-[#3ecf8e] bg-[#3ecf8e] text-[#171717]" : "border-[#dfdfdf] bg-white text-[#707070]"} inline-flex items-center rounded-[9999px] border px-3 py-1 text-xs font-medium`}>
      {value}
    </strong>
  );
}

function LabelValue({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="grid min-w-0 gap-1">
      <span className="text-xs font-medium text-[#707070]">{label}</span>
      <strong className={`${accent ? "text-[#ff2201]" : "text-[#171717]"} min-w-0 break-words text-sm font-medium`}>{value}</strong>
    </div>
  );
}

function ToneBadge({ severity }: { severity: string }) {
  const tone = severityTone(severity);
  return (
    <span className={`${tone === "red" ? "border-[#ff2201]/30 bg-[#fafafa] text-[#ff2201]" : tone === "amber" ? "border-[#ffdb13] bg-[#fafafa] text-[#171717]" : "border-[#dfdfdf] bg-[#fafafa] text-[#707070]"} rounded-[9999px] border px-2 py-1 text-xs font-medium`}>
      {severity}
    </span>
  );
}

function StatusBadge({ value }: { value: string }) {
  const accent = value === "FAILED" || value === "NEEDS_REVIEW";
  return <span className={`${accent ? "border-[#ff2201]/30 text-[#ff2201]" : "border-[#dfdfdf] text-[#707070]"} shrink-0 rounded-[9999px] border bg-[#fafafa] px-2 py-1 text-xs font-medium`}>{humanizeIssue(value)}</span>;
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="grid gap-4 rounded-[8px] border border-[#dfdfdf] bg-[#fafafa] p-4">
      <strong className="text-sm font-medium">{title}</strong>
      {children}
    </div>
  );
}

function EmptyText({ children }: { children: ReactNode }) {
  return <p className="m-0 text-sm leading-relaxed text-[#707070]">{children}</p>;
}

function KeyGrid({ items, compact = false }: { items: Array<[string, ReactNode]>; compact?: boolean }) {
  return (
    <div className={`grid gap-2 ${compact ? "" : "md:grid-cols-2"}`}>
      {items.map(([label, value]) => (
        <div key={label} className="grid min-w-0 gap-1 rounded-[6px] border border-[#dfdfdf] bg-white p-3">
          <span className="text-xs font-medium text-[#707070]">{label}</span>
          <strong className="min-w-0 break-words text-sm font-medium text-[#171717]">{value}</strong>
        </div>
      ))}
    </div>
  );
}

function CoverageMeter({ label, indexed, total }: { label: string; indexed: number; total: number }) {
  const percent = total > 0 ? Math.round((indexed / total) * 100) : 0;
  return (
    <div className="grid gap-2 rounded-[6px] border border-[#dfdfdf] bg-white p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-[#707070]">{label}</span>
        <span className="font-mono text-xs tabular-nums text-[#171717]">{indexed}/{total}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-[9999px] bg-[#ededed]">
        <div className="h-full rounded-[9999px] bg-[#171717]" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function PageGroup({ label, values }: { label: string; values: string[] }) {
  const scroll = useInfiniteReveal(values.length, `${label}:${values.join(",")}`);
  const visibleValues = values.slice(0, scroll.visibleCount);
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-[#707070]">{label}</span>
        <span className="font-mono text-xs tabular-nums text-[#171717]">{Math.min(scroll.visibleCount, values.length)}/{values.length}</span>
      </div>
      <div className="grid gap-2">
        <div className="flex max-h-48 flex-wrap gap-2 overflow-y-auto">
          {values.length === 0 ? <span className="rounded-[9999px] border border-[#dfdfdf] bg-white px-3 py-2 text-xs text-[#9a9a9a]">none</span> : null}
          {visibleValues.map((value) => <EventChip key={value} value={value} />)}
        </div>
        <InfiniteScrollSentinel sentinelRef={scroll.sentinelRef} enabled={scroll.hasMore} loading={scroll.loading} idleLabel={`Showing ${Math.min(scroll.visibleCount, values.length)}/${values.length} pages`} />
      </div>
    </div>
  );
}

function ScanFileSection({
  title,
  frontendValues,
  frontendCount,
  backendValues,
  backendCount
}: {
  title: string;
  frontendValues: string[];
  frontendCount: number | null;
  backendValues: string[];
  backendCount: number | null;
}) {
  return (
    <div className="grid min-w-0 gap-3 rounded-[8px] border border-[#dfdfdf] bg-white p-4">
      <div className="flex items-center justify-between gap-3">
        <strong className="text-sm font-medium text-[#171717]">{title}</strong>
        <span className="font-mono text-xs tabular-nums text-[#707070]">{(frontendCount ?? frontendValues.length) + (backendCount ?? backendValues.length)}</span>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <ScanFileList title="FE" values={frontendValues} count={frontendCount} />
        <ScanFileList title="BE" values={backendValues} count={backendCount} />
      </div>
    </div>
  );
}

function ScanIgnoredSection({
  title,
  frontendValues,
  frontendCount,
  backendValues,
  backendCount
}: {
  title: string;
  frontendValues: Array<{ filePath: string; reason: string }>;
  frontendCount: number | null;
  backendValues: Array<{ filePath: string; reason: string }>;
  backendCount: number | null;
}) {
  return (
    <div className="grid min-w-0 gap-3 rounded-[8px] border border-[#dfdfdf] bg-white p-4">
      <div className="flex items-center justify-between gap-3">
        <strong className="text-sm font-medium text-[#171717]">{title}</strong>
        <span className="font-mono text-xs tabular-nums text-[#707070]">{(frontendCount ?? frontendValues.length) + (backendCount ?? backendValues.length)}</span>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <ScanIgnoredList title="FE" values={frontendValues} count={frontendCount} />
        <ScanIgnoredList title="BE" values={backendValues} count={backendCount} />
      </div>
    </div>
  );
}

function ScanFileList({ title, values, count }: { title: string; values: string[]; count: number | null }) {
  const total = count ?? values.length;
  const scroll = useInfiniteReveal(values.length, `${title}:${values.join(",")}`);
  return (
    <div className="grid min-w-0 content-start gap-2 rounded-[6px] border border-[#ededed] bg-[#fafafa] p-3">
      <ScanListHeader title={title} count={total} shown={Math.min(scroll.visibleCount, values.length)} />
      {values.length === 0 ? <EmptyText>none reported</EmptyText> : null}
      <div className="grid max-h-72 gap-1 overflow-y-auto pr-1">
        {values.slice(0, scroll.visibleCount).map((value) => (
          <span key={value} className="break-words font-mono text-xs leading-relaxed text-[#707070]">{value}</span>
        ))}
        <InfiniteScrollSentinel sentinelRef={scroll.sentinelRef} enabled={scroll.hasMore} loading={scroll.loading} idleLabel={`Showing ${Math.min(scroll.visibleCount, values.length)}/${total} files`} />
      </div>
    </div>
  );
}

function ScanIgnoredList({ title, values, count }: { title: string; values: Array<{ filePath: string; reason: string }>; count: number | null }) {
  const total = count ?? values.length;
  const scroll = useInfiniteReveal(values.length, `${title}:${values.map((value) => `${value.reason}:${value.filePath}`).join(",")}`);
  return (
    <div className="grid min-w-0 content-start gap-2 rounded-[6px] border border-[#ededed] bg-[#fafafa] p-3">
      <ScanListHeader title={title} count={total} shown={Math.min(scroll.visibleCount, values.length)} />
      {values.length === 0 ? <EmptyText>none reported</EmptyText> : null}
      <div className="grid max-h-72 gap-2 overflow-y-auto pr-1">
        {values.slice(0, scroll.visibleCount).map((value) => (
          <div key={`${value.reason}:${value.filePath}`} className="grid gap-1 border-b border-[#ededed] pb-2 last:border-b-0 last:pb-0">
            <span className="break-words font-mono text-xs leading-relaxed text-[#707070]">{value.filePath}</span>
            <span className="text-xs text-[#9a9a9a]">{ignoreReasonLabel(value.reason)}</span>
          </div>
        ))}
        <InfiniteScrollSentinel sentinelRef={scroll.sentinelRef} enabled={scroll.hasMore} loading={scroll.loading} idleLabel={`Showing ${Math.min(scroll.visibleCount, values.length)}/${total} files`} />
      </div>
    </div>
  );
}

function ScanListHeader({ title, count, shown }: { title: string; count: number; shown: number }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="grid gap-0.5">
        <strong className="text-xs font-medium text-[#707070]">{title}</strong>
        <span className="text-[11px] text-[#9a9a9a]">{shown}/{count}</span>
      </div>
      <span className="font-mono text-xs tabular-nums text-[#171717]">{count}</span>
    </div>
  );
}

function InfiniteScrollSentinel({
  enabled,
  loading,
  idleLabel,
  loadingLabel = "Loading more...",
  sentinelRef
}: {
  enabled: boolean;
  loading: boolean;
  idleLabel: string;
  loadingLabel?: string;
  sentinelRef: React.RefObject<HTMLDivElement | null>;
}) {
  if (!enabled && !loading) return null;
  return (
    <div ref={sentinelRef} aria-hidden="true" className="flex min-h-[32px] items-center justify-center text-[11px] text-[#9a9a9a]">
      {loading ? loadingLabel : idleLabel}
    </div>
  );
}

function useInfiniteReveal(totalCount: number, resetKey: string) {
  const [visibleCount, setVisibleCount] = useState(() => Math.min(UI_PAGE_SIZE, totalCount));
  const [loading, setLoading] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadingTimeoutRef = useRef<number | null>(null);
  const hasMore = visibleCount < totalCount;

  useEffect(() => {
    setVisibleCount(Math.min(UI_PAGE_SIZE, totalCount));
    setLoading(false);
    if (loadingTimeoutRef.current) {
      window.clearTimeout(loadingTimeoutRef.current);
      loadingTimeoutRef.current = null;
    }
  }, [resetKey, totalCount]);

  useEffect(() => {
    if (!hasMore || !sentinelRef.current) return;
    const node = sentinelRef.current;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setLoading(true);
      setVisibleCount((current) => Math.min(totalCount, current + UI_PAGE_SIZE));
      if (loadingTimeoutRef.current) window.clearTimeout(loadingTimeoutRef.current);
      loadingTimeoutRef.current = window.setTimeout(() => {
        setLoading(false);
        loadingTimeoutRef.current = null;
      }, 180);
    }, { rootMargin: "160px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, totalCount]);

  useEffect(() => () => {
    if (loadingTimeoutRef.current) window.clearTimeout(loadingTimeoutRef.current);
  }, []);

  return { visibleCount, hasMore, loading, sentinelRef };
}

function EventChip({ value, active = false }: { value: string; active?: boolean }) {
  return <span className={`${active ? "border-[#3ecf8e] text-[#171717]" : "border-[#dfdfdf] text-[#707070]"} rounded-[9999px] border bg-[#fafafa] px-2 py-1 text-xs font-medium`}>{value}</span>;
}

function activeTaskLabel(summary: DebugSummary | null) {
  if (!summary?.activeTask) return "none";
  const role = summary.activeTask.repositoryRole ? `${summary.activeTask.repositoryRole} ` : "";
  const page = summary.activeTask.pageKey ? ` · ${summary.activeTask.pageKey}` : "";
  return `${role}${taskTypeLabel(summary.activeTask.taskType)}${page}`;
}

function eventTaskLabel(event: DebugEvent) {
  const taskType = stringPayload(event, "taskType");
  return taskType ? taskTypeLabel(taskType) : null;
}

function activeEvent(event: DebugEvent, summary: DebugSummary | null) {
  const taskId = stringPayload(event, "taskId");
  return Boolean(taskId && summary?.activeTask?.id === taskId);
}

function StepIcon({ state }: { state: string }) {
  if (state === "done") {
    return (
      <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 shrink-0" fill="none">
        <path d="M4.5 10.5 8 14l7.5-8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (state === "error") {
    return (
      <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 shrink-0" fill="none">
        <path d="m5.5 5.5 9 9m0-9-9 9" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
    );
  }
  if (state === "active") {
    return <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full bg-current" />;
  }
  return <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full border border-current opacity-60" />;
}

function coverageItems(counts: Record<string, unknown> | null): Array<[string, ReactNode]> {
  if (!counts) return [["Coverage", "not available"]];
  return Object.entries(counts).map(([key, value]) => [humanizeIssue(key), String(value)]);
}

function analyzeCount(events: DebugEvent[], analyze: DebugSummary["analyze"] | null, leftKey: string, rightKey: string) {
  const left = latestNumber(events, leftKey, analyze?.factCount ?? null);
  const right = latestNumber(events, rightKey, analyze?.evidenceCount ?? null);
  return left === "0" && right === "0" ? "not available" : `${left}/${right}`;
}

function latestNumber(events: DebugEvent[], key: string, fallback: number | null = null) {
  const value = [...events].reverse().map((event) => event.payloadJson?.[key]).find((item) => typeof item === "number");
  if (typeof value === "number") return String(value);
  if (typeof fallback === "number") return String(fallback);
  return "0";
}

function latestRecord(events: DebugEvent[], key: string) {
  return [...events].reverse().map((event) => event.payloadJson?.[key]).find(isRecord) ?? null;
}

function recordPath(value: Record<string, unknown> | null, key: string) {
  const item = value?.[key];
  return isRecord(item) ? item : null;
}

function booleanPath(value: Record<string, unknown> | null, key: string) {
  const item = value?.[key];
  return typeof item === "boolean" ? item : null;
}

function numberPath(value: Record<string, unknown> | null, role: string, key: string) {
  const item = recordPath(value, role)?.[key];
  return typeof item === "number" ? item : null;
}

function stringArrayPath(value: Record<string, unknown> | null, role: string, key: string) {
  const item = recordPath(value, role)?.[key];
  return Array.isArray(item) ? item.filter((entry): entry is string => typeof entry === "string") : [];
}

function ignoredFilesPath(value: Record<string, unknown> | null, role: string) {
  const item = recordPath(value, role)?.ignoredFiles;
  if (!Array.isArray(item)) return [];
  return item.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const filePath = stringFrom(entry.filePath);
    const reason = stringFrom(entry.reason);
    return filePath && reason ? [{ filePath, reason }] : [];
  });
}

function rootsLabel(value: Record<string, unknown> | null) {
  const paths = Array.isArray(value?.includePaths) ? value.includePaths.filter((item): item is string => typeof item === "string") : [];
  return paths.length > 0 ? paths.join(", ") : "all";
}

function boolLabel(value: boolean | null) {
  return value === null ? "not reported" : value ? "active" : "inactive";
}

function stringPayload(event: DebugEvent, key: string) {
  return stringFrom(event.payloadJson?.[key]);
}

function stringFrom(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberFrom(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function formatDate(value: string | null | undefined) {
  return formatDateTime(value);
}

function humanizeIssue(value: string) {
  if (/^[A-Z0-9_]+$/.test(value)) {
    return value
      .toLowerCase()
      .split("_")
      .filter(Boolean)
      .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
      .join(" ");
  }
  return value;
}

function ignoreReasonLabel(value: string) {
  const labels: Record<string, string> = {
    ".code2wikiignore": "Ignored by .code2wikiignore",
    "binary content": "Binary file",
    "file too large": "File too large",
    "generated header": "Generated file header",
    "ignored directory": "Ignored directory",
    "ignored extension": "Ignored extension",
    "ignored filename": "Ignored filename",
    "max files cap": "Skipped by max-files limit",
    "outside scan roots": "Outside configured scan roots"
  };
  return labels[value] ?? humanizeIssue(value);
}

function eventDetails(event: DebugEvent) {
  const details: string[] = [];
  for (const warning of stringArrayValue(event.payloadJson?.scanWarnings)) {
    details.push(humanizeIssue(warning));
  }
  const errorMessage = stringPayload(event, "errorMessage");
  if (errorMessage) details.push(humanizeIssue(errorMessage));
  const reason = stringPayload(event, "reason");
  if (reason) details.push(`Reason: ${humanizeIssue(reason)}`);
  const dedupeKey = stringPayload(event, "dedupeKey");
  if (dedupeKey) details.push(`Key: ${dedupeKey}`);
  const baselineGenerationRunId = stringPayload(event, "baselineGenerationRunId");
  if (baselineGenerationRunId) details.push(`Baseline run: ${baselineGenerationRunId}`);
  const relatedConceptDecision = recordPath(event.payloadJson, "relatedConceptDecision");
  const decisionReason = stringFrom(relatedConceptDecision?.reason);
  if (decisionReason) details.push(`Concept decision: ${humanizeIssue(decisionReason)}`);
  const counts = recordPath(event.payloadJson, "counts");
  if (counts) {
    const countParts = Object.entries(counts)
      .flatMap(([key, value]) => typeof value === "number" ? [`${humanizeIssue(key)} ${value}`] : []);
    if (countParts.length > 0) details.push(countParts.join(" · "));
  }
  return details.slice(0, 6);
}

function stringArrayValue(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}
