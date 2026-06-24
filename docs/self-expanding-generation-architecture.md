# Self-Expanding Generation Architecture

This document is the handoff plan for migrating code2wiki from one large wiki generation pass into an incremental, queue-driven documentation crawler.

The generated wiki must be product-story documentation for non-engineers. Internal analysis may use technical code facts, but the user-facing wiki must explain what a feature does, what users see, what users can do, rules that affect the flow, and related settings. It must not read like engineering documentation.

## Short Explanation

Current flow:

```text
clone repos -> analyze code -> generate all wiki pages in one large AI call/pass
```

Target flow:

```text
clone repos
-> inventory and prioritize files
-> analyze code into facts/evidence/code map/summaries
-> seed small generation tasks
-> process one task
-> write or update one wiki page
-> discover more related tasks
-> evaluate coverage gaps
-> repeat until coverage is acceptable
```

The key change is that wiki pages become living documents. A page can be created early, then updated later when another branch of the codebase reveals new behavior, rules, or dependencies.

Example:

```text
Task 1: Payroll page found
-> create Payroll List page

Task 2: Payroll search behavior found
-> trace the code path that supports search
-> update Payroll List page with the user-visible search behavior

Task 3: Admin Internal Payroll Item found later
-> discover it affects Payroll Monthly Detail
-> update Payroll Monthly Detail page with related settings and rules
```

## Why This Exists

The old approach is fragile for large repos:

- the AI receives too much context at once;
- a provider failure can block the whole wiki;
- docs are generated too late for users to inspect progress;
- later discoveries cannot naturally update an existing page;
- coverage can look complete even when large parts of the code were never attached to wiki output;
- generated docs can become too technical unless the output contract blocks engineering terms.

The new approach keeps AI calls small and makes progress durable after each task.

## Existing Assets To Keep

Do not rewrite these foundations:

- `generation_runs`: run lifecycle boundary.
- `code_facts`: deterministic extracted facts.
- `evidence`: source snippets and source URLs.
- `code_maps`: deterministic graph of technical relationships.
- `code_summaries`: deterministic file/module summaries.
- `wiki_pages`: canonical wiki page identity; already unique by `workspaceId + pageKey`.
- `wiki_blocks`: generated block content and evidence references.
- `wiki_block_overlays`: manual user edits.
- current AI validation and quality gate: invalid output must not be persisted as success.

The migration should replace orchestration, not restart the product.

## Engine Model

The engine is not "AI reads the whole repository".

The engine is a deterministic scanner/evaluator pipeline plus AI writing tasks:

```text
local scanner reads files
-> extracts facts/evidence from selected line ranges
-> builds import graph and code map
-> selects relevant evidence for one page/task
-> AI writes or updates product-story prose from that evidence
-> validators decide whether the output can be persisted
```

This is why the system can support multiple languages. The scanner treats source files as text first, then applies language-aware extractors where available.

Evidence passed to AI should be bounded and selected:

```text
pageKey: payroll.list
selected facts:
  - search changes the visible payroll list
  - principal selection limits the visible payroll list
selected evidence:
  - frontend file path + line range + short snippet/summary
  - backend file path + line range + short snippet/summary
  - related rule/calculation/empty-state evidence
```

Do not send the whole repository to AI.

Language support levels:

```text
Level 1: generic text/path/import scan
Level 2: language-aware pattern extraction
Level 3: parser-backed extraction such as TypeScript/Go/tree-sitter
Level 4: framework-specific hints
```

Do not depend on 200 framework detectors. Framework hints are optional shortcuts. The core must still work from file priority, import graph, evidence density, bridge signals, and evaluator feedback.

If a language/framework is not understood well enough, mark uncertain branches as `NEEDS_REVIEW` instead of inventing behavior.

## Legacy Code Relationship

This document is the architecture source of truth for the new generation flow. Existing code is useful, but it must not silently shape the new architecture back into the old one.

Treat the current full-generation flow as legacy code to replace:

```text
clone -> analyze -> build page groups -> call AI for large generation -> persist final wiki
```

Do not copy that orchestration into the new design. The target design is:

```text
clone -> inventory -> prioritize -> scan -> code map -> task queue -> page upsert -> evaluator
```

Reusable old assets:

```text
clone job
analyze job
code_facts
evidence
code_maps
code_summaries
wiki_pages
wiki_blocks
validation helpers
quality helpers
manual overlays
```

Legacy behavior that should not guide new implementation:

```text
building all page groups up front
large multi-page AI generation
using generation_runs status as detailed task progress
grouping pages mostly by file/evidence path
assuming generation is done after one AI pass
treating technical flow text as user-facing wiki prose
```

Recommended implementation boundary:

```text
apps/worker/src/jobs/self-expanding-generation/
```

Build the new pipeline in a new module/folder first. Import old helpers only when they fit the target model. Avoid turning `generate-wiki.ts` into a mixed legacy/new pipeline.

If existing code conflicts with this architecture document, follow this document. When a legacy path is no longer used by the new pipeline, delete it instead of preserving fallback behavior.

## User-Facing Wiki Contract

The final wiki is a feature story, not an engineering report.

Do not include these terms in user-facing prose:

```text
API
endpoint
frontend
backend
FE
BE
handler
service
controller
repository
SQL
query
database table
component
hook
props
state
function
file path
commit
evidenceId
```

Those words may exist only in internal events, debug views, evidence inspectors, or developer-only reports.

