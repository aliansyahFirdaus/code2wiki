export default function HomePage() {
  return (
    <main className="min-h-screen bg-white text-[#171717]">
      <nav className="mx-auto flex max-w-7xl items-center justify-between border-b border-[#ededed] px-6 py-4 md:px-8">
        <a href="/" className="text-base font-medium text-[#171717]">
          Code<span className="text-[#3ecf8e]">2</span>Wiki
        </a>
        <a
          className="rounded-[6px] bg-[#3ecf8e] px-4 py-2 text-sm font-medium leading-none text-[#171717] transition-colors hover:bg-[#24b47e] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#171717]"
          href="/workspace?workspaceId=demo"
        >
          Open Demo
        </a>
      </nav>

      <section className="mx-auto grid max-w-7xl gap-12 px-6 py-16 md:px-8 md:py-24 lg:grid-cols-[minmax(0,0.9fr)_minmax(420px,1fr)] lg:items-center">
        <div>
          <p className="mb-6 text-[13px] leading-[1.45] text-[#707070]">Product knowledge generated from shipped code.</p>
          <h1 className="max-w-4xl text-balance text-[48px] font-medium leading-[1.1] tracking-[-1.44px] text-[#171717] md:text-[64px] md:tracking-[-1.92px]">
            Code evidence, wiki pages, and generation runs in one clean workspace.
          </h1>
          <p className="mt-8 max-w-[60ch] text-[18px] leading-[1.55] text-[#707070]">
            Inspect generated wiki pages, source evidence, and generation runs without mutating production data from the UI.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <a
              className="rounded-[6px] bg-[#3ecf8e] px-4 py-3 text-sm font-medium leading-none text-[#171717] transition-colors hover:bg-[#24b47e] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#171717]"
              href="/workspace?workspaceId=demo"
            >
              Open Demo Workspace
            </a>
            <a
              className="rounded-[6px] border border-[#dfdfdf] bg-white px-4 py-3 text-sm font-medium leading-none text-[#171717] transition-colors hover:border-[#c7c7c7] hover:bg-[#fafafa] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#171717]"
              href="/workspace"
            >
              Workspace Setup
            </a>
          </div>
        </div>

        <div className="grid gap-4 rounded-[12px] border border-[#dfdfdf] bg-[#fafafa] p-3 shadow-[0_18px_60px_rgb(23_23_23/0.08)]">
          <div className="rounded-[8px] border border-[#dfdfdf] bg-white p-4">
            <div className="mb-4 flex items-center justify-between border-b border-[#ededed] pb-3">
              <span className="text-[13px] text-[#707070]">generation_runs</span>
              <span className="rounded-full bg-[#3ecf8e] px-2 py-1 text-[12px] leading-[1.45] text-[#171717]">live</span>
            </div>
            <div className="grid gap-2 font-mono text-[12px] leading-[1.5] text-[#212121]">
              <div className="grid grid-cols-[90px_1fr_80px] gap-3 rounded-[6px] bg-[#fafafa] px-3 py-2">
                <span>COMPLETED</span>
                <span>checkout-overview</span>
                <span>18/18</span>
              </div>
              <div className="grid grid-cols-[90px_1fr_80px] gap-3 rounded-[6px] bg-[#fafafa] px-3 py-2">
                <span>RUNNING</span>
                <span>payment-flow</span>
                <span>11/16</span>
              </div>
              <div className="grid grid-cols-[90px_1fr_80px] gap-3 rounded-[6px] bg-[#fafafa] px-3 py-2">
                <span>REUSED</span>
                <span>auth-session</span>
                <span>9/9</span>
              </div>
            </div>
          </div>

          <div className="grid gap-3 rounded-[8px] bg-[#1c1c1c] p-4 text-white">
            <div className="flex items-center justify-between text-[13px] text-white/60">
              <span>source evidence</span>
              <span className="text-[#3ecf8e]">FE + BE</span>
            </div>
            <pre className="m-0 overflow-hidden whitespace-pre-wrap font-mono text-[12px] leading-[1.5] text-white">{`SELECT page_key, evidence_ids
FROM wiki_blocks
WHERE origin = 'CODE';`}</pre>
          </div>
        </div>
      </section>
    </main>
  );
}
