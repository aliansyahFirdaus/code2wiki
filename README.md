# code2wiki

Local MVP demo path for the real GitHub App -> tag pair -> worker -> wiki reader flow.

## Setup

1. Install dependencies:
   ```sh
   pnpm install
   ```
2. Copy `.env.example` to `.env` and fill the real values:
   ```sh
   cp .env.example .env
   ```
3. Run migrations:
   ```sh
   pnpm db:migrate
   ```
4. Start the web app:
   ```sh
   pnpm dev:web
   ```

`demo` is only an example workspace id. Use any explicit workspace id consistently in the GitHub App setup URL, repository registration calls, and `/workspace?workspaceId=...`.

## Demo Flow

1. Open the GitHub App setup callback with an explicit workspace id so the installation is recorded.
2. Register one frontend and one backend repository through the existing repository API.
3. Push or create a matching tag in one repository. The webhook records it as waiting for a pair.
4. Push or create the matching tag in the other repository. The webhook creates one queued generation run.
5. Run the guarded worker steps:
   ```sh
   pnpm worker:run
   ```
   Or run one step:
   ```sh
   pnpm worker:run -- clone <generationRunId>
   pnpm worker:run -- analyze <generationRunId>
   pnpm worker:run -- generate <generationRunId>
   ```
6. Inspect progress at:
   ```text
   /workspace?workspaceId=demo
   ```
7. Open a completed wiki page, select sourced blocks, and save manual `EDIT` overlays.

## Checks

```sh
pnpm -r typecheck
pnpm test
pnpm --filter @code2wiki/web build
pnpm exec vitest run packages/analyzer/src/scanner.test.ts packages/ai/src/validate-output.test.ts apps/web/lib/wiki-blocks.test.ts
```
