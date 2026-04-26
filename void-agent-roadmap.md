# Porting Void-Code into a Planning + Execution Agent
## A Step-by-Step Roadmap (Testable Phases)

> **How to use this doc**: Each phase has a clear entry condition, a "why this, not that" rationale, implementation notes, and a pass/fail test. Do not move to the next phase until the test for the current one passes reliably on a real task.

---

## Mental Model Before You Start

Cursor and Antigravity feel "smooth" because of three things working together:

1. **Context gathering that is fast and accurate** — the agent always loads the *right* files, not just whatever the user mentions
2. **A structured plan that survives contact with reality** — the agent doesn't just "think out loud"; it tracks discrete steps that can be approved, retried, or re-planned
3. **An execution loop that feeds errors back in** — failures are not fatal; they become new context

Everything in this roadmap is aimed at building those three properties incrementally. You will have a working (if limited) agent at the end of Phase 2, and it gets progressively smarter from there.

---

## Phase 1 — Lightweight Context Gathering

### What you are building
A `gather_context(task: string, workspace_root: string)` function that returns the files and symbols most relevant to a given task, without any embedding index or ML model.

### Why this, not embeddings?

Embedding-based search sounds like the right answer because it is "semantic" — it finds conceptually related code even without exact keyword matches. But before you can use it you need to:

- Decide a chunking strategy (by file? by function? fixed token windows?)
- Build the index (which takes real time on first run and re-run on every file change)
- Stand up a vector store (even a local one like Chroma needs a process running)
- Write the query pipeline that converts a task description into a search vector

That is 3–4 systems to get right before you can run your first test. If any one of them is wrong, your context is bad, and you do not yet know *which* system is the culprit.

By contrast, **ripgrep + tree-sitter + LSP** gives you 80% of the context quality with zero setup time and zero index build time. These tools are already available inside the VS Code extension host that Void runs on. You can have a working `gather_context` in a single afternoon and test it immediately.

The other reason to skip embeddings here: for small-to-medium repos (under ~20k lines), keyword search + symbol lookup genuinely outperforms embeddings. Embeddings shine when you have a large codebase and a vague query. For a coding agent that works on specific, concrete tasks ("add a login route", "fix the null pointer in auth.ts"), exact matches are usually better.

### How to implement it

**Step 1 — File tree**

Use VS Code's `workspace.findFiles` API (already available in the Void extension host) to get the project's file tree. Filter out `node_modules`, `.git`, `dist`, build artifacts. Represent it as a simple flat list of relative paths. This gives the agent a map of the codebase.

```typescript
const files = await vscode.workspace.findFiles(
  '**/*.{ts,js,py,go,rs}',
  '**/node_modules/**'
);
```

**Step 2 — Keyword relevance scoring**

Run `ripgrep` (`rg --json`) with key terms extracted from the task description. Score each file by the number of hits. This is naive but remarkably effective — if the task says "fix the JWT expiry bug", the files that contain "JWT", "expiry", "token" are almost certainly the right ones.

```bash
rg --json "JWT|token|expiry" --type ts
```

Take the top 5–8 files by hit count. These become your "candidate files".

**Step 3 — Symbol extraction**

For each candidate file, use **tree-sitter** to extract all function definitions, class definitions, and exported symbols. This gives the agent a table of contents for each file without reading the full file into the context window. A file's full content might be 600 lines; its symbol list is 20 lines.

If you are working inside the VS Code extension host, you can also use the LSP directly:

```typescript
const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
  'vscode.executeDocumentSymbolProvider',
  fileUri
);
```

**Step 4 — Assemble the context payload**

Return a structured object:

```json
{
  "file_tree": ["src/auth.ts", "src/routes/login.ts", ...],
  "relevant_files": [
    {
      "path": "src/auth.ts",
      "relevance_score": 14,
      "symbols": ["verifyJWT()", "generateToken()", "AuthMiddleware"],
      "content": "<full file content — included because score is high>"
    }
  ]
}
```

Only include full file content for the top 2–3 files by score. For the rest, include only the symbol list. This keeps your context window manageable.

### Test to pass before moving on

Ask the agent: *"Where is the JWT token verified in this codebase?"*

It should return the correct file and function name without you telling it where to look. Run this on 5 different questions about your codebase. If it gets 4/5 right, move to Phase 2. If it is missing files, tune the ripgrep query construction. If the context window is overflowing, reduce the number of files with full content.

---

## Phase 2 — Tool-Chain Wiring

### What you are building
A set of LLM-callable tools that the agent can use to actually touch the codebase: read files, write files, run shell commands, search for symbols. These are wired to the Anthropic tool-use API (or whichever LLM backend Void uses).

