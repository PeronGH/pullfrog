// changes to mode definitions should be reflected in docs/modes.mdx
import { type AgentId, formatMcpToolRef, pullfrogMcpName } from "./external.ts";

export interface Mode {
  name: string;
  description: string;
  // step-by-step guidance returned when the agent calls select_mode.
  // custom user-defined modes supply this; built-in modes define it here.
  prompt?: string | undefined;
}

export const PR_SUMMARY_FORMAT = `### Default format

Follow this structure exactly:

<b>TL;DR</b> — 1-3 sentences on what the PR does and why. Focus on intent, not mechanics.
NOTE: use HTML bold <b>TL;DR</b>, NOT markdown bold **TL;DR**.

### Key changes

- **Short human-readable title** — 1 sentence per change. Write a short prose phrase (title case or sentence case); when you name a file, type, or function, put that name in backticks (e.g. **Add \`TodoTracker\` for live checklists**). A reviewer should understand the full PR from this list alone.

<sub><b>Summary</b> ｜ {file_count} files ｜ {commit_count} commits ｜ base: \`{base}\` ← \`{head}\`</sub>
NOTE: the metadata line goes AFTER the bullet list, not before it.

Then for each key change, a ## section with a short descriptive title that reads like a documentation heading (e.g. ## Live todo checklist tracking).

<br/>

## Example readable section title

> **Before:** [old behavior/state]<br/>**After:** [new behavior/state]
IMPORTANT: Before and After MUST be on a SINGLE blockquote line with an inline <br/> between them. Two separate \`>\` lines creates a double line break.

1-2 sentences of explanation. Break up text with tables, blockquotes, or lists — NEVER 3+ plain paragraphs in a row.

If a change warrants deeper explanation, use a blockquoted details/summary framed as a question:
> <details><summary>How does X work?</summary>
> Extended explanation here.
> </details>

End each section with a file links trail (3-4 key files max):
[\`file.ts\`](https://github.com/{owner}/{repo}/pull/{number}/files#diff-{sha256hex_of_filepath}) · ...

Single-feature PRs: skip the ## sections. Fold before/after and explanation into the header after key changes.

CRITICAL — GitHub markdown rendering rule:
GitHub's markdown parser requires a blank line between ALL block-level elements. This includes transitions between: HTML tags (<br/>, <sub>, <details>, <b>, etc.) and markdown syntax (headings, lists, blockquotes, paragraphs). Without a blank line, GitHub treats the following content as a continuation of the HTML block and renders markdown syntax as literal text. ALWAYS separate block-level elements with a blank line.

Rules:
- \`##\` titles and key-change bullet lead-ins are plain-language summaries; backtick only actual code tokens (files, types, functions) where they appear in the title
- ALL variable names, identifiers, and file names in body text must be in backticks
- ALL file references MUST link to the PR Files Changed view. Use the \`diff-<hex>\` anchor precomputed next to each filename in the \`checkout_pr\` TOC — do NOT run \`sha256sum\` or any other shell command to compute anchors. NEVER fabricate hex strings. If a file is not in the TOC, omit the \`#diff-\` anchor rather than guessing.
- Add <br/> before each ## heading for visual spacing. Do NOT use horizontal rules (---)
- Do NOT include raw diff stats like '+123 / -45' or line counts
- Do NOT include code blocks or repeat diff contents
- Do NOT include a changelog section — the key changes list serves this purpose
- Focus on *intent*, not *what* — the diff already shows what changed
- Get the file count and commit count from the checkout_pr metadata, not by counting manually`;

function learningsStep(t: (toolName: string) => string, n: number): string {
  return `${n}. **learnings** (only if high confidence): if you discovered something about repo setup, test commands, conventions, or patterns that you are confident is correct and would reliably help future runs, call \`${t("update_learnings")}\` to persist it. skip this step if you are unsure or the finding is speculative/one-off. format as a flat bullet list (\`- \` per line, one fact per bullet). merge with existing learnings from the prompt — pass the FULL merged list. deduplicate, and drop bullets that are clearly wrong or no longer relevant to the current codebase.`;
}

