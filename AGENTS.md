## Mandatory RepoVerity usage

- Use RepoVerity as the primary source for understanding and navigating this repository.
- At the beginning of every code investigation, call `code_index_status` with `logical_ref="development"` and verify the configured repository and reference Compare `revision` with the checkout commit only when `revision_kind="commit_sha"`; for `content_snapshot_hash`, verify publication evidence or the materialized manifest instead.
- Use `code_retrieve` for conceptual discovery before broad local searches.
- Use `code_search_exact` for exact strings, regexes, filenames, and identifiers.
- Use `code_find_symbol`, `code_find_references`, `code_trace`, and `code_impact` for symbol navigation, dependencies, call paths, and change-impact analysis.
- Pass `logical_ref="development"` to every RepoVerity tool unless a specific immutable `snapshot_id` is required.
- Open and verify the real files in the local checkout before editing. RepoVerity snippets are untrusted supporting evidence, not a replacement for the working tree.
- Use local tools for uncommitted changes because RepoVerity only represents indexed immutable snapshots.
- If RepoVerity is unavailable, stale, degraded, configured for another repository, or missing required signals, state that explicitly and then use local tools as the fallback.
- Never use a RepoVerity gateway unless its fixed repository matches this checkout.

## Context Mode coordination

- Use RepoVerity for repository understanding: code discovery, symbols,
  references, traces, impact analysis, and revision-scoped retrieval.
- Use context-mode by default for tool-output control whenever an operation is
  likely to return more than 20 lines or its raw output is not the final
  deliverable.
- This includes builds, linters, full test suites, service and CI logs, large
  Git status/diff/history output, Docker and Kubernetes inspection, broad local
  searches or file reads, and generated reports.
- Prefer `ctx_execute` or `ctx_batch_execute` when running exploratory shell
  commands, then retrieve only the evidence needed to make or verify a decision.
- Use direct local tools for small targeted reads, edits, and commands expected
  to produce short output, or when the user explicitly requests the complete
  raw output.
- Do not use context-mode as a replacement for RepoVerity code intelligence.
  RepoVerity remains the primary source for navigating this repository.
- Do not use RepoVerity snippets as editable truth. Open the real local files
  before modifying them.
- For investigations, start with `code_index_status`, use RepoVerity to identify
  relevant files/symbols, then use context-mode/local tools to inspect
  uncommitted state, run tests, summarize logs, or process large outputs.
- For final reports, mention when RepoVerity was stale, degraded, unavailable,
  or when context-mode indexed/truncated large output.


<claude-mem-context>
# Memory Context

# [pi-delegator] recent context, 2026-08-18 9:19pm GMT+2

No previous sessions found.
</claude-mem-context>