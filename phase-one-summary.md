# Phase One Summary: Testable Lightweight Context Gathering

## Status

Phase one is complete for its intended scope.

What is complete:
- a separately testable deterministic context gatherer exists
- it is integrated into Void through the existing `contextGatheringService`
- it is used in the real prompt-preparation path for `agent`, `gather`, and `plan`
- it includes a judgment layer that ranks likely source-of-truth files above nearby lexical matches
- it was evaluated against repo-shaped questions and matched the manual target files on the benchmark set

What is not part of phase one:
- no planning-loop changes
- no tool-execution changes
- no autonomous decision-policy changes
- no embeddings-based reranking

## Goal of This Phase

The goal was not to make the agent fully smarter on its own. The goal was narrower:

1. build a context finder that can be tested outside runtime logs
2. make it deterministic and cheap
3. integrate it into the live prompt path
4. verify that it can retrieve the right files for real repo questions

This phase was mainly about retrieval quality and prompt context quality.

## Architecture Implemented

### 1. Pure context gatherer

Implemented in:
- [src/vs/workbench/contrib/void/common/contextGathering/contextGatherer.ts](/home/shivam/Desktop/void/src/vs/workbench/contrib/void/common/contextGathering/contextGatherer.ts:1)

This module is intentionally pure and dependency-light. It does not depend on VS Code workbench services. It operates on in-memory file inputs:

- path
- optional content
- optional symbols
- optional search-hit counts

It is responsible for:
- extracting task terms
- filtering unwanted files
- base scoring
- judgment-layer scoring
- ranking relevant files
- shaping the final gathered context payload
- formatting prompt-ready context text

### 2. Thin workbench adapter

Integrated in:
- [src/vs/workbench/contrib/void/browser/contextGatheringService.ts](/home/shivam/Desktop/void/src/vs/workbench/contrib/void/browser/contextGatheringService.ts:138)

This adapter collects real workspace data using existing services:
- workspace file enumeration
- text search hit counts
- file contents
- document symbols

It then passes normalized inputs into the pure gatherer.

### 3. Live prompt-path integration

Integrated in:
- [src/vs/workbench/contrib/void/browser/convertToLLMMessageService.ts](/home/shivam/Desktop/void/src/vs/workbench/contrib/void/browser/convertToLLMMessageService.ts:734)
- [src/vs/workbench/contrib/void/common/prompt/prompts.ts](/home/shivam/Desktop/void/src/vs/workbench/contrib/void/common/prompt/prompts.ts:501)

For `agent`, `gather`, and `plan` modes:
- the latest user message is sent to `gatherContext(...)`
- gathered results are formatted with `formatGatheredContextForPrompt(...)`
- the result is injected into the system prompt inside `<workspace_context>`

This means phase one is not only an offline scorer now. It is live in the actual prompt construction path.

## Strategy Applied

The strategy used in this phase was:

### A. Two-stage deterministic retrieval

We do not read the whole repo deeply up front.

Instead:

1. collect all candidate paths and text-search hit counts
2. run an initial cheap ranking
3. enrich only the top candidates with file contents and symbols
4. rerank using richer signals

This keeps the phase lightweight and testable.

### B. Base lexical scoring

The first layer scores files using:
- basename matches
- pathname matches
- content term matches
- symbol-name matches
- text-search hit counts

This provides broad recall.

### C. Judgment layer

The second layer exists because lexical matching alone is not enough.

It adds intent-sensitive scoring based on the user’s question.

The judgment layer detects query intent such as:
- execution-site questions
- implementation questions
- definition questions
- prompt-wiring questions
- ownership questions
- directory-tree questions

It then classifies files into roles such as:
- `core_execution`
- `wrapper`
- `orchestrator`
- `prompt_template`
- `prompt_assembly`
- `context_source`
- `definition_registry`
- `directory_engine`
- `ui_surface`

### D. Ownership-first ranking

This became the main improvement over the earlier versions.

The ranking now tries to answer:

`Which file actually owns this behavior?`

instead of only:

`Which file mentions the same words?`

That produced the key improvements:

- prefer `toolsService.ts` over `chatThreadService.ts` for built-in tool validation/execution
- prefer `convertToLLMMessageService.ts` over `prompts.ts` for semantic search being added to prompts
- prefer `sendLLMMessage.ts` over wrapper/channel files for provider dispatch