Every generated feature page should explain:

```text
Purpose
Who uses it
Where the user starts
What the user sees
What actions the user can take
What changes after each action
Rules and conditions
Related settings
Empty/error states in product language
Open questions if evidence is incomplete
```

Acceptable output:

```text
Payroll helps users review and manage vessel payroll for a selected period.

Users start from the payroll list, search for a vessel, choose a principal if needed, and open a vessel payroll period.

After a month is selected, users can review the payroll budget, crew rows, salary metrics, boarding status, and editable payroll values. If values are changed, the user can recalculate payroll and then export the result as payslips or a spreadsheet.
```

Unacceptable output:

```text
The Payroll page calls GET /payroll/vessels, which is handled by PayrollVesselController and reads payroll SQL tables.
```

## File Discovery Flow

Do not let AI choose files from the repository tree. File selection is deterministic.

```text
1. Clone
   Checkout the selected FE/BE commits. Do not assign priority here.

2. Inventory
   List files and apply hard ignores such as node_modules, build output, binary assets, generated caches, lock noise, and large static files.

3. Shallow Priority
   Assign rough priority from path, extension, file size, and light metadata.

4. Import Graph
   Parse import/export relationships and detect which files are reachable from important files.

5. Priority Promotion
   Adjust priority based on reachability, imports, and simple signals.

6. Deep Scan Queue
   Process high-priority files first and extract facts/evidence.

7. Code Map
   Build semantic relationships from facts/evidence.

8. Task Queue
   Crawl the feature tree by processing one small task at a time.

9. Evaluator
   Promote missed files/tasks when coverage gaps remain.
```

Import graph and code map are different:

```text
Import graph = file-to-file relationships.
Code map = product/behavior/data-flow relationships derived from extracted facts.
```

The tree-crawl behavior starts after enough facts/evidence/code-map data exists. The task queue is what walks from a product surface to its actions, related screens, related settings, and hidden rules.

## File Priority Lifecycle

Priority is dynamic. A file can move up or down as more information is discovered.

Lifecycle:

```text
INVENTORIED
-> SHALLOW_CLASSIFIED
-> PROMOTED_BY_IMPORT_GRAPH
-> DEEP_SCANNED
-> DISPOSITIONED
```

Priority levels:

```text
P0 ENTRYPOINT
P1 FEATURE_SURFACE
P2 BEHAVIOR
P3 DATA_FLOW
P4 SUPPORTING
P5 LOW_PRIORITY
P6 IGNORE
```

Initial examples:

```text
P0: page, screen, route config, main app shell, menu/sidebar config
P1: visible feature surface such as Payroll table or Vessel Bonus drawer
P2: user action such as search, filter, tab, row click, recalculate, export
P3: data flow code that supports a visible behavior
P4: helper, config, constants, formatter, domain type
P5: type declarations, style/theme, tests, storybook, mocks, generated declarations
P6: node_modules, dist, build, cache, binary assets, lock noise
```

Promotion examples:

```text
Imported by P0/P1 surface -> promote to supporting/behavior priority.
Contains visible user action -> promote to P2.
Contains data loading or saving behavior used by a surface -> promote to P3.
Contains business rule, calculation, default value, or permission condition -> promote to P2/P3.
Imported type-only file with no product behavior -> scan and mark no wiki value.
```

Important distinction:

```text
priority = when/how deeply to inspect a file
disposition = whether the file contributes to wiki coverage
```

Disposition values:

```text
MUST_DOCUMENT
SUPPORTING_EVIDENCE
NO_WIKI_VALUE
NEEDS_REVIEW
IGNORED
```

Example:

```text
src/types/i18n.d.ts
-> shallow priority P5
-> imported by Payroll UI, promoted to P4
-> scanned
-> only module declarations, no product behavior
-> disposition NO_WIKI_VALUE
```

This means the file was checked and should not become a coverage gap.

## Target Runtime Model

Use three loops.

```text
1. Discovery loop
   Finds product surfaces and behaviors from deterministic code facts.

2. Generation loop
   Sends one small task to AI, validates product-story output, persists one page update.

3. Coverage evaluator loop
   Checks internal facts/evidence/code-map nodes not represented in wiki, then enqueues gap tasks.
```

The execution is serial by default:

```text
pop task -> collect evidence -> call AI -> validate -> persist -> next task
```

The user experience is still live because each successful task persists immediately.

Default v1 concurrency:

```text
worker processors = 1
AI calls = 1 at a time
task execution = serial
wiki reading = live while tasks continue
```

## Branch Traversal Model

The crawler walks a graph through a queue, not a single recursive scan.

When a task finds a new branch, it enqueues the branch instead of diving forever in the same call stack.

Example:

```text
A
└── B
    └── C
        └── D data/action call
            ├── cross-repo branch: related backend flow
            └── same-repo continuation: E -> F
```

At `D`, the worker should:

```text
1. record a bridge edge;
2. enqueue a cross-repo trace task;
3. keep or enqueue the same-repo continuation if still relevant;
4. avoid duplicate work through a visited set.
```

Frontend and backend inventories stay separate. Cross-repo traversal happens only through evidence-backed bridge signals such as a data/action call, shared action name, shared domain term, or payload shape.

Backend-only discoveries should not become user-facing pages immediately. If a backend branch has no product surface yet, mark it as:

```text
NEEDS_FRONTEND_ANCHOR
```

Then let the evaluator attach it later when a related product surface is found.

