# Feature Specification: Memory, context files & the load meter

> Behaviour-first spec per [Constitution Principle IX](../../../../../.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> Describes **what** the system does for the user. Implementation lives in [`plan.md`](./plan.md).

**Feature ID**: `AW-07-memory-context`
**Program**: [Agent Workspace](../README.md) — Wave 3
**Branch**: `feat/aw-07-memory-context`
**Status**: `Draft`
**Created**: 2026-09-06
**Last updated**: 2026-09-06
**Owner**: Product
**Size**: L · **Depends on**: — · **Depended on by**: AW-23 (agent identity & levels)

> **Additive-only (program rule #1).** Nothing in this epic removes, renames or
> consolidates an existing surface. `/memory` keeps every panel it has today
> (Files, Uploads, Review, Meetings, Sessions, Consolidation settings); the five
> canonical Agent files keep their names, their endpoints and their editor; the
> Knowledge Base is untouched. Everything below is new surface bolted onto what
> already ships.

---

## 1. Overview

An owner can teach the workspace a fact once — by saying it in chat, by correcting
an agent, or by typing it into a list — and every agent carries that fact into
every future run without ever being told again. This epic gives that promise a
surface: a **Memory** list of atomic facts that is searchable by meaning, editable row by
row, and forgettable one fact at a time; a small fixed set of **workspace context
files** (About you, Organization, People, Glossary, Voice, Roster) that hold the
prose an agent needs but a fact list cannot express; a per-agent **Notes** file
that the agent itself can write to; and — the part that makes all of it
trustworthy — a **load meter** on every context-file editor that shows exactly
how much of the file reaches the agent on each run and paints the region that
gets skipped when the file is over budget. Every editor also carries an **"Ask an
agent to update this"** button that opens chat with the file already attached as
context and the message already started, so a file can be corrected by describing
the change instead of typing the edit.

## 2. Why now

### 2.1 The user's question

> _"I told it this last week. Why does it not know?"_

and its twin:

> _"I wrote three pages of instructions for this agent. Is it even reading them?"_

### 2.2 What they do today instead

| The need                               | What Ever Works offers today                                                                                                                                                                                                                       | What the user actually does                                                            |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Teach a durable fact                   | Nothing first-party. Agent-memory is an **optional plugin capability** — if no provider is enabled, `GET /api/agent-memory/check-availability` reports unavailable and nothing is remembered at all.                                               | Repeats the fact in every task description.                                            |
| See what is remembered                 | The Memory page shows **documents, uploads, meetings and provider sessions** — never the individual facts. There is no list of facts anywhere in the product.                                                                                      | Guesses. Or opens a run and reads the prompt.                                          |
| Correct a wrong fact                   | The delete-one-record endpoint exists (`DELETE /api/agent-memory/entries/:entryId`) but **no UI lists the records**, so there is no id to delete.                                                                                                  | Wipes the provider's store by hand, or gives up.                                       |
| State a fact once for every agent      | No shared always-loaded context exists. The run prompt is assembled from the agent's **own** files plus skills, scope and recent activity — nothing carries organization-wide facts.                                                               | Pastes the same paragraph into every agent's `SOUL.md`, then watches the copies drift. |
| Know whether the instructions fit      | Nothing. The prompt assembler silently truncates over-budget material, and its truncation for long authored files keeps the **end** and drops the **beginning** — the top of a carefully-ordered instruction file is the first thing to disappear. | Nothing, because they cannot see it happen.                                            |
| Give an agent durable notes of its own | The five canonical files are human-authored config. An agent has nowhere to record what it learned that is scoped to itself.                                                                                                                       | Nothing.                                                                               |

Three concrete gaps, all of them ours:

1. **Facts are not a first-class thing.** Durable memory is entirely delegated to
   an optional external provider. If it is not installed, "remember this" is a
   no-op with no error the user ever sees.
2. **There is no shared context tier.** Organization-wide truth has to be
   duplicated into each agent, which guarantees drift — exactly the failure this
   program exists to remove.
3. **Context loss is invisible.** Prompt truncation is real, already happening,
   already logged internally, and completely hidden from the person who wrote the
   text being thrown away. Onboarding profile answers we already collect are
   never shown to an agent at all.

### 2.3 What this epic changes

```
   BEFORE                                   AFTER
   ──────                                   ─────
   Owner ─"remember X"─► chat               Owner ─"remember X"─► chat
             │                                        │
             ▼                                        ▼
        (nothing, unless an              ┌──────────────────────────┐
         optional provider is            │  Memory                  │
         installed and even then         │  ├─ Facts   ← searchable │
         invisible)                      │  ├─ Context files        │
                                         │  └─ Agents ▸ files       │
                                         └───────────┬──────────────┘
   Agent run assembles:                              │ every run
     identity, role, tools,                          ▼
     skills, scope, activity          Agent run assembles the same, PLUS
                                        • pinned + recalled facts (≤1,200 tok)
                                        • always-loaded context files (≤1,500)
                                        • the agent's Notes (≤1,500)
                                      …each with a visible meter and a marked
                                       skipped region when it does not fit.
```

## 3. User scenarios

### 3.1 Primary

- **S1 — Teach a fact in chat.**
  **Given** an owner is in chat with an agent,
  **when** they write "remember that we never quote a delivery date shorter than
  ten working days",
  **then** the assistant confirms in one line naming the exact stored wording, the
  fact appears at the top of the Memory ▸ Facts list marked **You · just now**,
  and the next run of any agent in the workspace can use it.

- **S2 — Find a fact by meaning.**
  **Given** a workspace with 180 facts,
  **when** the owner types `delivery promises` into the Facts search box,
  **then** the fact worded "we never quote a delivery date shorter than ten
  working days" is returned within the first three results even though it shares
  no word with the query, and each result shows why it matched (a relevance bar).

- **S3 — Correct a fact.**
  **Given** a fact reads "escalate anything over 5,000 to a human",
  **when** the owner edits it in place to "escalate anything over 2,000 to a
  human" and saves,
  **then** the row updates immediately, the change is recorded in the activity
  feed, and every run started **after** the save uses the corrected wording. Runs
  already in flight keep the old value and the row says so:
  _"2 runs in flight still hold the previous version."_

- **S4 — Forget one fact.**
  **Given** a fact that is no longer true,
  **when** the owner chooses **Forget**,
  **then** the row leaves the list, a toast offers **Undo** for 10 seconds, the
  fact stops being recalled by any run started after that moment, and it remains
  recoverable from the **Forgotten** filter for 30 days before it is purged.

- **S5 — Write a shared context file.**
  **Given** the workspace has never filled in **Voice**,
  **when** the owner opens Memory ▸ Context files ▸ Voice, types the house style
  rules and saves,
  **then** the file's load meter fills to show 340 of 1,500 tokens used, the file
  is marked **Loaded every run**, and the next run of every agent carries it.

- **S6 — See what an agent actually receives.**
  **Given** an agent whose Notes file is 4,100 tokens against a 1,500-token
  budget,
  **when** the owner opens that file,
  **then** the meter reads **1,500 / 1,500 · 2,600 tokens skipped**, the
  **Preview** toggle shows the file with a marked block where the middle is cut,
  and the block is labelled _"Skipped — the agent never sees this"_.

- **S7 — Fix a file by asking.**
  **Given** the owner is looking at an agent's Notes file and does not want to
  edit prose,
  **when** they press **Ask an agent to update this**,
  **then** the chat panel opens with the file attached as a context chip and the
  message already started (`@research-agent update your Notes file: `), the
  cursor at the end; clicking the chip expands exactly the text that will ride
  along, with the same skipped region marked.

- **S8 — An agent records something for itself.**
  **Given** an agent with permission to edit its own files finishes a run in which
  it discovered a stable fact about a repository,
  **when** it writes that line to its Notes file,
  **then** the edit appears in the activity feed as an agent edit, the file's
  revision history gains an entry attributed to that agent, and the owner can
  revert it in one click.

### 3.2 Unhappy paths, races, empty states and denials

- **S9 — Nothing remembered yet (empty state).**
  **Given** a brand-new workspace,
  **when** the owner opens Memory ▸ Facts,
  **then** they see _"Nothing remembered yet"_ with the sub-line _"Facts land here
  when you say 'remember…' in chat, or add one below"_, a primary **Add a fact**
  button, and a copyable starter prompt. No spinner, no error.

- **S10 — Search finds nothing.**
  **Given** 40 facts,
  **when** the owner searches `refund policy` and no fact is close enough,
  **then** the list shows _"No fact matches 'refund policy'"_ with **Clear
  search** and **Add "refund policy" as a fact** — the second button pre-fills the
  add form with the query text.

- **S11 — Two people edit the same file.**
  **Given** two owners have the Glossary open,
  **when** the second saves after the first,
  **then** the second save is refused with _"This file changed while you were
  editing. Reload to see the current version — your text is kept below."_, the
  typed text is preserved in the editor, and a **Compare** link shows both
  versions side by side. Nothing is silently overwritten.

- **S12 — Over the always-loaded file limit.**
  **Given** three workspace context files are already set to load every run,
  **when** the owner switches a fourth to **Loaded every run**,
  **then** the switch is refused with _"At most 3 context files can load on every
  run. Switch one of About you, Voice or Organization to on-demand first."_ and
  the list highlights the three current always-loaded files.

- **S13 — The memory store is full.**
  **Given** a workspace already holding 2,000 active facts,
  **when** anything tries to add another,
  **then** the write is refused with _"Memory is full — 2,000 facts is the limit.
  Forget some facts, or run Tidy up to merge duplicates."_, a **Tidy up** button
  opens the existing consolidation review, and — if the write came from an agent
  during a run — the run continues normally and one line lands in the run's log
  rather than failing the run.

- **S14 — An agent tries to plant a fact.**
  **Given** an agent processed an external web page during a run and that page
  contained text instructing it to remember something,
  **when** the agent calls the remember tool,
  **then** the fact is stored as **Proposed**, never as active; it is **not**
  recalled by any run; it appears in the Review panel labelled _"Proposed by
  {agent} during run {id}"_ with **Accept** and **Discard**; and if more than 200
  proposals are already waiting, the new one is dropped and the run logs
  _"memory proposal dropped — review backlog full"_.

- **S15 — Forget everything, on purpose.**
  **Given** a list that has filled up with noise,
  **when** the owner presses **Forget all** and types `FORGET ALL` into the
  confirmation field,
  **then** every active and proposed fact in the current workspace is forgotten;
  the dialog states before confirming exactly what is **not** touched — _"Your
  context files, agent files, uploads and Knowledge Base are not affected"_ — and
  after the wipe the list shows the empty state with _"Agents start learning
  again immediately."_

- **S16 — Semantic search unavailable.**
  **Given** the deployment has no embedding-capable AI provider resolved (or the
  database lacks vector support, as in local SQLite runs),
  **when** the owner searches Facts,
  **then** search still works as a plain text match, an inline note reads
  _"Matching by exact words — meaning-based search needs an AI provider"_ with a
  link to plugin settings, and no error is thrown. Facts saved while embeddings
  are unavailable are queued and embedded automatically once a provider appears.

- **S17 — Permission denied on an agent write.**
  **Given** an agent without the "edit agent files" permission,
  **when** the owner asks it in chat to update its own Notes file,
  **then** the agent replies _"I can't edit my own files — here's the change I'd
  make"_ and returns the proposed text as a diff with an **Apply** button the
  owner presses; nothing is written until they do.

- **S18 — Someone else's workspace.**
  **Given** a fact or context file belonging to another organization,
  **when** it is requested by id,
  **then** the response is a 404 — never a 403 that would confirm the row exists.

- **S19 — Loading.**
  **Given** the Memory page is opening,
  **when** the facts list has not resolved,
  **then** six skeleton rows render in place of facts, the left rail is already
  interactive, and the search box is focusable and accepts typing that is applied
  once results land. No layout shift when the data arrives.

- **S20 — A file is edited while a run is reading it.**
  **Given** a run started at 10:00 that loaded the agent's Notes,
  **when** the owner saves a change at 10:01,
  **then** the in-flight run keeps the 10:00 text, the file page shows _"Takes
  effect on the next run · 1 run in flight"_, and the next run picks up the new
  text. The run receipt for the 10:00 run records which revision it used.

## 4. Functional requirements

### 4.1 Memory facts — the list

- **FR-1** The system MUST provide a Facts list at Memory ▸ Facts showing every
  fact in the active workspace, newest first, with the fact text, its origin
  (You / an agent / Tidy-up), its age, and its status.
- **FR-2** A fact body MUST be between 1 and 500 characters after trimming;
  a longer body is refused with the character count in the message.
- **FR-3** The system MUST support at most **2,000 active facts** per workspace.
  The 2,001st write is refused (FR-33 covers the agent-side behaviour).
- **FR-4** The system MUST support at most **200 proposed facts** awaiting review
  per workspace; further proposals are dropped and counted, not queued.
- **FR-5** Search over the Facts list MUST match by meaning, returning at most
  **50** results scored at or above **0.55** cosine similarity, fused with a
  case-insensitive substring match such that **every literal substring hit is
  always included** regardless of its score.
- **FR-6** When no embedding-capable provider resolves, search MUST degrade to
  case-insensitive substring matching and MUST display the degraded-mode note; it
  MUST NOT error.
- **FR-7** Each fact MUST be editable in place; saving MUST take effect for every
  run started after the save and MUST NOT alter runs already in flight.
- **FR-8** Each fact MUST be forgettable individually. Forgetting is soft: the
  fact moves to `forgotten`, stops being recalled immediately, stays restorable
  for **30 days**, and is purged after that by a scheduled sweep.
- **FR-9** The system MUST offer a 10-second **Undo** immediately after a single
  forget.
- **FR-10** The system MUST offer **Forget all**, gated behind a confirmation
  that requires typing the literal string `FORGET ALL`, and the dialog MUST state
  the blast radius before the action is available.
- **FR-11** **Forget all** MUST NOT modify context files, agent files, Memory
  Files, uploads, meetings or Knowledge Base documents.
- **FR-12** After **Forget all**, capture MUST resume with no cool-down and no
  re-enable step.
- **FR-13** A fact MUST carry a scope of either **workspace** (every agent, the
  default) or **agent** (exactly one agent). No third scope exists.
- **FR-14** Up to **20** facts per workspace MAY be **pinned**. Pinned facts are
  injected into every run regardless of relevance, ahead of recalled facts.
- **FR-15** Facts written by an agent during a run MUST land as **Proposed** and
  MUST NOT be recalled until a human accepts them.
- **FR-16** Facts written by a human — typed into the list, or captured from a
  "remember…" turn in that human's own chat — MUST land as **Active** directly.
- **FR-17** Every fact MUST record where it came from: the originating run or
  conversation, and the agent when an agent wrote it. The list MUST expose that
  provenance on the row.
- **FR-18** Every create, edit, forget, restore, accept and discard MUST write one
  row to the activity feed.

### 4.2 Memory facts — recall into a run

- **FR-19** Each run MUST receive a facts block containing, in order: pinned
  facts, then the highest-scoring facts for that run's query.
- **FR-20** Recall MUST return at most **8** facts scored at or above **0.72**
  cosine similarity.
- **FR-21** The facts block MUST be capped at **1,200 tokens**. Facts are dropped
  whole from the lowest score upward; a fact is never cut in half.
- **FR-22** When recall is enabled and returns nothing, the block MUST still be
  present and MUST say so explicitly, so "recall on, nothing matched" is
  distinguishable from "recall off".
- **FR-23** The facts block MUST be delimited and labelled as reference data that
  cannot override the agent's instructions, tool grants or output contract, using
  the same fencing already applied to recalled memory.
- **FR-24** An agent whose memory recall is switched off MUST receive no facts
  block at all.

### 4.3 Workspace context files

- **FR-25** The system MUST provide exactly **six** workspace context files, one
  copy each per workspace, created empty on first visit: **About you**,
  **Organization**, **People**, **Glossary**, **Voice**, **Roster**.
- **FR-26** The set MUST be fixed in v1 — no create, no delete, no rename.
- **FR-27** Each file MUST have a load mode of **Loaded every run** or **Read on
  demand**, defaulting to: About you = every run, Voice = every run, Organization
  / People / Glossary / Roster = on demand.
- **FR-28** At most **3** workspace context files may be set to **Loaded every
  run** at one time; a fourth is refused, naming the current three.
- **FR-29** All files set to **Loaded every run** MUST share a single budget of
  **1,500 tokens**, split proportionally to their length when the total exceeds
  it.
- **FR-30** Files set to **Read on demand** MUST have no load budget and MUST be
  fetchable mid-run by the agent through a tool, on the agent's own initiative.
- **FR-31** A context file body MUST be at most **64 KB**.
- **FR-32** A context file save MUST be refused if the file changed since the
  editor loaded it, preserving the user's unsaved text (scenario S11).
- **FR-33** A context file body MUST be scanned for secrets on write and refused
  when one is detected, naming the field, never echoing the value.

### 4.4 Agent context files

- **FR-34** Each agent MUST gain one new file, **Notes**, alongside its existing
  Identity, Role, Operating loop, Tools and manifest files. Notes is the only
  agent file an agent may write to on its own initiative.
- **FR-35** The Notes file MUST be loaded on every run of that agent with no
  retrieval step.
- **FR-36** An agent MUST NOT write to any agent file — its own or another's —
  unless it holds the existing "edit agent files" permission; without it, it
  returns a proposed change for the human to apply (scenario S17).
- **FR-37** An agent MUST NEVER write to another agent's files, regardless of
  permission.
- **FR-38** Every context file — workspace and agent — MUST keep a revision
  history retaining the last **20** revisions plus every revision younger than
  **30 days**, each attributed to a user, an agent or the system.
- **FR-39** Any retained revision MUST be restorable in one action; restoring
  creates a new revision rather than deleting history.

### 4.5 The load meter

- **FR-40** Every context-file editor — workspace and agent — MUST show a load
  meter reporting: tokens used, the file's budget, the percentage, and the number
  of tokens skipped when over budget.
- **FR-41** The meter MUST have three visible states: **under** (below 90 % of
  budget), **near** (90–100 %), **over** (above 100 %).
- **FR-42** When a file is over budget, the editor MUST identify the exact region
  that is skipped, by character range, and the **Preview** toggle MUST render it
  visibly marked and labelled _"Skipped — the agent never sees this"_.
- **FR-43** Truncation of an authored context file MUST preserve the **head and
  the tail** and drop the **middle** — specifically, the first 70 % of the budget
  from the top and the last 30 % from the bottom, with a single marker line in
  between. Feed-shaped material (recent activity, recent runs, conversation) keeps
  its existing newest-first behaviour and is out of this rule.
- **FR-44** The editor MUST state the authoring rule this truncation implies:
  _"Lead with what matters most — the top of a file is the part that always
  survives."_
- **FR-45** The meter MUST be computable without running the agent, so a file that
  has never been used still shows an accurate figure.
- **FR-46** Each agent MUST have a whole-agent context report listing every
  segment of what it receives per run — identity, role, notes, operating loop,
  tools, skills, workspace context, facts, scope, recent activity, recent runs,
  output contract — each with its budget, its usage and its state.
- **FR-47** The per-segment budgets MUST be exactly:

    | Segment           | Source                            | Budget (tokens)                    |
    | ----------------- | --------------------------------- | ---------------------------------- |
    | Identity          | agent Identity file               | 1,200                              |
    | Role              | agent Role file                   | 1,200                              |
    | Notes             | agent Notes file (new)            | 1,500                              |
    | Capabilities      | agent capabilities text           | 400                                |
    | Operating loop    | agent Operating-loop file         | 800                                |
    | Tools             | agent Tools file + grants         | 1,500                              |
    | Skills            | bound skills                      | 4,000, or the agent's own override |
    | Workspace context | always-loaded context files       | 1,500 shared                       |
    | Memory facts      | pinned + recalled facts           | 1,200                              |
    | Scope prompts     | Work-level prompt customisation   | 600                                |
    | Scope context     | Mission / Idea / Work description | 800                                |
    | Recent activity   | activity feed extract             | 1,200                              |
    | Recent runs       | previous run summaries            | 800                                |
    | Output contract   | response-shape reminder           | 150                                |

- **FR-48** The overall per-run instruction budget MUST be **17,000 tokens**,
  which is strictly above the sum of every segment budget (16,850), so a segment
  budget is always the binding constraint and the overall figure acts only as a
  backstop.
- **FR-49** Whenever a segment is truncated during a real run, the run's log MUST
  record the segment, its budget, its original size and its truncated size.
- **FR-50** The meter shown in the editor MUST agree with what a run actually
  loads for the same content, to the token.

### 4.6 Ask an agent to update this

- **FR-51** Every context-file editor MUST carry an **Ask an agent to update
  this** action.
- **FR-52** For an agent file, the action MUST open chat addressed to that agent
  with a message already started naming the file.
- **FR-53** For a workspace context file, the action MUST open chat with the file
  attached and a message already started naming the file, with an optional agent
  picker; no agent is addressed by default.
- **FR-54** The action MUST attach the file's current content as a context chip.
- **FR-55** Clicking a context chip MUST reveal the exact text that rides along
  with the message — including, where a budget applies, the same skipped region
  marked the same way.
- **FR-56** The attached text MUST never be sent silently truncated: what the chip
  shows is what is sent.

### 4.7 Non-functional

- **NFR-1 Performance.** The Facts list MUST return its first page in under
  400 ms at P95 for a workspace of 2,000 facts. The load report MUST compute in
  under 50 ms at P95 for a 64 KB file.
- **NFR-2 Run impact.** Fact recall MUST NOT delay a run by more than **2,000 ms**;
  past that the run proceeds with no facts block and logs the timeout. Recall
  failure MUST never fail a run.
- **NFR-3 Privacy.** Facts and context files are workspace-scoped data readable
  only by members of that workspace. Cross-workspace reads return 404.
- **NFR-4 Safety.** Content recalled from memory or read from a context file is
  untrusted input; it is fenced, labelled as reference data, and stripped of
  markers that could forge a turn boundary.
- **NFR-5 Observability.** Every capture, recall, truncation, forget and file
  write emits an activity row or a run-log line; the truncation event is the
  telemetry that tells us whether budgets are set correctly.
- **NFR-6 Rate limits.** Fact writes: 60 per minute per user. Context-file
  writes: 60 per minute per user. **Forget all**: 3 per hour per user.
- **NFR-7 Degradation.** With no embedding provider and no vector support, the
  feature stays fully usable: literal search, no semantic recall, an explicit note
  in the UI, and automatic backfill of embeddings when a provider appears.

## 5. Key entities & domain concepts

| Concept                   | New?                                   | Description                                                                                                                                                                                                                                                                                              | States → transitions                                                                                                                                                                        |
| ------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Memory**                | Existing (extended)                    | The workspace's durable knowledge. Until now it meant documents and uploads; it now also has an atomic-fact tier.                                                                                                                                                                                        | —                                                                                                                                                                                           |
| **Memory fact**           | **New**                                | One atomic durable statement — a decision, a preference, a person, a constraint — scoped to the workspace or to one agent.                                                                                                                                                                               | `proposed` → `active` (accept) · `proposed` → `forgotten` (discard) · `active` → `forgotten` (forget) · `forgotten` → `active` (restore, ≤30 days) · `forgotten` → purged (sweep, terminal) |
| **Context file**          | **New noun**                           | An authored document that is injected into runs rather than retrieved as a search result. Two families: **workspace context files** (six, shared) and **agent context files** (per agent). Distinct from both Memory facts (atomic, recalled) and Knowledge Base documents (retrieved, cited). See §5.1. | `empty` → `written` → `written` (each save is a new revision). No delete.                                                                                                                   |
| **Context file revision** | **New**                                | An immutable prior body of a context file with its author and time.                                                                                                                                                                                                                                      | append-only; pruned by the retention rule                                                                                                                                                   |
| **Load report**           | **New (read model, not stored in v1)** | The computed answer to "how much of this reaches the agent". Per segment: budget, used, included, skipped range, state.                                                                                                                                                                                  | computed on demand; from P2 also captured per run                                                                                                                                           |
| **Agent**                 | Existing (extended)                    | Gains one new file, **Notes**.                                                                                                                                                                                                                                                                           | unchanged                                                                                                                                                                                   |
| **Agent file**            | Existing (extended)                    | The canonical per-agent instruction files. The set grows from five to six. Identity and Role keep their meaning; the editor gives them plain-English captions.                                                                                                                                           | unchanged                                                                                                                                                                                   |
| **Run**                   | Existing (extended)                    | Gains a record of what its instruction budget actually spent (P2).                                                                                                                                                                                                                                       | unchanged                                                                                                                                                                                   |
| **Knowledge Base**        | Existing (untouched)                   | Documents with citations and retrieval trails. Explicitly _not_ what a context file is.                                                                                                                                                                                                                  | unchanged                                                                                                                                                                                   |
| **Skill**                 | Existing (untouched)                   | Reusable capability, already a budgeted prompt segment.                                                                                                                                                                                                                                                  | unchanged                                                                                                                                                                                   |

### 5.0 Verbs

**Forget**, not _delete_, is the verb on a fact. This is not new vocabulary: the
platform's own memory capability contract already describes its
delete-one-record operation as the "forget me" operation, so the word is already
ours and the UI simply catches up with it. A fact is _forgotten_; a file is
_saved_; a revision is _restored_; a proposal is _accepted_ or _discarded_. No
other verbs are introduced.

### 5.1 Why "context file" is a new noun and not a synonym

The program's vocabulary table (program [README §1](../README.md)) maps durable
knowledge to **Memory** (facts) and **Knowledge Base** (documents). A context
file is neither:

- It is **not a fact** — facts are atomic, scored and recalled when relevant; a
  context file is prose that is loaded unconditionally or fetched deliberately.
- It is **not a Knowledge Base document** — Knowledge Base documents are chunked,
  embedded, cited and traced back to the retrieval that surfaced them. Context
  files are never chunked, never cited, and their whole value is that they arrive
  whether or not anything retrieved them.
- It is **not a Skill** — a Skill is a capability the agent can perform; a context
  file is what the agent knows.

`Context file` is therefore added to the program vocabulary table in the same
change, with the note that its two families are _workspace context files_ and
_agent context files_.

### 5.2 What this epic deliberately does not add as a new noun

The scope brief mentions "notes / personality / identity files". Ever Works
already has an identity file and a role file per agent. Adding separate
"Personality" and "Identity" files would create two words for one thing, which
program rule #2 forbids. So:

- **Identity** is the existing agent identity file, relabelled in the editor with
  the caption _"Who this agent is — voice, values, how it carries itself."_
- **Role** is the existing agent role file, captioned _"What it owns and how it
  works."_
- **Notes** is the one genuinely new file, and it is new because it is the only
  agent-writable durable tier — a place the agent puts what it learned that no
  human authored.

## 6. UX

### 6.1 Memory page — left rail and sections (additive)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Memory                                                     [ + Add a fact ] │
│  Every fact, file and note your agents carry into a run — visible and editable.│
├──────────────────┬───────────────────────────────────────────────────────────┤
│ FACTS            │                                                           │
│  ● All      182  │   ← the section body renders here                         │
│    Pinned     6  │                                                           │
│    Proposed  12  │                                                           │
│    Forgotten  4  │                                                           │
│                  │                                                           │
│ CONTEXT FILES    │                                                           │
│    About you  ⟳  │   ⟳ = loaded every run                                    │
│    Organization  │                                                           │
│    People        │                                                           │
│    Glossary      │                                                           │
│    Voice      ⟳  │                                                           │
│    Roster        │                                                           │
│                  │                                                           │
│ AGENTS           │                                                           │
│  ▸ Research      │   expands to: Identity · Role · Notes ·                   │
│  ▸ Outreach      │               Operating loop · Tools · Manifest           │
│  ▸ Editor        │                                                           │
│                  │                                                           │
│ ALSO HERE        │   (existing panels, unchanged)                            │
│    Files         │                                                           │
│    Uploads       │                                                           │
│    Review     12 │                                                           │
│    Meetings      │                                                           │
│    Sessions      │                                                           │
│    Settings      │                                                           │
└──────────────────┴───────────────────────────────────────────────────────────┘
```

Copy — rail headings: `Facts`, `Context files`, `Agents`, `Also here`.
Copy — page subtitle: _"Every fact, file and note your agents carry into a run —
visible and editable."_

### 6.2 Facts list — loaded

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ 🔍 Search facts by meaning…                        [ Forget all ]  [ + Add ] │
├──────────────────────────────────────────────────────────────────────────────┤
│ ▌ We never quote a delivery date shorter than ten working days.              │
│   📌 Pinned · You · 3 days ago · used in 14 runs           [Edit] [Forget] ⋯ │
├──────────────────────────────────────────────────────────────────────────────┤
│ ▌ Invoices go out on the first working day of the month.                     │
│   You · 6 days ago · used in 3 runs                        [Edit] [Forget] ⋯ │
├──────────────────────────────────────────────────────────────────────────────┤
│ ▌ The staging database is rebuilt nightly and must never hold real data.     │
│   Research agent · 2 days ago · from run r_8f21 ↗          [Edit] [Forget] ⋯ │
├──────────────────────────────────────────────────────────────────────────────┤
│                       Showing 50 of 182 · [ Load more ]                      │
└──────────────────────────────────────────────────────────────────────────────┘
```

The `⋯` menu holds: **Pin** / **Unpin**, **Limit to one agent…**, **Copy text**,
**Open the run that created this**.

### 6.3 Facts list — searching, empty, no results, over cap

```
SEARCHING (semantic available)                SEARCHING (degraded)
┌────────────────────────────────────────┐    ┌────────────────────────────────────────┐
│ 🔍 delivery promises            [ × ]  │    │ 🔍 delivery promises            [ × ]  │
│ ▌ We never quote a delivery date …     │    │ ⓘ Matching by exact words — meaning-  │
│   ████████░░ 0.81  You · 3 days ago    │    │   based search needs an AI provider.  │
│ ▌ Rush orders still take five days.    │    │   Set one up →                         │
│   █████░░░░░ 0.63  You · 1 week ago    │    │ (no rows: no literal match)            │
└────────────────────────────────────────┘    └────────────────────────────────────────┘

EMPTY (new workspace)                         NO RESULTS
┌────────────────────────────────────────┐    ┌────────────────────────────────────────┐
│           Nothing remembered yet       │    │  No fact matches "refund policy"       │
│                                        │    │                                        │
│  Facts land here when you say          │    │  [ Clear search ]                      │
│  "remember…" in chat, or add one below.│    │  [ Add "refund policy" as a fact ]     │
│                                        │    │                                        │
│           [ + Add a fact ]             │    └────────────────────────────────────────┘
│                                        │
│  Try this in chat:                     │    OVER CAP (2,000 active)
│  ┌──────────────────────────────────┐  │    ┌────────────────────────────────────────┐
│  │ Four things you keep getting     │  │    │ ⚠ Memory is full — 2,000 facts is      │
│  │ wrong: … Store each one, then    │  │    │   the limit. Forget some facts, or     │
│  │ read it back so I can check the  │  │    │   run Tidy up to merge duplicates.     │
│  │ wording you used.                │  │    │                                        │
│  └──────────────────────────────────┘  │    │   [ Tidy up ]  [ Show oldest first ]   │
│                        [ Copy ]        │    └────────────────────────────────────────┘
└────────────────────────────────────────┘
```

### 6.4 Forget — undo toast and Forget all dialog

```
UNDO TOAST (10s)                        FORGET ALL
┌──────────────────────────────────┐    ┌────────────────────────────────────────────┐
│ Forgotten. Agents stop using it  │    │  Forget every fact?                        │
│ from their next run.   [ Undo ]  │    │                                            │
└──────────────────────────────────┘    │  This forgets all 182 active and 12        │
                                        │  proposed facts in this workspace.         │
                                        │                                            │
                                        │  Not affected: your context files, agent   │
                                        │  files, uploads, meetings and Knowledge    │
                                        │  Base. Agents begin picking things up      │
                                        │  again straight away.                      │
                                        │                                            │
                                        │  Type FORGET ALL to confirm                │
                                        │  ┌──────────────────────────────────────┐  │
                                        │  │                                      │  │
                                        │  └──────────────────────────────────────┘  │
                                        │              [ Cancel ]  [ Forget all ]    │
                                        └────────────────────────────────────────────┘
```

`Forget all` stays disabled until the field contains exactly `FORGET ALL`.

### 6.5 Context file editor — under budget

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Voice                                        ⟳ Loaded every run  [ Change ] │
│  How your agents write: tone, style, words to use and avoid.                 │
├──────────────────────────────────────────────────────────────────────────────┤
│  [ Write ] [ Preview ]              [ Ask an agent to update this ]  [ Save ]│
├──────────────────────────────────────────────────────────────────────────────┤
│  Short sentences. No exclamation marks.                                      │
│  Never say "reach out" — say "email" or "call".                              │
│  Sign off with the person's first name only.                                 │
│                                                                              │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│  Reaches the agent                                                           │
│  ████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  340 / 1,500 tokens  ·  all of it     │
│  Most important lines first — the top of the file is what always survives.   │
│  Saved 2 minutes ago · Takes effect on the next run · History (4)            │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 6.6 Context file editor — over budget, and the marked skipped region

```
WRITE MODE (over)
┌──────────────────────────────────────────────────────────────────────────────┐
│  Notes — Research agent                            ⟳ Loaded every run        │
├──────────────────────────────────────────────────────────────────────────────┤
│  [ Write ] [ Preview ]              [ Ask an agent to update this ]  [ Save ]│
├──────────────────────────────────────────────────────────────────────────────┤
│  … editor text …                                                             │
├──────────────────────────────────────────────────────────────────────────────┤
│  Reaches the agent                                                           │
│  ███████████████████████████████████████████████  1,500 / 1,500 tokens       │
│  ⚠ 2,600 tokens are skipped — the middle of this file never reaches the      │
│    agent. See it in Preview, or trim about 10,400 characters.                │
│    [ Show what is skipped ]                                                  │
└──────────────────────────────────────────────────────────────────────────────┘

PREVIEW MODE (over) — the skipped region is marked in place
┌──────────────────────────────────────────────────────────────────────────────┐
│  [ Write ] [ Preview ]                                                       │
├──────────────────────────────────────────────────────────────────────────────┤
│  Always check the staging branch before opening a pull request.              │
│  The release train leaves on Tuesdays at 14:00 UTC.                          │
│  …                                                                           │
│ ╔══════════════════════════════════════════════════════════════════════════╗ │
│ ║ ▒▒▒▒▒▒▒ Skipped — the agent never sees this ▒▒▒▒▒▒▒                      ║ │
│ ║ ▒ 10,412 characters (2,600 tokens), lines 41–318                        ▒ ║ │
│ ║ ▒ Move anything that matters above this block.                          ▒ ║ │
│ ║ ▒ …                                                                     ▒ ║ │
│ ║ ▒ (the skipped text itself, dimmed and struck through)                  ▒ ║ │
│ ╚══════════════════════════════════════════════════════════════════════════╝ │
│  Rotate the API credentials on the first of each quarter.                    │
│  Escalate anything touching billing to a human.                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

The marked block uses a warning surface token plus a hatched fill and struck-through
text — never colour alone, so it survives a monochrome or high-contrast rendering
(WCAG 2.2 AA, 1.4.1 Use of Colour).

### 6.7 Whole-agent context report

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Research agent — what it receives every run              14,120 / 17,000    │
├──────────────────────────────────────────────────────────────────────────────┤
│  Identity          ██████░░░░░░░░░░   720 / 1,200                            │
│  Role              ████████████░░░░ 1,010 / 1,200                            │
│  Notes             ████████████████ 1,500 / 1,500   ⚠ 2,600 skipped   [Open] │
│  Capabilities      ███░░░░░░░░░░░░░    90 /   400                            │
│  Operating loop    ██████████░░░░░░   540 /   800                            │
│  Tools             ███████████░░░░░ 1,080 / 1,500                            │
│  Skills            ███████████████░ 3,760 / 4,000   3 skills bound           │
│  Workspace context ████████████░░░░ 1,120 / 1,500   About you, Voice         │
│  Memory facts      ██████████░░░░░░   790 / 1,200   6 pinned + 4 recalled    │
│  Scope prompts     ░░░░░░░░░░░░░░░░     0 /   600   none set                 │
│  Scope context     █████░░░░░░░░░░░   260 /   800                            │
│  Recent activity   ███████████░░░░░   900 / 1,200                            │
│  Recent runs       ████████░░░░░░░░   400 /   800                            │
│  Output contract   ████████████████   150 /   150                            │
├──────────────────────────────────────────────────────────────────────────────┤
│  Measured from the current content — no run needed. Last run agreed: ✓       │
└──────────────────────────────────────────────────────────────────────────────┘
```

Empty state (a brand-new agent): every bar at zero, with _"Nothing written yet —
this agent runs on defaults."_
Error state (report cannot be computed): _"Couldn't measure this agent's context.
Retry"_ with the bars replaced by a single inline error row; the editor above
stays fully usable.

### 6.8 Ask an agent to update this → chat, and the context chip

```
CHAT PANEL, OPENED BY THE BUTTON            CHIP EXPANDED (click the chip)
┌────────────────────────────────────┐      ┌────────────────────────────────────┐
│  Chat                        [ × ] │      │  Notes — Research agent      [ × ] │
│                                    │      │  What rides along with your        │
│  …                                 │      │  message, exactly as sent:         │
│                                    │      │ ┌────────────────────────────────┐ │
├────────────────────────────────────┤      │ │ Always check the staging …     │ │
│ 📎 Notes — Research agent   [ × ]  │      │ │ The release train leaves …     │ │
│ ┌────────────────────────────────┐ │      │ │ ╔════════════════════════════╗ │ │
│ │ @research-agent update your    │ │      │ │ ║ Skipped — the agent never  ║ │ │
│ │ Notes file: ▌                  │ │      │ │ ║ sees this · 10,412 chars   ║ │ │
│ └────────────────────────────────┘ │      │ │ ╚════════════════════════════╝ │ │
│                          [ Send ]  │      │ │ Rotate the API credentials …   │ │
└────────────────────────────────────┘      │ └────────────────────────────────┘ │
                                            └────────────────────────────────────┘
```

Copy — button: `Ask an agent to update this`.
Copy — pre-filled message, agent file: `@{agent-slug} update your {File} file: `
Copy — pre-filled message, workspace file: `Update the {File} context file: `
Copy — chip title on expand: `What rides along with your message, exactly as sent:`
Copy — when the agent lacks the permission: _"I can't edit my own files — here's
the change I'd make."_ with **Apply** / **Discard**.

### 6.9 Concurrent-edit conflict

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ⚠ This file changed while you were editing.                                  │
│   Reload to see the current version — your text is kept below.               │
│   Changed by Marina 40 seconds ago.        [ Compare ]  [ Reload ]  [ Keep ] │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Keep** copies the user's text to the clipboard and leaves the editor untouched;
nothing is written until they reload and re-save.

### 6.10 Keyboard affordances

| Where             | Key              | Action                                                          |
| ----------------- | ---------------- | --------------------------------------------------------------- |
| Memory page       | `/`              | Focus the Facts search box                                      |
| Memory page       | `g` then `f`     | Jump to Facts · `g` `c` Context files · `g` `a` Agents          |
| Facts list        | `↑` `↓`          | Move the row focus                                              |
| Facts list        | `Enter`          | Open the focused fact for editing                               |
| Facts list        | `e`              | Edit the focused fact in place                                  |
| Facts list        | `f`              | Forget the focused fact (undo toast follows)                    |
| Facts list        | `p`              | Pin / unpin the focused fact                                    |
| Fact editor       | `Esc`            | Cancel the edit, restoring the previous text                    |
| Fact editor       | `⌘/Ctrl` `Enter` | Save and close                                                  |
| File editor       | `⌘/Ctrl` `S`     | Save                                                            |
| File editor       | `⌘/Ctrl` `⇧` `P` | Toggle Write / Preview                                          |
| File editor       | `⌘/Ctrl` `⇧` `A` | Ask an agent to update this                                     |
| Preview           | `n` / `N`        | Jump to the next / previous skipped block                       |
| Forget-all dialog | `Esc`            | Cancel (never confirms)                                         |
| Any dialog        | `Tab`            | Cycles within the dialog; focus returns to the trigger on close |

Every meter exposes its numbers to assistive technology as text
(_"Notes: 1,500 of 1,500 tokens used, 2,600 tokens skipped"_), not only as a bar.

## 7. Out of scope

- **Levels, promotion and agent seniority** — AW-23 owns those; this epic only
  ships the files they will build on.
- **Knowledge Base changes.** Documents, citations, retrieval trails, the
  workbench and the `#`-reference syntax are AW-06. A context file is never
  chunked, embedded as a document, or cited.
- **A general document tool for agents.** This epic adds a tool for the six
  workspace context files only. The broader "fetch me a Knowledge Base document"
  tool — which today is a placeholder that always returns an error — is AW-06's.
- **Memory across workspaces.** Facts never leak between organizations, and there
  is no mechanism to share them.
- **User-defined context files.** The set of six is fixed in v1. Adding, renaming
  or deleting them is not offered.
- **Automatic fact capture from draft rewrites or decision answers.** Capture in
  v1 is explicit (a human says "remember…", or an agent calls the tool). Learning
  from ordinary corrective behaviour is a follow-up once we can measure proposal
  quality.
- **Replacing the existing memory-provider plugin capability.** Provider-backed
  memory keeps working exactly as it does today, side by side. This epic does not
  migrate its data.
- **Per-model or per-plan budgets.** Budgets are fixed numbers in v1. Making them
  vary by model belongs with AW-16, and by plan with AW-17.
- **Cost attribution for the extra tokens.** The instruction budget rises from
  12,000 to 17,000; reporting what that costs is AW-09 / AW-17.
- **Conflict resolution between a fact and a file.** If a fact contradicts a
  context file, v1 injects both and lets the agent reconcile. A precedence rule is
  an open question (§9).

## 8. Acceptance criteria

- [ ] Memory ▸ Facts lists every fact in the active workspace with origin, age and
      status, and pages beyond 50 rows.
- [ ] Typing a phrase that shares no words with a stored fact still finds it, and
      every literal substring hit is present in the results.
- [ ] With no embedding provider configured, search still returns literal matches
      and displays the degraded-mode note; nothing errors.
- [ ] Editing a fact takes effect on the next run and not on a run in flight, and
      the row says how many runs are in flight.
- [ ] Forgetting one fact removes it from recall immediately, offers Undo for
      10 seconds, and leaves it restorable for 30 days under the Forgotten filter.
- [ ] **Forget all** requires typing `FORGET ALL`, states its blast radius before
      it is available, and leaves context files, agent files, uploads, meetings and
      Knowledge Base documents untouched (verified by asserting each is still
      readable and unchanged afterwards).
- [ ] Adding a 2,001st active fact is refused with the limit named in the message,
      and the same refusal inside a run logs a line without failing the run.
- [ ] A fact written by an agent during a run appears as **Proposed**, is not
      recalled, and becomes recallable only after a human accepts it.
- [ ] With 200 proposals waiting, the next proposal is dropped and a run-log line
      records it.
- [ ] All six workspace context files exist on first visit, empty, with the
      documented default load modes.
- [ ] Setting a fourth file to **Loaded every run** is refused with the three
      current always-loaded files named.
- [ ] Saving a context file that changed underneath preserves the user's text and
      refuses the write.
- [ ] Every agent has a **Notes** file; it loads on every run of that agent; an
      agent without the file-edit permission cannot write it and instead returns a
      proposed change.
- [ ] No agent can write to another agent's files under any permission.
- [ ] Restoring a revision creates a new revision and does not delete history.
- [ ] The load meter shows used/budget/percentage on a file that has never been
      used in a run.
- [ ] For a file over budget, Preview marks the skipped region, states its
      character count and line range, and the marking is legible without colour.
- [ ] The head and the tail of an over-budget file survive; the middle is what is
      dropped; the ratio is 70/30.
- [ ] The number the editor shows equals, to the token, what the next run of that
      agent actually loads for the same content.
- [ ] The whole-agent report lists all fourteen segments with their budgets from
      the FR-47 table.
- [ ] A truncation during a real run writes a log line naming the segment, the
      budget, the original size and the truncated size.
- [ ] **Ask an agent to update this** opens chat with the file attached and the
      message pre-filled; the chip expands to exactly the text that is sent,
      including the marked skipped region.
- [ ] A fact or context file belonging to another organization returns 404, not 403.
- [ ] Every keyboard affordance in §6.10 works, and focus returns to the trigger
      when a dialog closes.
- [ ] Every user-visible string is a message key; no literal English in a
      component.
- [ ] All functional requirements have a passing test — unit, controller spec or
      end-to-end.

## 9. Open questions

- `[NEEDS CLARIFICATION: precedence when a fact contradicts a context file. v1 injects both. Do we want an explicit rule ("the file wins, it was authored deliberately") stated in the prompt, or do we leave it to the model and measure how often it goes wrong?]`
- `[NEEDS CLARIFICATION: is "About you" per human or per workspace? A workspace with three owners has three different people to describe. Per-workspace is simpler and matches the anti-drift goal; per-human is more accurate but multiplies the always-loaded budget by the number of members.]`
- `[NEEDS CLARIFICATION: should accepting a proposed fact be part of the existing Review panel, or its own queue? Folding it in avoids a second review surface, but the existing panel reviews documents, and mixing units may confuse.]`
- `[NEEDS CLARIFICATION: do we auto-merge near-duplicate facts, or only propose merges through the existing tidy-up flow? Auto-merge keeps the list clean; proposing keeps the human in the loop, which is the current posture everywhere else.]`
- `[NEEDS CLARIFICATION: raising the instruction budget from 12,000 to 17,000 tokens increases the cost of every run by roughly 40 % of its instruction share. Product to confirm the trade, and whether smaller-context models need a reduced profile — likely an AW-16 dependency.]`
- `[NEEDS CLARIFICATION: should a fact expire on its own? A "last used 8 months ago" fact is probably stale, but silent expiry undermines the whole promise that a fact stated once keeps holding. A surfaced suggestion ("4 facts have not been used in 6 months — review?") may be the middle ground.]`
- `[NEEDS CLARIFICATION: should the Roster context file be generated from the agent list rather than typed, so it cannot go stale? Generated content in a hand-editable file is a known source of confusion.]`

## 10. Constitution gates

- [x] **I — Plugin-first.** No new external integration. Facts are first-party
      data; embeddings are obtained through the existing capability facade, which
      resolves whichever provider plugin is configured. The optional memory
      provider plugin keeps working unchanged alongside.
- [x] **II — Capability-driven.** No plugin id appears anywhere outside a plugin
      package; embedding and vector support are requested by capability.
- [x] **III — Source-of-truth repos.** Facts and context files are platform
      metadata about how agents behave, not Work content, so they stay in the
      database. Work content is untouched.
- [x] **IV — Background work via the configured job runtime.** Embedding a fact
      and purging forgotten facts run as jobs dispatched through the job-runtime
      abstraction, never as in-process work on the request path.
- [x] **V — Forward-only migrations.** Every new table and column ships with an
      additive migration in the same change; no column is dropped or renamed.
- [x] **VI — Tests.** Unit tests for budget maths and truncation, controller specs
      for every endpoint, and end-to-end coverage for the facts journey, the
      over-budget preview and the ask-an-agent flow.
- [x] **VII — Secrets.** Context-file bodies are secret-scanned on write and
      refused when a credential is detected; no secret is echoed back.
- [x] **VIII — Plugin counts.** No plugin is added, so the canonical plugin doc is
      untouched.
- [x] **IX — Behaviour-first.** This document names no class, file or endpoint.
- [x] **X — Backwards compatibility.** Existing endpoints keep their shapes; the
      agent-file endpoints gain one additional accepted file name; every new field
      is optional.

## 11. References

- Program: [Agent Workspace README](../README.md) · [tracker](../TRACKER.md)
- Neighbouring epics: AW-06 (knowledge library), AW-08 (skills shelf),
  AW-09 (runs & receipts), AW-12 (chat), AW-16 (models), AW-23 (agent identity),
  AW-24 (safety rails)
- House style reference: [`docs/specs/features/schedules/spec.md`](../../schedules/spec.md)
- Plan: [`./plan.md`](./plan.md) · Tasks: [`./tasks.md`](./tasks.md)