### E. Prompt-boundary diagnostics

Added in:
- [src/vs/workbench/contrib/void/common/contextGathering/contextGatherer.ts](/home/shivam/Desktop/void/src/vs/workbench/contrib/void/common/contextGathering/contextGatherer.ts:511)
- [src/vs/workbench/contrib/void/browser/convertToLLMMessageService.ts](/home/shivam/Desktop/void/src/vs/workbench/contrib/void/browser/convertToLLMMessageService.ts:744)

When prompt preparation runs, logs now include:
- how many gathered files were selected
- prompt character count for gathered context
- a compact summary of the top selected files

This gives runtime visibility without depending only on vague logs.

## What the Gatherer Returns

The gathered payload includes:
- `task`
- extracted `terms`
- `fileTree`
- `relevantFiles`

Each relevant file can include:
- path
- relevance score
- search hit count
- symbols
- content for only the top few files
- truncation metadata

This keeps the prompt compact while still surfacing real evidence.

## Exclusions and Guardrails

The gatherer excludes common low-value or noisy paths, including:
- `.git`
- `node_modules`
- `dist`
- `build`
- `out`
- `coverage`
- vendor/cache/temp-style directories
- common binary file types

It also penalizes:
- test files for normal product-code questions
- its own gatherer file for unrelated questions
- UI-heavy files when the question is not a UI question

These penalties were needed to prevent benchmark contamination and noisy top hits.

## Verification Performed

### Focused gatherer tests

Implemented in:
- [src/vs/workbench/contrib/void/test/common/contextGatherer.test.ts](/home/shivam/Desktop/void/src/vs/workbench/contrib/void/test/common/contextGatherer.test.ts:1)

The focused tests cover:
- task term extraction
- path filtering
- ranking by path/content/search/symbols
- core execution vs wrappers
- prompt assembly vs prompt templates
- ownership heuristics
- gathered-context formatting
- prompt-boundary diagnostic summary
- content truncation behavior

### Repo benchmark used

We repeatedly compared the gatherer against manual expectations for these real questions:

1. `Where is the LLM message sent to providers?`
2. `Where are built-in tools validated and executed?`
3. `Where is semantic search added to prompts?`
4. `Where is the chat thread tool loop?`
5. `Where is directory tree generation implemented?`

Final top-1 results:
- `sendLLMMessage.ts`
- `toolsService.ts`
- `convertToLLMMessageService.ts`
- `chatThreadService.ts`
- `directoryStrService.ts`

That benchmark ended at `5/5` top-1 matches for the target set.

### Prompt-boundary evaluation

We also verified that:
- the chosen files are formatted into prompt context in the correct order
- prompt summaries report the owned top file first
- the live path still inserts gathered context through `<workspace_context>`

## Important Caveat

There is one environment caveat:

The local `out/` build pipeline was unreliable in this sandbox session, so the cleanest repeatable verification came from source-level evaluation with `ts-node` plus targeted assertions, rather than a full emitted-`out` unit run for the latest changes.

That is a verification limitation of the current session, not a design limitation of the phase-one implementation.

## Net Result of Phase One

At the end of phase one, Void now has:

- a deterministic context gatherer that is testable outside runtime logs
- a workbench adapter that gathers real workspace evidence
- a judgment layer that ranks likely owners, not just lexical matches
- live prompt integration for agent/gather/plan
- prompt-boundary diagnostics so we can inspect what the model actually receives

## Why This Phase Matters

Without this phase, prompt context quality depends too much on:
- broad directory strings
- semantic snippets alone
- manual inspection of logs

With this phase, we now have a structured intermediate layer:

`user task -> deterministic gatherer -> ranked owned files -> formatted workspace context -> prompt`

That is the foundation needed before moving on to later phases like better planning or stronger autonomous behavior.

## Recommended Next Step

Phase two should focus on using this higher-quality context more intelligently rather than only retrieving it.

The likely direction is:
- use gathered ownership signals to shape tool selection or planning behavior
- evaluate whether better prompt context materially changes first-action quality
- measure whether the agent gets unstuck earlier on real tasks
