# Recursive Product Discovery Architecture

This document is a handover note for the next session. It captures the intended fix for making generated wiki pages grow like a product-knowledge tree instead of only generating one page per surface.

## Problem

The current self-expanding generation flow already has a task graph:

```text
DISCOVER_SURFACE
-> TRACE_BEHAVIOR
-> CREATE_PAGE / UPDATE_PAGE
-> EVALUATE_COVERAGE
```

This is useful, but it is still shallow. It starts from frontend surfaces and writes or updates a page for the derived `pageKey`. It can also use coverage evaluation to queue more page writes for uncovered evidence.

What it does not yet do well:

- enter a surface or file and discover related product concepts;
- follow proven relationships into related files/modules;
- decide whether a discovered concept should create a new page or update an existing page;
- grow pages such as Payroll, Contract, Vessel Assignment, Cut Off, Salary Component, and Export as a connected product wiki;
- explain internal modules with the richer internal-team template discussed in this session.

The desired behavior is not "AI reads the whole repo and invents a wiki tree". The desired behavior is bounded recursive discovery from evidence.

## Target Model

The target engine should work like this:

```text
scan repo
-> extract facts/evidence
-> build code map and summaries
-> seed frontend/product anchors
-> derive product concepts from evidence
-> match each concept to a page
-> create or update that page
-> evaluate uncovered evidence
-> repeat until depth limit or no useful evidence remains
```

For v1, use deterministic discovery first:

```text
maxDepth = 2
AI writes pages only from selected evidence
AI does not decide traversal
```

Allowed sources for product concepts:

- UI labels, placeholders, button text, and visible navigation;
- form field names and IDs;
- request payload keys and API paths;
- backend handler, service, validation, auth, error, and schema evidence;
- code-map edges such as form field, API call, handler, schema, and navigation relationships;
- existing facts and evidence summaries.

Forbidden:

- creating a concept only because the model "knows" a domain;
- inferring behavior from file names alone;
- creating backend-only pages without a frontend/product anchor unless marked `NEEDS_REVIEW`;
- silently dropping meaningful evidence.

## Example

If the scanner sees evidence like:

```tsx
<label>Cut Off Period</label>
<Select name="vesselId" />
<Button>Export Payroll</Button>
fetch("/api/payroll/recalculate", {
  body: JSON.stringify({ cutOffPeriodId, vesselId })
})
```

The concept extractor may derive:

```text
cut-off-period
vessel
export-payroll
payroll-recalculation
```

Each derived concept must carry evidence IDs and source reasons, for example:

```text
cut-off-period:
  evidence: UI label + request payload key

vessel:
  evidence: field name vesselId + request payload key

export-payroll:
  evidence: visible button text
```

Then the page matcher decides:

```text
existing matching page -> UPDATE_PAGE
strong new concept -> CREATE_PAGE
ambiguous concept -> NEEDS_REVIEW
low product value -> EXCLUDED_NO_WIKI_VALUE
```

The intended tree can become:

```text
payroll.monthly
-> payroll.cut-off-period
-> vessel
-> payroll.export
-> payroll-recalculation
```

If a page already exists, the system should update that page and attach the new evidence instead of creating a duplicate.

## Coverage Semantics

There are two different coverage concepts.

Scan coverage is file-level:

```text
frontendTotalEligibleFiles
frontendIndexedEligibleFiles
backendTotalEligibleFiles
backendIndexedEligibleFiles
```

Wiki coverage is evidence-level:

```text
evidence.filePath
evidence.startLine
evidence.endLine
evidence.codeSnippet
evidence.summary
```

The wiki should not treat "file was scanned" as "product behavior was covered". A file can contain many snippets and only some snippets may be meaningful product evidence.

Every meaningful evidence item should end in exactly one of these terminal states:

```text
PRIMARY on a wiki page
SUPPORTING on a wiki page
queued for CREATE_PAGE / UPDATE_PAGE
NEEDS_REVIEW
EXCLUDED_NO_WIKI_VALUE
```

`uncovered` means the scanner found a fact/evidence snippet, but that snippet has not yet been attached to a page and has not been marked as review/ignored.

Uncovered evidence should never disappear silently.

## Seed/Root Scope Warning

Scoped scans must use deterministic seed/root paths, not keyword filters.

Examples:

```text
CODE2WIKI_FRONTEND_SCAN_ROOTS=src/app/(home)/payroll
CODE2WIKI_BACKEND_SCAN_ROOTS=internal/handler/gin/route,internal/handler/gin/payroll
CODE2WIKI_FRONTEND_SCAN_MAX_FILES=40
CODE2WIKI_BACKEND_SCAN_MAX_FILES=20
```

With those env vars set, the scanner only includes files under the allowed roots. Product expansion may still happen later, but every expansion must be justified by a parent file and a concrete relation such as navigation, import, or matched endpoint.

Important consequence:

