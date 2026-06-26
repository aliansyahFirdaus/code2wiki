"use client";

import { useEffect, useState } from "react";

import type { GenerationRunControlState, GenerationRunExecutionMode } from "@code2wiki/shared";

import {
  canRequestNextStep,
  executionModeLabel,
  executionStateLabel,
  generationStepState,
  nextActionLabel,
  runStatusLabel,
  type GenerationStatus
} from "../lib/workspace-ui";

type RunSummaryData = {
  id: string;
  status: GenerationStatus;
  executionMode: GenerationRunExecutionMode;
  controlState: GenerationRunControlState;
  advanceRequestedAt: string | null;
  generatedStatementCount: number;
  generatedStatementWithEvidenceCount: number;
  writtenPageCount: number;
  reusedPageCount: number;
  affectedPageCount: number;
  errorMessage: string | null;
  qualityIssues?: Array<{ severity: "ERROR" | "WARN" | null; code: string | null; message: string | null }>;
  configuredModelLabel?: string | null;
  aiUsageSummary?: {
    provider: string | null;
    model: string | null;
  } | null;
};

export function LiveRunSummary({ initialRun }: { initialRun: RunSummaryData }) {
  const [run, setRun] = useState(initialRun);
  const [modePending, setModePending] = useState(false);
  const [nextStepPending, setNextStepPending] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const response = await fetch(`/api/generation-runs/${initialRun.id}`, { cache: "no-store" });
        const body = await response.json();
        if (cancelled || !response.ok || !body?.generationRun) return;
        setRun({
          id: body.generationRun.id,
          status: body.generationRun.status,
          executionMode: body.generationRun.executionMode,
          controlState: body.generationRun.controlState,
          advanceRequestedAt: body.generationRun.advanceRequestedAt,
          generatedStatementCount: body.generationRun.generatedStatementCount ?? 0,
          generatedStatementWithEvidenceCount: body.generationRun.generatedStatementWithEvidenceCount ?? 0,
          writtenPageCount: body.generationRun.writtenPageCount ?? 0,
          reusedPageCount: body.generationRun.reusedPageCount ?? 0,
          affectedPageCount: body.generationRun.affectedPageCount ?? 0,
          errorMessage: body.generationRun.errorMessage ?? null,
          qualityIssues: body.generationRun.qualityIssues ?? [],
          configuredModelLabel: body.generationRun.configuredModelLabel ?? null,
          aiUsageSummary: body.generationRun.aiUsageSummary ?? null
        });
      } catch {
        // Keep last known state on transient poll failure.
      }
    }

    poll();
    const id = window.setInterval(poll, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [initialRun.id]);

  const issue = runIssueLabel(run.status, run.errorMessage, run.qualityIssues ?? []);
  const modelLabel = formatModelLabel(run.aiUsageSummary, run.configuredModelLabel);
  const canQueueNextStep = canRequestNextStep(run.status, run.executionMode, run.controlState);
  const modeLabel = executionModeLabel(run.executionMode);
  const executionState = executionStateLabel(run.status, run.executionMode, run.advanceRequestedAt, run.controlState);
  const actionLabel = nextActionLabel(run.status, run.executionMode, run.advanceRequestedAt, run.controlState);

  async function updateExecutionMode(nextMode: GenerationRunExecutionMode) {
    setModePending(true);
    try {
      const response = await fetch(`/api/generation-runs/${run.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ executionMode: nextMode })
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.generationRun) {
        return;
      }
      setRun((current) => ({
        ...current,
        executionMode: body.generationRun.executionMode,
        controlState: body.generationRun.controlState,
        advanceRequestedAt: body.generationRun.advanceRequestedAt
      }));
    } finally {
      setModePending(false);
    }
  }

  async function requestNextStep() {
    setNextStepPending(true);
    try {
      const response = await fetch(`/api/generation-runs/${run.id}/next-step`, {
        method: "POST"
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || typeof body?.advanceRequestedAt !== "string") {
        return;
      }
      setRun((current) => ({ ...current, advanceRequestedAt: body.advanceRequestedAt }));
    } finally {
      setNextStepPending(false);
    }
  }

  async function updateControl(action: "pause" | "resume" | "cancel") {
    const response = await fetch(`/api/generation-runs/${run.id}/${action}`, { method: "POST" });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body) {
      return;
    }
    setRun((current) => ({
      ...current,
      status: body.status ?? current.status,
      controlState: body.controlState ?? current.controlState,
      advanceRequestedAt: body.controlState === "PAUSED" || body.controlState === "CANCEL_REQUESTED" ? null : current.advanceRequestedAt
    }));
  }

  async function cleanupRun() {
    const response = await fetch(`/api/generation-runs/${run.id}`, { method: "DELETE" });
    if (response.ok) {
      window.location.reload();
    }
  }

  return (
    <div className="grid gap-4 rounded-[8px] border border-[#dfdfdf] bg-[#fafafa] p-4">
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
        <div className="grid min-w-0 gap-1">
          <span className="text-xs font-medium text-[#707070]">Generation Status</span>
          <strong className="min-w-0 break-words text-base font-medium">
            {runStatusLabel(run.status)}
          </strong>
        </div>
        <Stepper status={run.status} />
      </div>
      <div className="grid gap-3 rounded-[8px] border border-[#dfdfdf] bg-white p-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
        <div className="grid gap-1">
          <span className="text-xs font-medium text-[#707070]">Execution Control</span>
          <strong className="text-sm font-medium text-[#171717]">{modeLabel}</strong>
          <span className="text-sm text-[#707070]">{executionState}. {actionLabel}.</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-[9999px] border border-[#dfdfdf] bg-[#fafafa] p-1">
            <button
              type="button"
              onClick={() => updateExecutionMode("AUTO")}
              disabled={modePending || run.executionMode === "AUTO"}
              className={`${run.executionMode === "AUTO" ? "bg-[#171717] text-white" : "bg-transparent text-[#707070]"} rounded-[9999px] px-3 py-2 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-60`}
            >
              AUTO
            </button>
            <button
              type="button"
              onClick={() => updateExecutionMode("MANUAL")}
              disabled={modePending || run.executionMode === "MANUAL"}
              className={`${run.executionMode === "MANUAL" ? "bg-[#171717] text-white" : "bg-transparent text-[#707070]"} rounded-[9999px] px-3 py-2 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-60`}
            >
              MANUAL
            </button>
          </div>
          {canQueueNextStep ? (
            <button
              type="button"
              onClick={requestNextStep}
              disabled={nextStepPending || Boolean(run.advanceRequestedAt)}
              className="rounded-[9999px] border border-[#171717] bg-[#171717] px-3 py-2 text-xs font-medium text-white disabled:cursor-not-allowed disabled:border-[#dfdfdf] disabled:bg-[#fafafa] disabled:text-[#9a9a9a]"
            >
              {nextStepPending ? "Queueing..." : run.advanceRequestedAt ? "Next step queued" : "Next step"}
            </button>
          ) : null}
          {run.controlState === "ACTIVE" ? (
            <button
              type="button"
              onClick={() => updateControl("pause")}
              className="rounded-[9999px] border border-[#dfdfdf] bg-white px-3 py-2 text-xs font-medium text-[#171717]"
            >
              Pause
            </button>
          ) : null}
          {run.controlState === "PAUSED" ? (
            <button
              type="button"
              onClick={() => updateControl("resume")}
              className="rounded-[9999px] border border-[#171717] bg-white px-3 py-2 text-xs font-medium text-[#171717]"
            >
              Resume
            </button>
          ) : null}
          {run.status !== "CANCELED" && run.controlState !== "CANCEL_REQUESTED" ? (
            <button
              type="button"
              onClick={() => updateControl("cancel")}
              className="rounded-[9999px] border border-[#ff2201]/30 bg-[#fff5f3] px-3 py-2 text-xs font-medium text-[#ff2201]"
            >
              Force stop
            </button>
          ) : null}
          <button
            type="button"
            onClick={cleanupRun}
            className="rounded-[9999px] border border-[#ff2201]/30 bg-white px-3 py-2 text-xs font-medium text-[#ff2201]"
          >
            Delete run output
          </button>
        </div>
      </div>
      <div className={`grid grid-cols-1 gap-0 ${issue ? "md:grid-cols-4" : "md:grid-cols-3"}`}>
        <SummaryItem
          label="Pages"
          value={`${run.writtenPageCount} written / ${run.reusedPageCount} reused / ${run.affectedPageCount} affected`}
        />
        <SummaryItem
          label="Statements"
          value={`${run.generatedStatementWithEvidenceCount}/${run.generatedStatementCount}`}
          bordered
        />
        <SummaryItem label="Model" value={modelLabel} bordered />
        {issue ? <SummaryItem label="Issue" value={issue} accent bordered /> : null}
      </div>
    </div>
  );
}

function SummaryItem({
  label,
  value,
  accent = false,
  bordered = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
  bordered?: boolean;
}) {
  return (
    <div className="relative min-w-0">
      {bordered ? <span aria-hidden="true" className="absolute left-0 top-1/2 h-11 -translate-y-1/2 border-l border-[#dfdfdf]" /> : null}
      <div className={`grid min-w-0 gap-1 ${bordered ? "px-6" : "pr-6"}`}>
        <span className="text-xs font-medium text-[#707070]">{label}</span>
        <strong className={`${accent ? "text-[#ff2201]" : "text-[#171717]"} min-w-0 break-words text-sm font-medium`}>
          {value}
        </strong>
      </div>
    </div>
  );
}

function Stepper({ status }: { status: GenerationStatus }) {
  return (
    <div className="flex flex-wrap gap-2">
      {generationStepState(status).map((step) => (
        <span
          key={step.label}
          className={`${
            step.state === "active"
              ? "border-[#3ecf8e] bg-[#3ecf8e] text-[#171717]"
              : step.state === "done"
                ? "border-[#171717] bg-[#171717] text-white"
                : step.state === "error"
                  ? "border-[#ff2201]/30 bg-[#fff5f3] text-[#ff2201]"
                  : "border-[#ededed] bg-white text-[#9a9a9a]"
          } inline-flex items-center gap-2 rounded-[9999px] border px-3 py-2 text-xs font-medium`}
        >
          {step.state === "done" ? <StepCheckIcon /> : null}
          {step.state === "error" ? <StepErrorIcon /> : null}
          {step.label}
        </span>
      ))}
    </div>
  );
}

function StepCheckIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
    </svg>
  );
}

function StepErrorIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M4 4 12 12" />
      <path d="M12 4 4 12" />
    </svg>
  );
}

function runIssueLabel(
  status: GenerationStatus,
  errorMessage: string | null,
  qualityIssues: Array<{ severity: "ERROR" | "WARN" | null; code: string | null; message: string | null }>
) {
  if (status === "FAILED" || status === "AI_OUTPUT_INVALID" || status === "NEEDS_REVIEW") {
    const blocker = qualityIssues.find((issue) => issue.message);
    if (blocker?.message) {
      return blocker.message;
    }
    return errorMessage ? humanizeIssue(errorMessage) : runStatusLabel(status);
  }
  if (status === "CANCELED") return "Force stopped by operator";
  return null;
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

function formatModelLabel(aiUsageSummary: RunSummaryData["aiUsageSummary"], configuredModelLabel?: string | null) {
  if (!aiUsageSummary?.model) {
    return configuredModelLabel ?? "Not configured";
  }
  return aiUsageSummary.provider ? `${aiUsageSummary.provider} / ${aiUsageSummary.model}` : aiUsageSummary.model;
}