### Why this approach, not just giving the agent the full codebase in the prompt?

Two reasons:

**Token budget**: Even a medium codebase is hundreds of thousands of tokens. You cannot paste the whole thing into a context window — and even if you could, the model's attention degrades over very long contexts; important information in the middle gets "lost".

**Agency**: An agent that can only read a static snapshot cannot fix bugs — it can only suggest fixes. The moment you give it `write_file` and `run_command` as callable tools, it becomes an executor, not just a suggester. This is the fundamental difference between Cursor "chat" mode and Cursor "agent" mode.

**Why tool-use API, not function-calling via string parsing?**

You could ask the model to emit JSON like `{"action": "read_file", "path": "src/auth.ts"}` and parse it yourself. Some early agent systems did this. It breaks in practice because: the model sometimes emits malformed JSON, sometimes wraps it in markdown fences, and sometimes emits it mid-sentence. The Anthropic tool-use API handles all of this — the model emits a structured `tool_use` block that is guaranteed to be valid and typed. Less fragile, less code on your side.

### The tools to implement

**`read_file(path: string) → string`**
Read a file from the workspace. Simple, but important to sanitize the path (prevent path traversal) and return an error string if the file doesn't exist rather than throwing — the agent needs to handle "file not found" gracefully.

**`write_file(path: string, content: string) → { success: boolean, diff: string }`**
Write or overwrite a file. Always return the unified diff of the change. This diff is shown to the user (Phase 6) and also fed back to the agent as confirmation that the write happened correctly.

**`run_command(command: string, cwd?: string) → { stdout: string, stderr: string, exit_code: number }`**
Run a shell command — tests, linters, build steps. Cap the output at ~4000 characters (truncate with a note) to avoid blowing the context window with megabytes of test output. The `exit_code` is critical: the agent uses it to know whether to proceed or retry.

**`search_symbol(query: string) → { file: string, line: number, symbol: string }[]`**
A direct wrapper around ripgrep + LSP. The agent calls this when it needs to find where a function is defined or referenced.

**`list_directory(path: string) → string[]`**
List the contents of a directory. Needed when the agent needs to explore a part of the project it wasn't given in the initial context.

### Test to pass before moving on

Give the agent a concrete, small task: *"Add a console.log to the `verifyJWT` function that logs the token expiry time."*

The agent should:
1. Call `search_symbol("verifyJWT")` to find the file
2. Call `read_file("src/auth.ts")` to read it
3. Call `write_file("src/auth.ts", ...)` with the modified content
4. Call `run_command("npx tsc --noEmit")` to verify no type errors

It should complete this without hallucinating a file path or writing to the wrong location. If it hallucinates, the problem is usually in the context payload from Phase 1 — the agent didn't have enough information to know where `verifyJWT` lives.

---

## Phase 3 — Planning Loop

### What you are building
A task decomposition layer: given a high-level task, the agent produces a structured list of sub-steps *before* executing any of them. The plan is stored as typed state, not prose.

### Why structured state, not a "think out loud" scratchpad?

Many agent implementations use a free-form scratchpad: the model emits text like *"First I'll read the auth file, then I'll understand the token flow, then I'll make the change..."* and then immediately starts executing.

This works for simple one-step tasks but falls apart for multi-file, multi-step tasks because:

- **You cannot checkpoint prose**. If step 3 fails, you cannot resume from step 3 — you have to re-run the whole thing.
- **You cannot show prose to the user for approval**. Cursor's agent mode shows you a list of planned actions before running them. That requires a discrete, structured representation.
- **Prose plans drift**. By the time the model is executing step 5, it has often forgotten the constraint it stated in step 1.

A structured plan looks like this:

```json
{
  "task": "Add rate limiting to the login endpoint",
  "steps": [
    {
      "id": 1,
      "status": "pending",
      "action": "read_file",
      "target": "src/routes/login.ts",
      "reason": "Understand the current login handler structure"
    },
    {
      "id": 2,
      "status": "pending",
      "action": "search_symbol",
      "query": "RateLimiter",
      "reason": "Check if a rate limiting utility already exists in the codebase"
    },
    {
      "id": 3,
      "status": "pending",
      "action": "write_file",
      "target": "src/routes/login.ts",
      "reason": "Add rate limit middleware to the login route"
    },
    {
      "id": 4,
      "status": "pending",
      "action": "run_command",
      "command": "npm test -- --grep login",
      "reason": "Verify the login tests still pass"
    }
  ]
}
```

Each step has an `id`, a `status` (pending / running / done / failed), an `action` (maps to a tool), and a `reason` (why this step is needed — critical for re-planning).