Branch state:

```text
QUEUED
IN_PROGRESS
FOUND_CHILDREN
WAITING_RELATED_BRANCH
READY_TO_WRITE
WRITTEN
NO_WIKI_VALUE
NEEDS_REVIEW
FAILED
```

Stop conditions:

```text
enough evidence exists to explain the user-visible behavior
branch enters generic infrastructure/logging/wrappers
branch has no product-story value
branch was already visited
depth or budget is exhausted
```

If depth or budget is exhausted, do not pretend the branch is complete. Mark it `NEEDS_REVIEW` or enqueue an evaluator follow-up.

## Core Rules

- AI must not decide which files are important; scanners, import graph, code map, and evaluator do that.
- AI may write and summarize, but task creation must be evidence-backed.
- AI output must be product-story language, not engineering language.
- Month rows, vessel rows, IDs, filters, and pagination values are parameters, not separate wiki pages.
- Failed page updates must not delete the last valid page.
- Do not persist raw prompts, provider bodies, headers, tokens, API keys, or Authorization values.

## Example Breakdown: Payroll

```text
Payroll Overview
└── Vessel Payroll Entry
    └── Payroll Vessel Period List
        └── Payroll Vessel Monthly Detail
            ├── Payroll View
            │   ├── Annual Budget
            │   ├── BPJS Budget
            │   ├── Crew Data
            │   ├── Short Hand-Pay
            │   └── Meal Allowance
            ├── Insurance
            ├── Additional Bonus
            ├── Recalculate Payroll
            ├── Export Payslip
            └── Export To XLS
```

`June 2026` is not a page. It is a parameter for `Payroll Vessel Monthly Detail`.

## Quality Rules

Quality is not only schema validity. The generated wiki must be useful as a feature story.

Required gates:

```text
Schema validity
Evidence-backed important claims
No banned engineering terms in user-facing prose
Minimum story sections for the page type
No tiny page when substantial evidence exists
Update coherence: merge into the existing story, do not append random fragments
Open gaps are allowed only when evidence is actually incomplete
```

Internal technical evidence can support the page, but the page must translate it into product language.

## Proposed Phases

### Phase 1: Task Queue Foundation

Add a DB-backed task queue for generation work.

Suggested table: `generation_tasks`

Minimum fields:

```text
id
generationRunId
taskType
status
pageKey
parentTaskId
reason
payloadJson
attempts
errorMessage
createdAt
updatedAt
```

Initial task types:

```text
DISCOVER_SURFACE
TRACE_BEHAVIOR
CREATE_PAGE
UPDATE_PAGE
EVALUATE_COVERAGE
```

Start simple: process one task at a time inside the existing worker process. Do not add BullMQ/pg-boss yet.

### Phase 2: Living Wiki Page Upsert

Make wiki pages updateable by `pageKey`.

Behavior:

- `CREATE_PAGE` inserts the page if it does not exist.
- `UPDATE_PAGE` loads the existing page by `workspaceId + pageKey`.
- The AI receives existing page content plus new evidence.
- The worker validates output before replacing generated blocks.
- The generated page must satisfy the product-story output contract and must not leak technical implementation terms.
- Manual overlays remain untouched.
- Previous valid page content remains if the update fails.
- Statement-level source references must remain supported. A single statement may cite multiple FE and BE sources.

Add linkage table: `wiki_page_evidence`

Minimum fields:

```text
id
generationRunId
pageKey
evidenceId
factId nullable
sourceTaskId nullable
createdAt
```

Purpose:

- know which evidence/facts are already represented in wiki;
- support coverage calculation later;
- avoid duplicate updates for the same evidence.
- support statement-level source badges and source detail drawers/popovers.

### Statement-Level Source Contract

User-facing prose stays non-technical, but every sourced statement may keep a technical source badge in the editor/reader UI.

Behavior:

```text
statement text
-> source badge such as "Source Code: 3"
-> click badge
-> show the supporting source items used for that statement
```

A statement may have:

```text
1 source
multiple frontend sources
multiple backend sources
mixed frontend + backend sources
```

Each source item should expose:

```text
repository role
repository name
file path
line range
short source summary
snippet preview
source URL if available
```

This means the new architecture must preserve statement-to-evidence linkage all the way through:

```text
scanner evidence
-> page-level linkage
-> block/statement evidence ids
-> source badge count
-> source detail panel
```

The count must reflect the real evidence items attached to the statement, not only page-level evidence.

If one statement uses 3 evidence items, the badge should show `Source Code: 3`.

If a statement is updated in a later run:

```text
old evidence ids are remapped/replaced
badge count updates
source detail panel updates
manual overlays remain consistent where stable keys still match
```

### Phase 3: Page Graph Edges

Add explicit page relations.

Suggested table: `wiki_page_edges`

Minimum fields:

```text
id
generationRunId
fromPageKey
toPageKey
relationType
evidenceId nullable
sourceTaskId nullable
payloadJson
createdAt
```

Initial relation types:

```text
opens
uses_setting
affects
depends_on
related_to
```

Example:

```text
Admin Internal Payroll Item
-> affects
Payroll Vessel Monthly Detail
```

### Phase 4: Coverage Evaluator

Add a deterministic evaluator.

Inputs:

- all `code_facts` for the run;
- all `evidence` for the run;
- `code_maps.mapJson`;
- existing `wiki_page_evidence`;
- existing `wiki_page_edges`.

