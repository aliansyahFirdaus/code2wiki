# Manual E2E Checklist

Use a real explicit `workspaceId`; `demo` is only an example.

- [ ] Env is filled and `pnpm db:migrate` succeeds.
- [ ] Web starts with `pnpm dev:web`.
- [ ] `/workspace` without `workspaceId` renders a clean setup state.
- [ ] GitHub App callback records an installation for `/api/github/app/callback?workspaceId=demo`.
- [ ] Frontend repository is registered through `POST /api/repositories`.
- [ ] Backend repository is registered through `POST /api/repositories`.
- [ ] `/workspace?workspaceId=demo` lists installations and repositories.
- [ ] First matching tag webhook records a waiting tag event and does not create a generation run.
- [ ] Second matching tag webhook creates one queued generation run.
- [ ] Duplicate delivery/tag webhook does not create another run.
- [ ] `pnpm worker:run -- clone <generationRunId>` moves `QUEUED` to `CLONED` or a sanitized `FAILED`.
- [ ] `pnpm worker:run -- analyze <generationRunId>` moves `CLONED` to `FACTS_EXTRACTED` or a sanitized `FAILED`.
- [ ] `pnpm worker:run -- generate <generationRunId>` moves `FACTS_EXTRACTED` to `COMPLETED`, `AI_OUTPUT_INVALID`, or a sanitized `FAILED`.
- [ ] `pnpm worker:run` prints sanitized JSON only.
- [ ] `/api/generation-runs?workspaceId=demo` returns read-only run metadata and no secrets/raw headers/tokens.
- [ ] `/api/generation-runs/<id>` returns one run and generated wiki page links.
- [ ] Dashboard shows queued/running/completed/failed statuses and sanitized errors.
- [ ] Completed run links to generated wiki pages.
- [ ] Wiki reader shows pages, source evidence, and generation metadata.
- [ ] Source fetch failure renders an error instead of silently failing.
- [ ] Manual `EDIT` overlay saves, refreshes, and persists after page reload.
- [ ] Overlay save failure renders an error instead of silently failing.
- [ ] Empty states render for no installs, no repos, no runs, and no pages.