### The planning prompt pattern

Use a two-phase prompt:

**Phase A — Plan generation** (no tool calls allowed):

> *"You are a planning agent. Given the task and the codebase context below, produce a JSON plan with discrete steps. Do NOT execute any steps. Do NOT call any tools. Only output the plan JSON."*

**Phase B — Execution** (tool calls allowed, plan as input):

> *"You are an execution agent. Execute the following plan step by step. After each step, update the plan JSON with the result and the new status."*

Separating these two phases forces the model to think before acting — it cannot immediately jump to writing files. This is the core pattern used by systems like SWE-agent and OpenDevin.

### Why not let the model plan and execute in one pass?

Because the model will start executing at step 1 before it has thought through steps 3 and 4. Often step 1 reveals information (e.g., the rate limiter already exists) that should change the entire plan. If you separate plan from execute, you can inspect the plan, optionally show it to the user, and re-generate it with the new information before a single file is touched.

### Test to pass before moving on

Give the agent a multi-file task: *"Rename the `UserRecord` type to `UserProfile` everywhere in the codebase."*

The plan should include: a `search_symbol` step to find all usages, a `read_file` + `write_file` step for each affected file, and a `run_command` step to check types compile. Verify the plan is correct and complete *before* allowing execution. If the plan misses a file, the context gathering (Phase 1) needs to be improved.

---

## Phase 4 — Execution Loop with Error Recovery

### What you are building
A step executor that runs the plan, captures the result of each step, feeds failures back into the agent as new context, and re-plans or retries with bounded recursion depth.

### Why feed errors back in, not just retry the whole task?

Retrying the whole task from scratch on failure throws away everything the agent learned from the partial execution. If step 1 (read file), step 2 (write file), and step 3 (run tests) ran — and step 3 failed with a type error — you want the agent to see: *"the file was written, the tests failed with this error, fix the file"*. Re-running from step 1 wastes tokens and time.

The execution loop maintains a running `context` object:

```json
{
  "original_task": "...",
  "plan": [...],
  "execution_log": [
    { "step_id": 1, "status": "done", "result": "<file content>" },
    { "step_id": 2, "status": "done", "result": "{ diff: ... }" },
    { "step_id": 3, "status": "failed", "result": "{ exit_code: 1, stderr: 'Type error: ...' }" }
  ]
}
```

When a step fails, the agent is prompted with this full log and asked to either:
- **Patch**: fix the current step and retry (if the error is small and local)
- **Re-plan from step N**: generate new steps to replace step N onward (if the error revealed a deeper misunderstanding)
- **Abort**: if the task is fundamentally impossible given the current codebase state

### Bounded recursion — why it matters

Without a depth limit, a bug in the agent's reasoning can cause an infinite retry loop — it writes bad code, tests fail, it writes slightly different bad code, tests fail again, forever. Set a hard limit of 3 retries per step and 2 re-plan cycles per task. If those are exhausted, surface the failure to the user with the full execution log so they can intervene.

This is what separates a robust agent from a demo: demos succeed; robust agents fail gracefully.

### Why not use a framework like LangChain or AutoGen here?

At this stage of a fork project, frameworks introduce a third codebase you need to understand and debug. Void already has its own extension architecture — wiring a LangChain agent into that means two sets of abstractions fighting each other. The loop described above is ~200 lines of TypeScript. Write it yourself so you understand every state transition. You can always extract it into a library later.

### Test to pass before moving on

Deliberately introduce a bug in a test file (e.g., expect `true` to equal `false`). Give the agent a task that causes those tests to run. Verify that it:
1. Detects the test failure from `stderr`
2. Identifies the correct file to fix (not a random file)
3. Makes a reasonable fix attempt
4. Verifies tests pass on retry

The agent does not need to fix every possible bug — it needs to not get stuck in a loop and not corrupt files it was not supposed to touch.

---

## Phase 5 — Semantic Context (Add Embeddings Now)

### What you are building
An embedding index over the codebase that the `gather_context` function can query when keyword search is insufficient. This replaces or augments Phase 1's ripgrep approach for large repos.

### Why now and not in Phase 1?

By now you have a working agent loop with a clear definition of "context quality" — you know what a good context payload looks like, and you have tests that fail when the context is wrong. This means you can measure whether the embedding index is actually better than ripgrep for your use cases. Without that baseline, you would be optimizing a metric you cannot observe.

You also now know your actual bottleneck. Most projects hit the limit of keyword search somewhere between 20k and 100k lines of code. If your target codebase is smaller, you may not need this phase at all.

### Why local/embedded vector store, not a server?