Output:

```text
coverageReportJson
new gap tasks
```

Basic rule:

```text
knownFacts = all code_facts
coveredFacts = facts linked to wiki pages
gaps = knownFacts - coveredFacts
```

Coverage should be disposition-aware:

```text
MUST_DOCUMENT -> must appear as a product story page or section.
SUPPORTING_EVIDENCE -> must support a page or be explicitly linked.
NO_WIKI_VALUE -> checked and excluded from product wiki.
NEEDS_REVIEW -> show in internal report.
IGNORED -> excluded by hard rule.
```

Scanned files with `NO_WIKI_VALUE` are excluded from wiki coverage gaps but remain visible in evaluator data.

### Phase 4B: Incremental New Tag Runs

When a new tag pair arrives, do not regenerate everything by default.

Flow:

```text
clone new commits
-> inventory/analyze
-> compare facts/evidence/code-map data with last completed run
-> identify affected pages
-> enqueue CREATE_PAGE/UPDATE_PAGE only for affected pages
-> reuse unchanged pages where input fingerprints still match
```

Changed files are not enough by themselves. The system should update pages affected by changed facts, evidence, and graph edges.

Example:

```text
Payroll formula changes
-> affected page: Payroll Monthly Detail
-> update only that page and any pages linked by relation rules
```

### Phase 5: Live UI

Replace the current run UI with a live visual debugger. The current basic status UI is not enough for this architecture.

The debugger is technical/operator-facing. It may show files, FE/BE labels, internal task names, evidence ids, graph edges, and validation details. This is separate from the user-facing wiki, which must stay product-story and non-technical.

Entry points:

```text
/workspace
  -> generation run card
  -> Open live debugger

/workspace/debugger?generationRunId=...
```

Debugger layout:

```text
┌──────────────────────────────────────────────────────────────┐
│ Run header: status, current phase, current task, coverage %   │
├──────────────────────────┬───────────────────────────────────┤
│ FE repo inventory        │ BE repo inventory                  │
│ priority counts/files    │ priority counts/files              │
├──────────────────────────┴───────────────────────────────────┤
│ Live traversal graph/tree                                     │
│ FE, BE, bridge, AI, evaluator nodes with status indicators    │
├──────────────────────────┬───────────────────────────────────┤
│ Selected task/file detail │ Timeline / event stream           │
└──────────────────────────┴───────────────────────────────────┘
```

Color/state language:

```text
FE nodes: blue/teal
BE nodes: amber/orange
Bridge edges: high-contrast connector
AI task: dark/purple pulse
Evaluator: green
Needs review: yellow
Failed: red
No wiki value: gray
```

Node status:

```text
empty circle = queued
spinner = running
check = done
x = failed
gray dot = no wiki value
warning = needs review
```

Minimum run metrics:

```text
Current task
Queued task count
Completed task count
Failed task count
FE scan %
BE scan %
Overall scan %
Must-document coverage %
Supporting-evidence coverage %
Pages: Draft / Expanding / Complete / Needs Review
Coverage gaps count
Latest events
No-wiki-value count
Needs-review count
```

Scan percentage must be disposition-aware:

```text
scan % = files with final scanStatus/disposition / eligible files
coverage % = covered MUST_DOCUMENT and attached SUPPORTING_EVIDENCE / required coverage items
```

Do not claim 100% coverage just because every file was visited. Coverage is based on required product-story coverage, not raw file count.

The wiki reader should be usable while generation is still running.

### Phase 5B: Live Debugger Event Stream

Use DB-backed events with polling or SSE. WebSocket is not required for v1.

Recommended endpoints:

```text
GET /api/generation-runs/:id/debug-events?after=...
GET /api/generation-runs/:id/tasks
GET /api/generation-runs/:id/file-inventory
GET /api/generation-runs/:id/debug-graph
GET /api/generation-runs/:id/coverage
```

Use SSE later if polling feels too coarse:

```text
GET /api/generation-runs/:id/debug-stream
```

Debug event types:

```text
INVENTORY_FILE_FOUND
FILE_PRIORITY_ASSIGNED
FILE_PRIORITY_PROMOTED
IMPORT_EDGE_FOUND
DEEP_SCAN_STARTED
DEEP_SCAN_DONE
FILE_DISPOSITIONED
BRIDGE_FOUND
TASK_QUEUED
TASK_STARTED
TASK_DONE
TASK_FAILED
AI_STARTED
AI_VALIDATION_STARTED
AI_VALIDATION_DONE
PAGE_CREATED
PAGE_UPDATED
COVERAGE_EVALUATED
```

Debug event payload must remain safe:

```text
generationRunId
taskId
phase
repositoryRole
filePath
pageKey
eventType
message
payloadJson
createdAt
```

Do not store raw prompts, raw provider responses, tokens, API keys, Authorization headers, or provider bodies in debugger events.

### Phase 5C: Visual Traversal Graph

The debugger should show branches as they are discovered.

Example:

```text
[FE] Payroll Page
 ├─ [FE] Search behavior
 │   ├─ [FE] usePayrollList
 │   └─ [BRIDGE] data/action call
 │       └─ [BE] Payroll vessel list
 │           ├─ [BE] permission/rule
 │           ├─ [BE] filter by search/principal
 │           └─ [BE] data source
 ├─ [FE] Row click
 │   └─ [FE] Vessel Period List
 │       └─ [FE] Month Detail
 └─ [AI] Update Payroll List page
```

