"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

type Props = {
  workspaceId: string;
  disabled: boolean;
};

export function QueueLatestTagsButton({ workspaceId, disabled }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onClick = () => {
    setMessage(null);
    setError(null);
    startTransition(async () => {
      try {
        const response = await fetch("/api/generation-runs/queue-latest-tags", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workspaceId })
        });
        const payload = (await response.json().catch(() => null)) as { duplicate?: boolean; error?: { message?: string } } | null;

        if (!response.ok) {
          throw new Error(payload?.error?.message || "Failed to queue generation from latest tags.");
        }

        setMessage(payload?.duplicate ? "Latest FE/BE pair already queued before." : "Generation queued from latest FE/BE tags.");
        router.refresh();
      } catch (value) {
        setError(value instanceof Error ? value.message : "Failed to queue generation from latest tags.");
      }
    });
  };

  return (
    <div className="grid gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled || pending}
        className="inline-flex min-h-[44px] items-center justify-center rounded-[9999px] bg-[#171717] px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "Resolving latest tags..." : "Generate from latest tags"}
      </button>
      {message ? <p className="text-sm text-[#707070]">{message}</p> : null}
      {error ? <p className="text-sm text-[#ff2201]">{error}</p> : null}
    </div>
  );
}