For a VS Code extension fork, you do not want to require users to run a separate server process. Options that run in-process or as a file on disk:

- **LanceDB** — Rust-backed, has a Node.js binding, stores data as files on disk, no server required. Best option for TypeScript projects. Query latency is ~5ms for a 100k-chunk index.
- **sqlite-vec** — A SQLite extension that adds vector search. If you are already using SQLite for any persistence, this is zero additional infra.
- **Chroma (embedded mode)** — Python only. If your agent backend is Python, this is a good choice. Not suitable for the Node extension host.

Avoid Pinecone, Weaviate, Qdrant for this use case — they require a running server and add operational overhead that is inappropriate for a local dev tool.

### Chunking strategy

Do **not** use fixed token-window chunking (e.g., every 512 tokens). This splits functions in half and produces chunks with no coherent meaning. Instead:

- Chunk **by function or class** using tree-sitter. Each chunk is one complete function, one complete class, or one top-level block.
- Include the file path and the function/class name in the chunk metadata. This is what you return to the agent — not just a block of code, but `{ file: "src/auth.ts", symbol: "verifyJWT", content: "..." }`.
- Re-index on file save using a VS Code file watcher. Only re-chunk changed files.

### Test to pass before moving on

Take a large codebase (50k+ lines). Ask: *"Find the function that handles password hashing."* The context gathered should include the correct file and function without being given any hints. Compare the result with what Phase 1's ripgrep approach would return. If embedding is not better, your chunking or query construction needs adjustment.

---

## Phase 6 — UX Polish: Streaming Plan + Diff Preview

### What you are building
The UI layer that makes the agent feel like Cursor: the plan streams in as it is generated, each step shows what it is about to do before doing it, and diffs are shown for approval before files are written.

### Why this last, not first?

Because UX polish on a broken agent is wasted effort — and worse, it hides the breakage. A nice-looking UI makes it harder to see that the agent is making bad decisions. Build the correctness first, then make it pleasant.

Void already has a diff viewer in its editor. The implementation is largely about wiring the agent's output events into Void's existing UI primitives, not building new UI from scratch.

### What to implement

**Plan streaming**: When the agent generates the plan (Phase 3), emit each step as a server-sent event or WebSocket message as it is generated. Display it in the Void sidebar as a live-updating checklist. The user sees the plan build step by step, which builds trust and allows early intervention.

**Step status updates**: As each step executes, update its status indicator in the sidebar (pending → running → done / failed). This is the "thread" view you see in Cursor agent mode.

**Diff preview before write**: Before calling `write_file`, show the unified diff in Void's diff editor and wait for user confirmation. This is the single most important trust-building feature — users are far more willing to let an agent run autonomously if they know it will ask before touching files. Wire this into the `write_file` tool: it emits a `preview` event, the UI shows the diff, the user accepts or rejects, and only then does the actual write happen.

**Reject and re-plan**: When the user rejects a diff, send the rejection back to the agent with an optional reason. The agent should treat this the same way it treats a test failure — as new information that requires re-planning from the current step.

### Test to pass

Run a 4-step task from end to end. Verify that:
- The plan appears in the UI before execution starts
- Each step's status updates in real time
- The diff for each file write is shown before applying
- Rejecting a diff causes the agent to produce an alternative, not crash

---

## Quick Reference: Decision Table

| Question | Answer |
|---|---|
| Should I start with embeddings? | No. Start with ripgrep + tree-sitter. Add embeddings in Phase 5. |
| Which vector store? | LanceDB (Node/TS) or sqlite-vec. Not Chroma/Qdrant/Pinecone. |
| Structured plan or scratchpad? | Structured JSON plan. Separate plan generation from execution. |
| LangChain or custom loop? | Custom loop. ~200 lines. Easier to debug inside Void's architecture. |
| When to show diffs to user? | Phase 6. Get correctness working first. |
| How many retry attempts per step? | 3 retries per step, 2 re-plan cycles per task. Then surface to user. |
| Chunking strategy for embeddings? | By function/class via tree-sitter. Never fixed token windows. |

---

## What "Done" Looks Like Per Phase

| Phase | Exit Condition |
|---|---|
| 1 | Agent answers "where is X defined?" correctly 4/5 times on your real codebase |
| 2 | Agent completes a single-file edit + test run without hallucinating paths |
| 3 | Agent produces a correct, complete plan for a multi-file refactor before executing |
| 4 | Agent recovers from a deliberate test failure without corrupting unrelated files |
| 5 | Agent finds correct context in a 50k+ line codebase without keyword hints |
| 6 | Full task runs end-to-end with visible plan, per-step status, and diff approval |