Graph node shape:

```text
id
label
kind
repositoryRole nullable
status
priority nullable
disposition nullable
pageKey nullable
filePath nullable
taskId nullable
```

Graph edge shape:

```text
from
to
kind: imports | discovers | bridges | updates | affects | blocks | validates
status
```

Branching rules:

```text
If a task discovers 10 child branches, show all 10 branches.
If a branch is queued but not processed yet, keep it visible as queued.
If a branch is skipped as NO_WIKI_VALUE, keep it visible in gray.
If a branch is stopped by budget/depth, mark NEEDS_REVIEW.
If a branch creates or updates a page, link to that wiki page immediately.
```

### Phase 5D: File Priority Inspector

Users must be able to see why a file got its priority.

Example:

```text
src/app/payroll/page.tsx
Initial priority: P0
Current priority: P0
Reasons:
- page-like path
- product surface candidate
- imports PayrollTable
Status: DEEP_SCANNED
Disposition: MUST_DOCUMENT
```

Example:

```text
src/types/i18n.d.ts
Initial priority: P5
Current priority: P4
Reasons:
- type declaration
- imported by PayrollTable
Scan result:
- type-only support file
- no product behavior
Disposition: NO_WIKI_VALUE
```

### Phase 5E: AI Task Inspector

When AI is active, show exactly what kind of task is running without exposing raw prompts.

Example:

```text
AI is writing:
UPDATE_PAGE payroll.list

Context summary:
- existing page: Payroll List
- new evidence: search behavior
- product-story contract enabled
- banned technical terms enabled

Validation:
[ ] schema
[ ] evidence-backed claims
[ ] no technical terms
[ ] story completeness
[ ] persisted
```

After completion:

```text
[V] schema valid
[V] evidence-backed claims
[V] no technical terms
[V] story sections complete
[V] page updated
```

## Implementation Defaults

- Replace old full generation with the task queue path; do not keep unused fallback paths.
- Build the new pipeline beside the old one; do not reshape the new architecture around current `generateWiki`.
- Do not introduce a new service or project.
- Do not add a queue dependency in v1.
- Keep AI calls serial by default.
- Use existing validation and quality checks before every persist.
- Add a technical-term leak validator for user-facing wiki blocks.
- Prefer deterministic code-map/evidence decisions over AI-chosen traversal.
- Keep technical source/evidence detail available only in internal/debug views.
- Delete legacy code once its replacement is wired and tested.

## Acceptance Criteria

- A generation run can create a first page from one task.
- A later task can update that same `pageKey` without creating a duplicate page.
- A failed update does not remove previous valid content.
- Evidence/fact linkage is persisted per page.
- Coverage evaluator can identify at least one uncovered fact and enqueue a follow-up task.
- Existing manual overlays still survive generated page updates where stable keys match.
- User-facing wiki pages do not contain banned engineering terms.
- Files marked `NO_WIKI_VALUE` are counted as checked, not missing coverage.
- A new tag run reuses unchanged pages and updates only affected pages where possible.

## Recommended First Slice

Build the smallest useful version:

```text
1. Add generation_tasks.
2. Add wiki_page_evidence.
3. Add file priority/disposition records or a compact run-level report.
4. Seed three deterministic tasks from existing page groups.
5. Process CREATE_PAGE then UPDATE_PAGE serially.
6. Add product-story validator with banned technical terms.
7. Prove with Payroll-style tests:
   - page created;
   - same page updated;
   - invalid update preserves old page;
   - technical terms are rejected;
   - type-only supporting file becomes NO_WIKI_VALUE, not a coverage gap.
```

Skip graph edges and full coverage UI until this first slice is stable.

## Detailed Data Model

Use explicit tables for task state and coverage. Do not overload `generation_runs` with detailed branch progress.

### `generation_tasks`

Purpose: durable queue for discovery, scanning, writing, updating, and evaluation.

Fields:

```text
id
generationRunId
workspaceId
repositoryRole nullable
repositoryId nullable
taskType
status
priority
pageKey nullable
parentTaskId nullable
rootTaskId nullable
dedupeKey
reason
payloadJson
resultJson nullable
attempts
maxAttempts
errorMessage nullable
claimedAt nullable
startedAt nullable
finishedAt nullable
createdAt
updatedAt
```

Indexes/constraints:

```text
unique(generationRunId, dedupeKey)
index(generationRunId, status, priority, createdAt)
index(generationRunId, pageKey)
```

Task status:

```text
QUEUED
CLAIMED
RUNNING
SUCCEEDED
FAILED
SKIPPED
BLOCKED
```

Task types:

```text
INVENTORY_REPO
SHALLOW_CLASSIFY
BUILD_IMPORT_GRAPH
DEEP_SCAN_FILE
BUILD_CODE_MAP
DISCOVER_SURFACE
TRACE_BEHAVIOR
TRACE_CROSS_REPO
CREATE_PAGE
UPDATE_PAGE
EVALUATE_COVERAGE
MARK_NO_WIKI_VALUE
MARK_NEEDS_REVIEW
```

Payload rules:

- Store only safe structured data.
- Allowed: file path, repository role, page key, priority, evidence ids, fact ids, relation ids, branch state, sanitized error.
- Forbidden: raw prompts, raw provider responses, headers, tokens, API keys, Authorization values.

### `generation_file_inventory`

Purpose: durable file-level priority and disposition data.

Fields:

```text
id
generationRunId
repositoryRole
repositoryId
filePath
extension
sizeBytes
contentHash
initialPriority
currentPriority
scanStatus
disposition nullable
dispositionReason nullable
importedByJson
importsJson
signalsJson
createdAt
updatedAt
```

Scan status:

```text
INVENTORIED
SHALLOW_CLASSIFIED
PROMOTED_BY_IMPORT_GRAPH
QUEUED_FOR_DEEP_SCAN
DEEP_SCANNED
DISPOSITIONED
IGNORED
```

Disposition:

```text
MUST_DOCUMENT
SUPPORTING_EVIDENCE
NO_WIKI_VALUE
NEEDS_REVIEW
IGNORED
```

### `wiki_page_evidence`

Purpose: map source facts/evidence to user-facing wiki pages.

Fields:

```text
id
generationRunId
workspaceId
pageKey
evidenceId
factId nullable
sourceTaskId nullable
coverageRole
createdAt
```

Coverage role:

```text
PRIMARY
SUPPORTING
EXCLUDED_NO_WIKI_VALUE
NEEDS_REVIEW
```

### `wiki_page_edges`

Purpose: durable relation graph between product-story pages.

Fields:

```text
id
generationRunId
workspaceId
fromPageKey
toPageKey
relationType
evidenceId nullable
sourceTaskId nullable
payloadJson
createdAt
```

Relation types:

```text
opens
uses_setting
affects
depends_on
related_to
```

### `generation_coverage_reports`

Purpose: store evaluator output without bloating run status.

Fields:

```text
id
generationRunId
coverageJson
createdAt
```

Minimum coverage JSON:

```text
{
  "mustDocumentTotal": 0,
  "mustDocumentCovered": 0,
  "supportingTotal": 0,
  "supportingAttached": 0,
  "noWikiValueTotal": 0,
  "needsReviewTotal": 0,
  "gaps": [],
  "nextTaskIds": []
}
```

## Run-Level Status Model

Keep `generation_runs.status` coarse. Detailed progress belongs to `generation_tasks`.

Recommended run statuses:

```text
QUEUED
CLONING
CLONED
SCANNING
TASKING
COMPLETED
FAILED
AI_OUTPUT_INVALID
```

Status meaning:

- `QUEUED`: run exists but clone has not started.
- `CLONING`: repos are being checked out.
- `CLONED`: checkout finished.
- `SCANNING`: inventory, shallow classification, import graph, and initial deep scan are running.
- `TASKING`: task queue is processing discovery/write/update/evaluator work.
- `COMPLETED`: evaluator reports acceptable coverage and all blocking tasks are done.
- `FAILED`: infrastructure/provider/runtime failure.
- `AI_OUTPUT_INVALID`: AI output failed schema/product-story/quality validation and could not be repaired.

Do not add many run statuses for branch-level progress. Use task status and event logs.

## Task Processing Algorithm

Pseudo-flow:

```text
runFullGeneration(generationRunId):
  clone both repos
  create INVENTORY_REPO tasks for both repos
  while true:
    task = claim next queued task by priority and createdAt
    if no task:
      enqueue EVALUATE_COVERAGE if evaluator not final
      if evaluator final and no blocking tasks: mark run completed
      break

    process task
    persist events and result
    enqueue children from deterministic result
```

Claiming rules:

- Claim one task at a time in v1.
- Claim must be atomic.
- Skip duplicate tasks through `dedupeKey`.
- Never run two `CREATE_PAGE`/`UPDATE_PAGE` tasks for the same `pageKey` at the same time.

Dedupe key examples:

```text
inventory:FRONTEND
shallow:FRONTEND
import-graph:FRONTEND
deep-scan:FRONTEND:src/app/payroll/page.tsx
trace-behavior:payroll.list:search
trace-cross-repo:payroll.list:GET:/payroll/vessels
create-page:payroll.list
update-page:payroll.list:search-flow
evaluate-coverage:v1
```

## File Priority Details

Priority is a working order, not a truth label.

Use rules first. A scoring model is optional later.

Initial priority rules:

```text
P0:
  app/page, pages, routes, screen entry, app shell, main app entry, menu/sidebar navigation config

P1:
  visible feature surface, table, drawer, modal, tabbed detail, page-level container

P2:
  search, filter, submit, row click, button action, wizard step, import/export, recalculate, approve/reject, upload

P3:
  data loading, data saving, validation path, calculation, permission condition, domain rule

P4:
  constants, formatter, config, helper, domain type, shared utility used by active flow

P5:
  type declaration, style/theme, storybook, test, mock, generated declarations

P6:
  dependency folders, build output, caches, binary/static assets, lock noise
```

Promotion rules:

```text
Imported by P0 -> promote at least to P2/P3/P4 depending on content.
Imported by P1 -> promote at least to P3/P4 depending on content.
Contains user-visible interaction -> promote to P2.
Contains business rule/calculation/default/non-removable condition -> promote to P2/P3.
Contains data loading/saving connected to active surface -> promote to P3.
Contains only type declarations with no product behavior -> keep/support as P4/P5 and mark NO_WIKI_VALUE after scan.
Referenced only by infra/logging/style -> do not promote for product docs.
```

Demotion/disposition rules:

```text
No product behavior after scan -> NO_WIKI_VALUE.
Generic infra/logging/wrapper -> NO_WIKI_VALUE or SUPPORTING_EVIDENCE only if user-visible behavior depends on it.
Hard ignored path -> IGNORED.
Ambiguous or budget-exhausted branch -> NEEDS_REVIEW.
```