```text
Files outside the active scan roots cannot become uncovered evidence,
because the system never saw them.
```

For full wiki generation, leave scan roots and max file caps unset.

For scoped debugging, surface a warning:

```text
SCAN_ROOTS_ACTIVE: generation is scoped and coverage is not full-repository coverage.
SCAN_MAX_FILES_ACTIVE: generation is capped and coverage is not full-repository coverage.
```

## Proposed Implementation

Add a product concept layer between analyzer output and page writing.

Minimum pieces:

```text
concept-extractor
concept-normalizer
page-matcher
DISCOVER_RELATED_CONCEPTS task
depth/dedupe guard
coverage warning for scoped scans
```

Suggested v1 task flow:

```text
DISCOVER_SURFACE
-> TRACE_BEHAVIOR
-> DISCOVER_RELATED_CONCEPTS
-> CREATE_PAGE / UPDATE_PAGE
-> EVALUATE_COVERAGE
-> repeat queued related tasks until maxDepth = 2
```

Use existing `generation_tasks` fields:

```text
parentTaskId
rootTaskId
pageKey
dedupeKey
payloadJson
resultJson
branchState
```

Do not add a new DB table for v1 unless `payloadJson` becomes too hard to inspect.

Example task payload:

```json
{
  "depth": 1,
  "sourcePageKey": "payroll.monthly",
  "conceptKey": "cut-off-period",
  "conceptLabel": "Cut Off Period",
  "evidenceIds": ["ev_1", "ev_2"],
  "reason": "UI label and request payload key"
}
```

Suggested dedupe keys:

```text
discover-related:{rootTaskId}:{conceptKey}:depth-{depth}
create-page:{pageKey}
update-page:{pageKey}
```

## Product Wiki Writing Contract

The recursive discovery layer decides which page should be created or updated. The AI writer only writes from the selected facts/evidence.

The page should read as internal product knowledge, not code documentation.

Preferred module template:

```text
Ringkasan
Siapa Yang Menggunakan Modul Ini
Kapan Modul Ini Digunakan
Konsep Penting
Data Yang Dikelola
Alur Kerja Utama
Hubungan Dengan Modul Lain
Aturan Bisnis
Contoh Penggunaan
Hal Yang Sering Membingungkan
Yang Perlu Dicek Jika Ada Masalah
Catatan Internal
```

`Ringkasan` may be a 2-4 paragraph story, but it must stay evidence-backed. The rest of the page should make the module scannable for internal teams and onboarding staff.

## Quality Gate Direction

Prompt-only is not enough. The system should use both prompt and gate:

- prompt asks for internal-module product-story pages;
- quality validator rejects or repairs thin pages when enough evidence exists;
- repair prompt receives quality errors and fixes structure without adding unsupported claims;
- if evidence is weak, the output should use `open_question` or `NEEDS_REVIEW` rather than inventing behavior.

The existing writer already supports one repair call after invalid output or `FAIL` quality gate. Keep that pattern first; do not add unbounded retries.

## Risks And Guards

Risk: recursive discovery misses backend-only behavior.

Guard:

```text
EVALUATE_COVERAGE remains mandatory.
Backend-only meaningful evidence becomes NEEDS_REVIEW unless attachable to an existing frontend/product page.
```

Risk: concept duplicates.

Guard:

```text
Normalize salaryComponentId, salary_components, and Salary Component to salary-component.
Dedupe by conceptKey + pageKey.
```

Risk: infinite expansion.

Guard:

```text
maxDepth = 2 for v1.
Do not expand concepts already processed in the same root branch.
```

Risk: scoped scan looks complete.

Guard:

```text
Warn loudly when scan roots or max file caps are active.
Do not present scoped coverage as full-repository coverage.
```

## Tests To Add

Analyzer tests:

- derives concepts from label, field name, button text, API path, and payload keys;
- normalizes common naming variants to one concept key;
- rejects low-value implementation-only concepts;
- preserves evidence IDs for each concept.

Worker tests:

- `TRACE_BEHAVIOR` queues `DISCOVER_RELATED_CONCEPTS`;
- related concepts queue `CREATE_PAGE` or `UPDATE_PAGE`;
- existing pages are updated instead of duplicated;
- depth 2 stops expansion;
- duplicate concept/page tasks are deduped;
- backend-only unanchored concepts become `NEEDS_REVIEW`;
- scoped scan emits a visible warning when scan roots or max file caps are active.

Quality tests:

- page with full internal-module sections passes;
- thin page with substantial evidence fails or enters repair;
- weak evidence can produce open questions without failing as invented behavior.

## Current Decision Defaults

Use these defaults unless the user changes direction:

```text
discoveryMode = deterministic-first
maxDepth = 2
AI traversal = disabled
AI writing = enabled, evidence-only
scanRootScope = optional, warning when active
coverageInvariant = every meaningful evidence reaches a terminal coverage state
```