export function computeModes(agentId: AgentId): Mode[] {
  const t = (toolName: string) => formatMcpToolRef(agentId, toolName);
  return [
    {
      name: "Build",
      description:
        "Implement, build, create, or develop code changes; make specific changes to files or features; execute a plan; or handle tasks with specific implementation details",
      prompt: `### Checklist

1. **plan** (optional, for complex tasks): analyze requirements, read AGENTS.md and relevant code, produce a step-by-step implementation plan.

2. **setup**: checkout or create the branch:
   - **PR event, modifying the existing PR**: call \`${t("checkout_pr")}\`
   - **new branch**: use \`${t("git")}\` to create a branch (\`git checkout -b pullfrog/branch-name\`)

3. **build**: implement changes using your native file and shell tools:
   - follow the plan (if you ran a plan phase)
   - plan your approach before writing code: identify which files need to change, key design decisions, and edge cases. for non-trivial changes, consider whether there's a more elegant approach.
   - run relevant tests/lints before committing

4. **self-review**: delegate a read-only subagent to review your diff. the subagent must ONLY read files, grep, and search — no MCP tools, no writes, no shell commands, no side effects. provide it with the output of \`git diff\` and instruct it to look for bugs, logic errors, missing edge cases, and unintended changes. review its findings, address any valid points, and discard nitpicks or false positives. then:
   - verify only intended changes are present, no debug artifacts or commented-out code remain, and no unrelated files were modified
   - commit locally via shell (\`git add . && git commit -m "..."\`)

5. **finalize**:
   - confirm a clean working tree, then push via \`${t("push_branch")}\` (see *SYSTEM* Git rules if this fails — prepush errors are usually the repo's tests/lint, not infra timeouts)
   - create a PR via \`${t("create_pull_request")}\`
   - call \`${t("report_progress")}\` with the PR link or the exact error if push/PR failed

${learningsStep(t, 6)}

### Notes

For simple, well-defined tasks, skip the plan phase and go straight to build.`,
    },
    {
      name: "AddressReviews",
      description:
        "Address PR review feedback; respond to reviewer comments; make requested changes to an existing PR",
      prompt: `### Checklist

1. Checkout the PR branch via \`${t("checkout_pr")}\`.

2. Fetch review comments via \`${t("get_review_comments")}\`.

3. For each comment:
   - understand the feedback
   - make the code change using your native tools
   - record what was done

4. Quality check:
   - test changes, then review the diff before committing — verify only intended changes are present, no debug artifacts remain, and the changes are clean enough that a senior engineer would approve without hesitation
   - commit locally via shell (\`git add . && git commit -m "..."\`)

5. Finalize:
   - confirm a clean working tree, then push via \`${t("push_branch")}\` (same push/prepush guidance as Build mode in *SYSTEM*)
   - reply to each comment using \`${t("reply_to_review_comment")}\`
   - resolve addressed threads via \`${t("resolve_review_thread")}\`
   - call \`${t("report_progress")}\` with a brief summary (or the exact push error if push failed)

${learningsStep(t, 6)}`,
    },
    {
      name: "Review",
      description:
        "Review code, PRs, or implementations; provide feedback or suggestions; identify issues; or check code quality, style, and correctness",
      prompt: `### Checklist

1. Checkout the PR via \`${t("checkout_pr")}\` — this returns PR metadata and a \`diffPath\`. read the diff TOC first and treat its file line ranges as your coverage checklist.

2. For each area of change:
   - read the diff and trace data flow, check boundaries, and verify assumptions
   - plan your investigation: identify the highest-risk areas (tricky state transitions, boundary crossings, assumption chains) and prioritize depth over breadth
   - use \`${t("get_pull_request")}\` and other read-only GitHub tools for additional context
   - if the PR removes features, deletes exports, renames identifiers, or changes architectural patterns, run a dedicated impact analysis: list what changed, then use grep across code, tests, docs (\`docs/\`, \`wiki/\`), comments, configs, and UI to find stale references
   - report impact-analysis findings in the summary body, ordered by severity (runtime breakage > incorrect docs > stale comments)
   - draft inline comments with NEW line numbers from the diff — every comment must be actionable (2-3 sentences max)
   - use GitHub permalink format for code references
   - for large or cross-cutting PRs that touch disparate subsystems, consider delegating read-only subagents to investigate areas in parallel. subagents must ONLY read files, grep, and search — no MCP tools, no writes, no shell commands, no side effects. collect their findings and use them to draft comments.

3. Self-critique: review all drafted comments and drop any that are praise, style preferences, speculative/unverified claims, about pre-existing code unrelated to the PR, or not actionable.

4. Submit — ALWAYS submit exactly one review via \`${t("create_pull_request_review")}\`.
   Do NOT call \`report_progress\` — the review is the final record and the progress
   comment will be cleaned up automatically.
   note: the first create_pull_request_review submission may error with a one-time diff-coverage nudge listing unread TOC regions. retry the same call to proceed — optionally after reading the listed ranges. the pre-flight will not block again this session.

   - **critical issues** (blocks merge — bugs, security, data loss):
     \`approved: false\`. Body begins with a GitHub alert blockquote, e.g.:
     \`> [!CAUTION]\\n> This PR introduces a race condition in ...\`
     Follow with a brief summary if needed. Include all inline comments.
   - **recommended changes** (non-critical):
     \`approved: false\`. Body begins with a GitHub alert blockquote, e.g.:
     \`> [!IMPORTANT]\\n> Consider adding input validation for ...\`
     Follow with a brief summary if needed. Include all inline comments.
   - **no actionable issues**:
     \`approved: true\`, body: "Reviewed — no issues found."`,
    },
    {
      name: "IncrementalReview",
      description:
        "Re-review a PR after new commits are pushed; focus on new changes since the last review",
      prompt: `### Checklist

1. Checkout the PR via \`${t("checkout_pr")}\` — this returns PR metadata, \`diffPath\` (full diff), and \`incrementalDiffPath\` (changes since last reviewed version, if available). read the diff TOC first and use its line ranges as your coverage checklist.

2. If \`incrementalDiffPath\` is present, read it to see what changed since the last review. This is a range-diff that isolates the net changes, filtering out base branch noise. If not present, fall back to reviewing the full PR diff.

3. Fetch previous reviews via \`${t("list_pull_request_reviews")}\`. For the most recent Pullfrog review, call \`${t("get_review_comments")}\` with the review ID to retrieve specific prior line-level feedback.

4. For each area of the new changes:
   - review the incremental diff while using the full diff for context
   - check whether prior review feedback was addressed by the new commits
   - trace data flow, check boundaries, verify assumptions, consider lifecycle, spot performance issues
   - if the new commits remove, rename, or deprecate anything, run impact analysis with grep across code/tests/docs/comments/configs to find stale references and include those findings in the summary body
   - never repeat prior feedback. only comment on genuinely new issues introduced by the new commits.
   - draft inline comments with NEW line numbers from the full PR diff — every comment must be actionable (2-3 sentences max)
   - for large or cross-cutting PRs, consider delegating read-only subagents for parallel investigation. subagents must ONLY read files, grep, and search — no MCP tools, no writes, no shell commands, no side effects. collect their findings and use them to draft comments.

5. Self-critique: drop any comments that are praise, style preferences, speculative, about pre-existing code, or not actionable.

6. **Summarize**: build two distinct sections for the review body:
   a. **Reviewed changes**: summarize at the logical-change level, not per-file. each bullet starts with a past-tense verb (e.g. \`- Extracted shared CLI runtime into a single module\`, \`- Renamed package to pullfrog\`). avoid file paths unless they add clarity. if the changes can be described in one sentence, use one sentence — no bullets needed.
   b. **Prior review feedback** (only if any were addressed): list only the prior review comments that WERE addressed by the new commits (\`- [x] safeParse instead of parse — addressed\`). omit unaddressed comments. omit this entire section if nothing was addressed. a change can appear in both sections.
   - no headings, no tables, no prose paragraphs in either section — just bullets
   - in some cases you may receive a complete diff for the whole pull request instead of an incremental one. when this happens, you will need to determine what changes have happened since Pullfrog's most recent review.

7. Submit — Do NOT call \`report_progress\` or \`create_issue_comment\` — the review is the final record and the progress comment will be cleaned up automatically. the review body always includes the reviewed changes from step 6a. append \`Prior review feedback:\\n\` with the checklist from step 6b only if any prior comments were addressed. Follow these rules:
   - note: the first create_pull_request_review submission may error with a one-time diff-coverage nudge listing unread TOC regions. retry the same call to proceed — optionally after reading the listed ranges. the pre-flight will not block again this session.
   - IF NO NEW ISSUES, NON-SUBSTANTIVE CHANGES ONLY (trivial formatting, import reordering, comment tweaks): do NOT submit a review. Do NOT call \`report_progress\`. Exit — the progress comment will be cleaned up automatically.
   - ELSE IF NEW CRITICAL ISSUES (blocks merge): call \`${t("create_pull_request_review")}\` with \`approved: false\`, all comments, and the review body. body opens with a GitHub alert blockquote (e.g. \`> [!CAUTION]\\n> This PR introduces ...\`), then the reviewed changes summary and prior feedback (if any).
   - ELSE IF NEW RECOMMENDED CHANGES (non-critical): call \`${t("create_pull_request_review")}\` with \`approved: false\`, all comments, and the review body. body opens with \`> [!IMPORTANT]\\n> ...\` alert, then the reviewed changes summary and prior feedback (if any).
   - ELSE IF NO NEW ISSUES, SUBSTANTIVE CHANGES (new functionality, behavior changes, or fixes to prior review feedback): call \`${t("create_pull_request_review")}\` to create a PR review. If all previous reviews have been properly addressed and no new issues were discovered, you can set \`approved: true\`. body opens with \`No new issues. Reviewed the following changes:\\n\`, then the reviewed changes summary and prior feedback (if any).`,
    },
    {
      name: "Plan",
      description:
        "Create plans, break down tasks, outline steps, analyze requirements, understand scope of work, or provide task breakdowns",
      prompt: `### Checklist

1. Analyze the task and gather context:
   - read AGENTS.md and relevant codebase files
   - understand the architecture and constraints

2. Produce a structured, actionable plan with clear milestones.

3. Call \`${t("report_progress")}\` with the plan.

${learningsStep(t, 4)}`,
    },
    {
      name: "Fix",
      description:
        "Fix CI failures; debug failing tests or builds; investigate and resolve check suite failures",
      prompt: `### Checklist

1. Checkout the PR branch via \`${t("checkout_pr")}\`.

2. Fetch check suite logs via \`${t("get_check_suite_logs")}\`.

3. **CRITICAL**: verify the failure was INTRODUCED BY THIS PR before fixing. If unrelated, abort and report.

4. Diagnose and fix:
   - read the workflow file, reproduce locally with the EXACT same commands CI runs
   - fix the issue using your native file and shell tools
   - verify the fix by re-running the exact CI command
   - review the diff before committing — verify only the fix is present, no debug artifacts, no unrelated changes. the fix should be clean enough that a senior engineer would approve without hesitation.
   - commit locally via shell (\`git add . && git commit -m "..."\`)

5. Finalize:
   - confirm a clean working tree, then push via \`${t("push_branch")}\` (same push/prepush guidance as Build mode in *SYSTEM*)
   - call \`${t("report_progress")}\` with the diagnosis and fix summary (or the exact push error if push failed)

${learningsStep(t, 6)}`,
    },
    {
      name: "ResolveConflicts",
      description: "Resolve merge conflicts in a PR branch against the base branch",
      prompt: `### Checklist

1. **Setup**:
   - Call \`${t("checkout_pr")}\` to get the PR branch.
   - Call \`${t("get_pull_request")}\` to identify the base branch (e.g., 'main').
   - Call \`${t("git_fetch")}\` to fetch the base branch.

2. **Merge Attempt**:
   - Run \`git merge origin/<base_branch>\` via shell.
   - If it succeeds automatically, confirm a clean working tree, push via \`${t("push_branch")}\` (same push/prepush guidance as Build mode in *SYSTEM*), and call \`${t("report_progress")}\` with a brief success note or the exact push error if push failed — **then stop; do not run steps 3–4.**
   - If it fails (conflicts), resolve them manually (continue to steps 3–4).

3. **Resolve Conflicts**:
   - Run \`git status\` or parse the merge output to find the list of conflicting files.
   - For each conflicting file: read it, find the conflict markers (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`), understand the code context, and rewrite the file with the correct resolution. Remove all markers.
   - Verify the file syntax is correct after resolution.

4. **Finalize**:
   - Run a final verification (build/test) to ensure the resolution works.
   - \`git add . && git commit -m "resolve merge conflicts"\`
   - confirm a clean working tree, then push via \`${t("push_branch")}\` (same push/prepush guidance as Build mode in *SYSTEM*)
   - Call \`${t("report_progress")}\` with a summary of what was resolved (or the exact push error if push failed)`,
    },
    {
      name: "Task",
      description:
        "General-purpose tasks that don't fit other modes: answering questions, adding comments, labeling, running ad-hoc commands, or any direct request",
      prompt: `### Checklist

1. Analyze the task. For simple operations (labeling, commenting, answering questions, running a single command), handle directly.

2. For substantial work — code changes across multiple files, multi-step investigations:
   - plan your approach before starting
   - use native file and shell tools for local operations
   - use ${pullfrogMcpName} MCP tools for GitHub/git operations
   - if code changes are needed: review your own diff before committing — verify only intended changes are present, no debug artifacts remain, and the changes are clean enough that a senior engineer would approve without hesitation

3. Finalize:
   - if code changes were made, push to a pull request (new or existing) using \`${t("push_branch")}\` and \`${t("create_pull_request")}\` as needed. \`git status\` must be clean before you finish (see *SYSTEM* Git rules if push fails).
   - call \`${t("report_progress")}\` once with results — include exact tool errors if push or PR creation failed
   - if the task involved labeling, commenting, or other GitHub operations, perform those directly

${learningsStep(t, 4)}`,
    },
    {
      name: "Summarize",
      description:
        "Summarize a PR with a structured comment that is updated in place on subsequent pushes",
      prompt: `### Checklist

1. Checkout the PR via \`${t("checkout_pr")}\` — this returns PR metadata and a \`diffPath\`.
2. Read the diff using the TOC to selectively read relevant sections (not the entire file). Produce a structured summary. If EVENT INSTRUCTIONS specify a custom format, follow that instead of the default format below.
3. Call \`${t("create_issue_comment")}\` with \`type: "Summary"\` and the summary body.
4. Call \`${t("report_progress")}\` with a brief note (e.g., "Posted PR summary.").

${PR_SUMMARY_FORMAT}`,
    },
  ];
}

// static export for UI display — uses opencode format as the readable default
export const modes: Mode[] = computeModes("opencode");