## Import Graph Rules

Import graph is file-to-file. It does not decide product meaning.

Responsibilities:

- resolve relative imports;
- resolve configured path aliases where available;
- record import direction;
- record type-only imports separately when detectable;
- identify reachable files from P0/P1/P2 roots;
- promote files that are reachable from active product surfaces.

Do not require perfect framework detection. Use generic import/reachability first and small framework hints second.

Framework hints are shortcuts only:

```text
Next app/pages routes
React Router config
Remix routes
generic React main/App/router/menu
```

Unknown framework fallback:

```text
main entry files
import graph roots
navigation/menu strings
visible interaction signals
data/action call signals
fact density
```

## Deep Scan Rules

Deep scan extracts deterministic facts and evidence. It does not write wiki prose.

Deep scan should look for:

```text
visible screen/page purpose
user actions
tables and columns
tabs/drawers/modals
forms and validation
empty/error states
permissions or conditions
calculations and defaults
data loading/saving behavior
related settings/configurations
cross-repo bridge signals
```

Deep scan outputs:

```text
code_facts
evidence
file priority updates
file disposition
child tasks
```

Deep scan can change priority. Example:

```text
src/lib/payroll-utils.ts
initial P4
deep scan finds payroll calculation rule
promote to P2/P3
attach as SUPPORTING_EVIDENCE to Payroll Monthly Detail
```

## Cross-Repo Traversal

FE and BE are inventoried separately. They are connected only by bridge signals.

Strong bridge signals:

```text
data/action call path
shared action name
shared domain term
shared payload shape
same feature namespace
```

Cross-repo task example:

```text
TRACE_BEHAVIOR payroll.list.search
-> finds data/action call
-> enqueue TRACE_CROSS_REPO payroll.list.search.source
-> trace backend branch until product-relevant behavior is understood
-> enqueue UPDATE_PAGE payroll.list
```

Backend branch target:

```text
entry/action
permission/condition
validation
business rule
calculation
data source
empty/error result
```

Backend branch stop conditions:

```text
generic logging
metrics
connection setup
framework boilerplate
unrelated helper
already visited branch
budget/depth exhausted
```

Backend-only findings:

```text
If no product page/surface is known, mark NEEDS_FRONTEND_ANCHOR.
Do not create user-facing pages from backend-only facts unless a product anchor is found.
```

## AI Usage Boundary

AI is only used to produce or repair product-story wiki output.

Allowed AI task types:

```text
CREATE_PAGE
UPDATE_PAGE
REPAIR_INVALID_OUTPUT
```

Not allowed for AI:

```text
choosing important files
deciding coverage is complete
deciding evidence is valid
creating task branches without deterministic evidence
marking a technical file as no-wiki-value without scanner proof
```

AI input should contain:

```text
pageKey
page title
existing page content for updates
selected facts
selected evidence summaries
related page context
product-story contract
banned technical terms
required output schema
```

AI output must be validated before persistence.

## Product-Story Page Contract

Every page should read like a complete feature story.

Default page skeleton:

```text
Title
Purpose
Where users start
What users see
Main flow
Available actions
Rules and conditions
Related settings
Results after action
Empty states and errors
Related features
Open questions
```

Page type examples:

```text
List page:
  purpose, filters, search, table meaning, row actions, pagination, empty result.

Detail page:
  selected item context, visible sections, editable values, actions, related settings, outcome.

Modal/drawer:
  why it opens, what it shows, available selection/action, what happens after close/selection.

Config/settings page:
  what setting controls, who uses it, what features it affects, rules/defaults/non-removable values.

Action page/flow:
  trigger, required inputs, confirmation, result, failure/empty conditions, related downstream effects.
```

Do not expose implementation shape. Translate internal facts into user-visible behavior.

## Product-Story Quality Gate

Reject or repair generated wiki output when:

```text
schema invalid
page missing required story sections
important behavior has no supporting evidence
page is too short for available evidence
output contains banned technical terms
output says "API", "endpoint", "handler", "SQL", or similar implementation detail
update appends random disconnected text
output invents behavior not present in evidence
output creates a duplicate page for a parameter value
```

Warning-only cases:

```text
some related settings are unknown
evidence is partial but page clearly says open question
branch stopped by budget and is marked NEEDS_REVIEW
```

Hard fail cases:

```text
invalid schema after repair
technical terms remain after repair
claims cannot be tied to evidence
AI output removes existing valid page content without replacement reason
```

Do not allow a statement that requires evidence to lose its source linkage during update. If the evidence set becomes invalid, the statement must fail validation or be marked for repair.

## Page Upsert Rules

Page identity:

```text
workspaceId + pageKey
```

Do not create separate pages for parameter values:

```text
wrong: Vessel Bonus June 2026
right: Payroll Vessel Monthly Detail with month as parameter
```

Update behavior:

```text
load existing page by pageKey
provide existing content to AI
provide new facts/evidence
validate full updated page
replace generated blocks only after valid output
preserve previous valid page if update fails
preserve manual overlays where stable keys still match
record page evidence links
preserve block-level evidence ids for source badges
```

Duplicate prevention:

```text
unique(workspaceId, pageKey)
task dedupeKey for create/update page
visited set for traversal branches
```

## Evaluator Details

