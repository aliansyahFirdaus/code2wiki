"use client";

import { useState } from "react";

export function CopyableId({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  return (
    <button
      type="button"
      onClick={copy}
      title={`Copy ${label}`}
      className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1 rounded-[8px] border border-transparent px-2 py-1 text-left motion-safe:transition-colors hover:border-[#dfdfdf] hover:bg-[#fafafa] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#171717]"
    >
      <span className="col-span-2 text-xs font-medium text-[#707070]">{label}</span>
      <ClipboardIcon />
      <span className="min-w-0 truncate font-mono text-sm font-medium text-[#171717]">{copied ? "copied" : value}</span>
    </button>
  );
}

function ClipboardIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4 text-[#707070]" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="8" y="7" width="10" height="13" rx="2" />
      <path d="M6 17H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" />
    </svg>
  );
}