Evaluator runs after task batches or when the queue is empty.

Evaluator input:

```text
generation file inventory
code_facts
evidence
code map
wiki_page_evidence
wiki_page_edges
task history
```

Evaluator output:

```text
coverage report
new tasks
needs-review items
no-wiki-value counts
completion decision
```

Completion requires:

```text
all MUST_DOCUMENT items are covered
all required SUPPORTING_EVIDENCE is attached or explicitly excluded
NO_WIKI_VALUE items have reasons
NEEDS_REVIEW is below accepted threshold or surfaced to UI
no blocking queued/running tasks remain
no failed required page update remains unresolved
```

Evaluator must not trust AI self-assessment. It uses deterministic links and dispositions.

## New Tag Incremental Rules

New tag run should compare against the latest completed run for the same workspace/repo pair.

Reuse candidates:

```text
same pageKey
same page input fingerprint
same or remappable evidence fingerprints
same product-story contract version
previous page passed quality gate
```

Update candidates:

```text
changed facts attached to a page
changed evidence attached to a page
changed code-map edge linked to a page
changed relation such as uses_setting/affects
new MUST_DOCUMENT item
previous NEEDS_REVIEW item now has enough evidence
```

Delete/retire candidates:

```text
pageKey no longer has any source surface
feature removed from code
relation removed and no remaining evidence supports it
```

Do not silently delete generated pages on a new run. Mark removed/retired behavior explicitly in internal report first, then apply the chosen product policy.

## UI Requirements

Workspace UI should show the run as a live process.

Replace the current minimal run panel with a debugger-first run panel.

Minimum run panel:

```text
run status
current task
task counts by status
current page being created/updated
coverage summary
scan percentage
needs-review count
no-wiki-value count
failed task list
latest sanitized events
links to generated pages
open live debugger button
```

Wiki UI:

```text
show partial pages while generation continues
show page status: Draft / Expanding / Complete / Needs Review
do not show technical implementation prose in main wiki
source/evidence details may be hidden behind developer/internal panel
keep statement-level source badges such as "Source Code: N"
clicking a source badge opens source detail for that statement
```

Editor integration requirement:

```text
If the redesign touches Tiptap custom nodes, inline source badges, source drawers, or editor rendering behavior, reading the relevant Tiptap docs via Context7 is mandatory before editing.
```

## Deletion And Cleanup

Deleting a generation run should delete generated data for that run while preserving repository records.

Delete:

```text
generation_tasks
generation_file_inventory
generation_coverage_reports
wiki_page_evidence for run
wiki_page_edges for run
wiki pages/blocks generated by run if no newer run owns them
run events
facts/evidence/code maps/summaries for run
generation run row
```

Preserve:

```text
repositories
installations
workspace
manual overlays unless their target generated block is deleted by explicit policy
```

## Migration Strategy

This is a replacement, not a compatibility layer.

Order:

```text
1. Add new tables.
2. Add new self-expanding generation module.
3. Wire worker command to new module.
4. Replace old full generation route/command behavior.
5. Delete unused legacy generation code after tests pass.
```

Avoid:

```text
mixing old and new orchestration in one giant function
adding fallback paths that nobody tests
keeping dead legacy branches
changing unrelated GitHub pairing/clone/auth/editor code
```

## Test Matrix

Unit tests:

```text
file inventory ignores noise
shallow priority assigns expected P0-P6
import graph promotes reachable files
type-only file becomes NO_WIKI_VALUE
deep scan promotes business-rule helper
cross-repo bridge creates TRACE_CROSS_REPO task
backend-only finding becomes NEEDS_FRONTEND_ANCHOR
task dedupe prevents duplicate branch/page task
page upsert updates same pageKey
invalid update preserves previous page
technical-term validator rejects user-facing prose
coverage evaluator excludes NO_WIKI_VALUE and catches missing MUST_DOCUMENT
new tag reuses unchanged page and updates affected page
statement with multiple FE/BE evidence items shows correct source count
statement update preserves or remaps block evidence ids
```

Integration tests:

```text
Payroll List create page
Payroll Search update page
Payroll Monthly Detail receives related setting update from Admin Internal Payroll Item
BE branch traces to product rule and updates product story without technical terms
queue resumes after worker restart
failed AI output marks task failed/AI_OUTPUT_INVALID and preserves valid pages
delete generation removes run-scoped generated data
debugger endpoints return safe event/task/inventory/graph data
debugger scan percentage is disposition-aware
AI task inspector never exposes raw prompt/provider body
source badge click resolves the correct multi-source statement evidence list
```

Verification commands:

```text
pnpm -r typecheck
pnpm test
targeted worker/analyzer/web tests for each phase
```

## Non-Negotiables

- The docs are product stories, not engineering docs.
- AI does not choose files.
- AI does not decide coverage completion.
- Technical evidence stays internal.
- File priority is dynamic.
- Low priority means delayed, not discarded.
- `NO_WIKI_VALUE` means checked and intentionally excluded.
- FE and BE inventories stay separate; bridge only with evidence.
- Backend-only facts need product anchors.
- New tag runs are incremental by affected pages.
- Old full generation code should be replaced and deleted when unused.
- Do not preserve untested fallback paths.
- The live debugger must show inventory, priority, traversal, AI, evaluator, scan %, and coverage state.
- The debugger may be technical; the generated wiki must not be technical.
- Statement-level source badges and multi-source evidence panels must keep working across the new architecture.
