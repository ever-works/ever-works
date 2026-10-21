# FL-19 — Agent, MCP & CLI surface

> Behaviour-first spec per [Constitution Principle IX](https://github.com/ever-works/ever-works/blob/develop/.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> No class names, no file paths, no code. Implementation lives in [plan.md](./plan.md).

**Epic ID:** `FL-19-agent-mcp-cli`
**Program:** [Fleet](../README.md) · Wave 2
**Branch:** `feat/fl-19-agent-mcp-cli`
**Status:** `Draft`
**Created:** 2026-10-18
**Last updated:** 2026-10-18
**Size:** M · **Blocked by:** FL-01 (roles, needs-a-look registry), FL-02 (operations), FL-04 (the first family) for P1–P2; each family's epic for its own catalogue rows as it lands — FL-16, FL-17, FL-18 (Wave 3) for P3 · **Related:** FL-01 (roles, needs a look), FL-02 (operations), AW-15 (tool grants), AW-24 (trust ladder), AW-03 (Decisions)
**Extends (existing Ever Works nouns):** Agent · Agent tool · MCP server · CLI · Node (UI: "Computer") · Session · Command · Schedule · Checkout · Run · Decision · Fleet audit

---

## 0. TL;DR

Everything a person can do to a computer from the Fleet hub, an Agent can do through a tool, an
external assistant can do through the MCP server, and a shell can do through `ever-works fleet …`
— **the same API, the same shapes, the same typed errors with a fix hint**. Every tool is named
`fleet_<family>_<verb>`, says whether it is read-only or destructive, and names its confirmation
class. An Agent may act in a family only when three gates agree: its tool grants allow the tool,
its trust ladder allows the category, and the computer's owner has let that Agent's owner into the
family. One tool, `fleet_status`, answers "how is my fleet?" in a single call. Every
state-changing call writes the audit row with `requestedBy: agent:<id>`.

```
 AGENT › Nina › Capabilities › Fleet tools                                      [inherits each family's flag]
 ─────────────────────────────────────────────────────────────────────────────────────────────────
 Nina can reach your computers through tools. What she may do depends on three things:
   her tool grants (AW-15) · her trust ladder (AW-24) · what each computer's owner allows (Fleet).
 ┌ family        read            act                 why not                                        ┐
 │ status/view   ✓ always        —                                                                  │
 │ sessions      ✓               ✓ Ask               build-01 ✓ · build-02 ✗ owner allows only owner │
 │ commands      ✓               ✓ Ask               build-01 ✓                                     │
 │ services      ✓               ✗ Off               ladder: "Change a computer" is Off for Nina     │
 │ files         ✓               ✗ denied            tool grant denies fleet_files_*                 │
 │ schedules     ✓               ✓ Ask               build-01 ✓                                     │
 └───────────────────────────────────────────────────────────────────────────────────────────────┘
 Tools never carry a credential. Nina acts through the platform; the platform asks the computer.

 $ ever-works fleet status --json
 { "ok": true, "data": { "computers": [ { "name": "build-01", "status": "online", … } ],
                         "needsALook": [ { "kind": "disk-low", "nodeName": "design-mac", … } ] } }
 $ ever-works fleet services action nginx restart --on build-01
 ✗ confirmation_required — Restart nginx on build-01? Re-run with --yes to confirm.      (exit 2)
```

| Phase  | Ships                                                                                                                                                                                                                                                                                            |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **P1** | The gate (grants × ladder × node audience), tool annotations, typed errors, `fleet_status`, read-only tools for every shipped family, `wait:false` + `fleet_operations_get`, the CLI `fleet` group with `--json` and exit codes, MCP read-only additions, Agent Capabilities "Fleet tools" block |
| **P2** | State-changing tools for every shipped family with confirmation arguments and Decisions at the Ask rung, `fleet_sessions_question` / `fleet_sessions_answer`, `ever-works fleet sessions attach`, MCP state-changing additions, audit `requestedBy: agent:<id>` everywhere                       |
| **P3** | Tools for FL-16/17/18 (virtual, cloud, runners) as those epics land; the agent-facing doc; the CLI shell-completion                                                                                                                                                                              |

---

## 1. Overview

Today an Agent sees one fleet tool, `list_fleet_nodes`; the MCP server exposes eight fleet entries —
four reads, three affinity entries and drain (EXISTING-SUBSTRATE §8.2); the CLI has no fleet verbs.
The program adds machine actions in thirteen permission families (CONTRACTS §2.1); without this epic
each would invent its own tool shape, its own error vocabulary and its own idea of permission. This
epic fixes them once:

- **Naming and annotations.** Tools are `fleet_<family>_<verb>`. A read-only tool is marked so and
  is always available to an Agent that may _see_ the computer. A state-changing tool is marked
  destructive or not, carries its confirmation class, and its AW-24 category.
- **One gate.** A state-changing tool runs only when the Agent's tool grants allow it, the trust
  ladder allows its category (Auto runs; Ask or Draft creates a Decision; Off refuses), **and** the
  computer's family audience includes the Agent's owner — plus the computer's consent. Refusals are
  typed and say which gate refused and what would fix it.
- **Confirmation without a browser.** Where a human sees a dialog, a tool call sees a first reply
  (409 `confirmation_required` with the summary) that describes exactly what would happen and a
  second call that confirms it — `confirm: true` for the `confirm` class, the target's name for
  `confirm-destructive`, an explicit acknowledgement of the node-computed warning for
  `blast-radius`. The web dialog uses the same fields (CONTRACTS §2.2); there are no confirmation
  tokens.
- **Long operations.** Any tool that may take more than a few seconds accepts `wait: false` and
  returns an operation id the caller polls with `fleet_operations_get`.
- **Three surfaces, one shape.** The MCP server exposes the same routes through its whitelist; the
  CLI prints the same objects with `--json` and exits `0 / 1 / 2 / 124`.

---

## 2. Why now

### 2.1 The user's question

> _"Let Nina check the machines and restart the service herself — but never let her touch
> build-02, and ask me before anything that changes a machine."_

### 2.2 What they do today, and why it does not answer the question

| To answer…                                    | Today…                                                                                                                                                                                                                                                                                              | What breaks                                                                                                                                   |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| "What can my Agent do to my computers?"       | One tool, `list_fleet_nodes`, read-only (`packages/agent/src/fleet/agent-fleet-tools.ts:39-77`), assembled with no annotation of any kind (`packages/agent/src/agents/agent-tool.service.ts:128-137`).                                                                                              | There is no act, and no way to mark a tool as read-only or destructive: the descriptor has name, description, parameters and invoke.          |
| "Who decides whether Nina may restart nginx?" | Tool grants decide tool _names_ (`packages/contracts/src/policy/tool-grant.types.ts:20-54`); the trust ladder decides categories including `machine.run` and `machine.admin` (AW-24 §4.1); the computer's control policy decides _people_ (`packages/agent/src/entities/fleet-node.entity.ts:502`). | The three never meet. Nothing checks a computer's family audience against an Agent's owner, because no Agent action reaches a computer today. |
| "Let an external assistant do it over MCP."   | Eight fleet entries in the whitelist, reads plus affinity and drain; enrolment deliberately not exposed (`apps/mcp/src/openapi-tools/whitelist.ts:475-530`).                                                                                                                                        | Fine as far as it goes; every new family must be added in one place with the right annotations or it is silently missing.                     |
| "Script it."                                  | The CLI has `auth`, `work`, `plugins`, `kb` (`apps/cli/src/main.ts:22-26`); errors print a message and exit 1 (`apps/cli/src/utils/error.ts:3-32`); no `--json` envelope.                                                                                                                           | No fleet verbs, no machine-readable errors, no exit-code contract, no way to attach to a session from a terminal.                             |

### 2.3 Why this epic is additive only

Existing tool names (`list_fleet_nodes` on both surfaces, the seven other MCP fleet entries) are
kept; new tools are added beside them. The tool descriptor gains optional annotations. The CLI
gains a command group. No permission semantics change: the tool-grant matrix still narrows only,
the ladder still resolves platform → Workspace → Agent, the computer's control policy still belongs
to its owner (D15).

---

## 3. User scenarios

### 3.1 Primary scenarios

- **S1 — One call for "how is my fleet?".**
  **Given** Agent `Ops` has the default grants,
  **when** it calls `fleet_status`,
  **then** it receives, in one reply, every computer the owner can see (name, status, platform,
  consents, health summary, session count), the Needs-a-look list with kinds and actions, the
  kill-switch state, and `generatedAt`; the call is read-only and needs no confirmation.

- **S2 — A read that is always allowed.**
  **Given** `build-01`'s `logs` audience includes `Ops`'s owner (log reads are the `logs` family,
  CONTRACTS §2.1),
  **when** it calls `fleet_logs_read` for the system log,
  **then** it receives the last 500 lines; no Decision is created and no audit row is written for a
  read, exactly as the web surface behaves.

- **S3 — An act at the Ask rung.**
  **Given** `Nina`'s ladder puts _Change a computer_ at **Ask** and `build-01`'s owner has set the
  `services` family to **org-members**,
  **when** she calls `fleet_services_action` with `{ node: 'build-01', service: 'nginx', action: 'restart' }`,
  **then** the call is held as an `agent_action_proposals` row (CONTRACTS R-33) and the tool returns
  `{ held: true, decisionId }`; a Decision appears in My Decisions
  reading _"Nina wants to restart nginx on build-01"_ with the confirm class and the node's
  blast-radius sentence when there is one; approving executes it, writes `node.service.restart`
  with `requestedBy: agent:<Nina>`, and the tool's follow-up `fleet_operations_get` reports done.

- **S4 — An act at the Auto rung needs the two-step confirm.**
  **Given** `Ops` is at **Auto** for _Run commands on a computer_,
  **when** it calls `fleet_commands_run` without `confirm`,
  **then** it receives `confirmation_required` with `details.summary` naming the computers, shell
  and user and the hint _"call again with confirm: true"_; the second call runs and returns the
  output cards.

- **S5 — Refused by the computer's owner.**
  **Given** `build-02`'s `services` family is **owner** and Nina's owner is an Organization member,
  **when** Nina calls `fleet_services_action` on `build-02`,
  **then** she receives `permission_denied` with the hint _"ask the owner of build-02 to allow org
  members: services"_, nothing is held and nothing is audited except the refusal record (AW-24).

- **S6 — Unblocking another Agent's session.**
  **Given** `Nina`'s session on `build-01` is _needs you_ with the **question** _"Overwrite
  .env.local?"_, `Ops` has been granted `fleet_sessions_answer`, and `Ops`'s owner switched on
  "may answer other sessions" for `Ops` (CONTRACTS R-32; the setting is FL-05's),
  **when** `Ops` calls `fleet_sessions_question` for that session and then
  `fleet_sessions_answer` with `{ key, answer: 'no', confirm: true }`,
  **then** the answer reaches the session, the attention clears on every surface, and the audit row
  `node.session.answer` names `agent:<Ops>`; an Agent without the grant or the setting is refused
  `permission_denied` with the hint naming what is missing, and a **permission** prompt is refused
  for every Agent — _"permission prompts are answered by people"_.

- **S7 — From the CLI.**
  **Given** the owner is signed in,
  **when** they run `ever-works fleet sessions list --on build-01 --json`,
  **then** they get `{ "ok": true, "data": [...] }` with the same `FleetSessionView` objects the
  web uses, exit `0`; `ever-works fleet sessions attach <id>` (the singular `session` group is an
  alias) opens the session's terminal in their own terminal (read-only unless `--drive`), and
  `Ctrl-]` detaches without ending it.

- **S8 — The MCP server exposes the same.**
  **Given** an external assistant is connected to the MCP server with the owner's API key,
  **when** it lists tools,
  **then** it sees the existing eight fleet tools plus the new ones, each with `readOnlyHint` or
  `destructiveHint`, and `fleet_commands_run` carries the same confirm argument; a refusal is the
  same `{ error: { code, hint } }`.

### 3.2 Edge cases and failures

- **U1 — Node offline.** Any tool on an offline computer returns `unreachable` with _"last seen 12
  min ago"_ and, when FL-03's wake is possible, _"wake it from build-02?"_.
- **U2 — Consent missing.** `consent_missing` with the exact `ever-works-node start --manage` (or
  `--work`, `--attend`) sentence; the tool list still shows the tool (availability is per computer,
  not per tool).
- **U3 — Kill switch.** Every state-changing tool returns `kill_switch` with _"clear it under
  Settings → Fleet"_; read tools keep working; `fleet_status` reports the switch.
- **U4 — Rung Off.** The tool is present but returns `permission_denied` with
  _"'Change a computer' is Off for Nina — raise it on her Safety tab"_; the refusal is recorded.
- **U5 — Grant denied.** `permission_denied` with _"fleet_files_write is denied by a tool grant at
  Work scope"_.
- **U6 — Limit exceeded.** `limit_exceeded` naming the §10 limit (_"8 owner sessions on build-01"_).
- **U7 — Link drops mid-operation.** `wait: true` calls return `operation_failed` with
  `details.operationId`; the caller polls `fleet_operations_get`, which reports `interrupted`
  (CONTRACTS §3.3 — never `done`) or the late result when the node reconnects.
- **U8 — Target changed between the two calls.** A `confirm: true` call is evaluated against the
  computer's state at that moment (no token or stored summary exists — CONTRACTS §2.2): a service
  that disappeared answers `not_found`, an offline computer `unreachable`, and a blast-radius warning
  that appeared since the first reply answers `confirmation_required` with the sentence until
  `acknowledgeBlastRadius: true` is sent.
- **U9 — Wrong name on destructive confirm.** `confirm-destructive` with the wrong `confirmName`
  → `invalid` with the hint _"type the exact name: win-11-vm"_.
- **U10 — CLI without a TTY.** A `confirm` class verb without `--yes` in a non-interactive shell
  exits `2` with the summary on stderr and the JSON error on stdout when `--json`.
- **U11 — MCP without Organization scope.** Family checks that need the Organization (R-19) return
  `invalid` with the existing scope hint used by the affinity tools.
- **U12 — Held action goes stale.** A held fleet action (an `agent_action_proposals` row, R-33)
  approved more than 24 h after it was raised does not run: approval answers `confirmation_required`
  with a fresh summary and the Agent must ask again (default until §8b is answered); nothing runs on
  its own.

---

## 4. Functional requirements

### 4.1 Catalogue and annotations (P1)

- **FR-1** Every fleet tool MUST be named `fleet_<family>_<verb>` (CONTRACTS §11.3) where `family` is
  the plural noun or API path segment of the thing acted on: `status · nodes · sessions · desktop ·
logs · services · processes · docker · ports · files · commands · schedules · checkouts · tasks ·
virtual · cloud · runners · usage · operations` (Compose is under `docker`, paste under `desktop`,
  health, wake and git identity under `nodes`). The tool family is a name, not a permission: each
  catalogue row also names its CONTRACTS §2.1 permission family.
- **FR-2** Every tool MUST declare `readOnly: true` or `destructive: true|false`; a non-read tool
  MUST also declare its confirmation class and its AW-24 category.
- **FR-3** Existing tool names (`list_fleet_nodes` on both surfaces and the seven other MCP fleet
  entries) MUST keep working unchanged.
- **FR-4** `fleet_status` MUST return computers, the Needs-a-look list, the kill-switch state and a
  server timestamp in one read-only call.
- **FR-5** Every tool reply MUST be either a result or `{ error: { code, hint, details } }` with a
  code from CONTRACTS §8; a hint MUST name the action that would fix the refusal.

### 4.2 The gate (P1 reads, P2 acts)

- **FR-6** A read-only fleet tool MUST be callable by an Agent whenever the Agent's tool grants
  allow its name and the computer's audience for the row's permission family includes the Agent's
  owner (CONTRACTS §2.1: `view` for status, nodes, port lists and `health.now`; `logs` for log reads;
  the family itself for the other families' lists).
- **FR-7** A state-changing fleet tool MUST run only when: the tool grants allow its name; the
  trust ladder resolves its category to **Auto** (or to **Ask**/**Draft**, in which case a Decision
  is created and the tool returns `held`); the computer's family audience includes the Agent's
  owner; and the computer holds the family's consent.
- **FR-8** The gate MUST evaluate in the AW-24 order — stop flag, Workspace pause, Agent pause,
  grants, ladder, caps, then the computer's audience and consent — and the first refusal MUST win
  and MUST be named in the error.
- **FR-9** A refusal by the ladder or grants MUST be recorded as an AW-24 refusal; a refusal by the
  computer's audience MUST NOT create a Decision (a person outside the audience cannot approve it).
- **FR-10** An Agent-initiated state change MUST write the family's audit row with `requestedBy:
agent:<agentId>` and the Decision id when one was involved.

### 4.3 Confirmation for non-interactive callers (P2)

- **FR-11** A `confirm` class tool called without `confirm: true` MUST return 409
  `confirmation_required` with `details: { class, summary, preview? }` describing exactly what would
  happen (CONTRACTS §2.2), and MUST execute when called again with `confirm: true`, evaluated against
  the state at that moment (U8).
- **FR-12** A `confirm-destructive` class tool MUST require `confirmName` equal to the target's
  display name.
- **FR-13** A `blast-radius` class tool MUST first return the node-computed warning and MUST
  require `acknowledgeBlastRadius: true` to proceed.
- **FR-14** A tool MUST accept `wait: false` and return `{ operationId }` for any action that may
  exceed 5 seconds; `fleet_operations_get` MUST report the CONTRACTS §3.3 states `running · done ·
failed · cancelled · interrupted` with the result or the error.

### 4.4 Sessions between Agents (P2)

- **FR-15** `fleet_sessions_question` MUST return a session's pending attention (reason, prompt,
  options, key) to an Agent allowed to see that computer's `sessions` family.
- **FR-16** `fleet_sessions_answer` MUST deliver an answer to another Agent's or an owner's session
  only for a **question** (permission prompts are human-only in every case), only when the calling
  Agent's owner enabled "may answer other sessions" on it (CONTRACTS R-32; FL-05 FR-30), its grants
  allow the tool, its ladder allows `machine.run`, and the computer's `sessions` audience includes
  its owner; it MUST be audited as `node.session.answer` with `requestedBy: agent:<id>`.

### 4.5 MCP (P1 reads, P2 acts)

- **FR-17** The MCP server MUST expose every fleet route that the web uses, except enrolment,
  heartbeat, lease and node-credential routes, each with `readOnlyHint` or `destructiveHint`.
- **FR-18** MCP tools MUST accept the same confirmation arguments (FR-11–13) and return the same
  errors; they act as the API-key user, not as an Agent, so the computer's audience is checked
  against that user.

### 4.6 CLI (P1)

- **FR-19** The CLI MUST offer `ever-works fleet <family> <verb>` for every family, each with
  `--json` printing `{ ok: true, data }` or `{ ok: false, error: { code, hint, details } }`.
- **FR-20** Exit codes MUST be `0` success, `1` the action failed or was refused, `2` usage error
  or missing confirmation, `124` a command timed out.
- **FR-21** `confirm` class verbs MUST prompt on a TTY and MUST require `--yes` otherwise;
  `confirm-destructive` verbs MUST require `--confirm-name <name>`.
- **FR-22** `ever-works fleet sessions attach <id>` (alias `fleet session attach`) MUST render the
  session's terminal in the
  caller's terminal, read-only by default and typable with `--drive` when the caller may drive,
  and MUST detach on `Ctrl-]` without ending the session.
- **FR-23** The CLI MUST never store or print a machine credential; it authenticates to the
  platform only, as today.

### 4.7 Visibility and honesty (P1)

- **FR-24** The Agent's Capabilities tab MUST show a **Fleet tools** block listing, per family,
  whether the Agent can read and act, and when not, which gate refuses and where to change it.
- **FR-25** Every tool description MUST state that the tool spends no credits by itself and that
  the Agent's own Run carries the cost of its reasoning; `fleet_usage_get` MUST be the way to ask
  "what did it cost?" (FL-20).

---

## 5. UX

### 5.1 Agent › Capabilities › Fleet tools (P1)

Shown in §0. Rows per family; a ✓/✗ for read and act; the "why not" column names the gate
(_grant_, _ladder_, _owner of <computer>_) and links to the place it is changed (Agent → Safety,
Agent → Connections, the computer's Settings tab). States: **loading** (skeleton rows); **empty**
(_"You have no computers yet"_ with Add computer); **no fleet** (block hidden when `FLEET_ENABLED`
is off); **error** (_"Could not read Nina's fleet permissions"_ with retry).

### 5.2 My Decisions — a held fleet action (P2)

```
┌ Nina wants to restart nginx on build-01 ──────────────────────────────────┐
│ Change a computer · Ask                                                   │
│ ⚠ This restarts the web server Ever Works connects through on build-01.   │
│ Requested 2 min ago from Run "Fix checkout 502s" · expires in 23 h 58 m   │
│                                     [ Refuse ]  [ Approve and restart ]   │
└───────────────────────────────────────────────────────────────────────────┘
```

The card body is the same confirmation text a human would see in the Fleet hub for that action
(FL-09's wording), prefixed with the Agent's name and category.

### 5.3 CLI output

Human output is a compact table per family (same column set as the web list); errors print
`✗ <code> — <hint>` on stderr. `--json` is the single machine contract. `fleet session attach`
takes over the terminal (raw mode) and shows a one-line status bar _"build-01 · Nina · watching ·
Ctrl-] to detach"_.

### 5.4 Keyboard and palette

Palette: _"Fleet tools for <Agent>"_ opens §5.1. No other keyboard surface; the CLI is the keyboard.

### 5.5 Copy that carries meaning

`Tools never carry a credential. {agent} acts through the platform; the platform asks the
computer.` · `'{category}' is Off for {agent} — raise it on {agent}'s Safety tab` · `{tool} is
denied by a tool grant at {scope} scope` · `ask the owner of {computer} to allow {audience}:
{family}` · `call again with confirm: true` · `type the exact name: {name}`.

---

## 6. Non-functional requirements

- **Performance:** the gate adds ≤ 25 ms p95 to a tool call (AW-24 FR-20 budget); `fleet_status`
  answers in ≤ 400 ms p95 for 50 computers.
- **Reliability:** every tool is idempotent on retry with the same confirmation summary; operations
  survive an API restart (FL-02).
- **Security & privacy:** tools never return a credential, a path outside allowed roots, or output
  that failed redaction; the MCP whitelist is the only exposure path; CLI tokens stay in the
  existing credential store.
- **Observability:** refusals by gate counted; Decisions created by tools counted; audit rows carry
  `requestedBy`.
- **Compatibility:** existing tool names unchanged; the descriptor annotation is optional.

---

## 7. Key entities & concepts

| Entity / concept         | New?                           | Description                                                                                         |
| ------------------------ | ------------------------------ | --------------------------------------------------------------------------------------------------- |
| **Fleet tool**           | Extended                       | An Agent/MCP tool over a fleet family with annotations (read-only or destructive, class, category). |
| **Gate**                 | **NEW** (a rule, not a record) | The ordered check grants × ladder × computer audience × consent, naming its refusal.                |
| **Confirmation summary** | **NEW** (transient)            | What a `confirm` call would do; echoed back and matched on the confirming call.                     |
| **Operation**            | FL-02                          | The handle for `wait: false`.                                                                       |
| **Decision**             | Existing                       | What an Ask/Draft rung produces for a fleet action.                                                 |
| **Fleet audit**          | Existing                       | `requestedBy: agent:<id>` on Agent-initiated rows.                                                  |

---

## 8. Out of scope

- A node-side MCP server or any tool that talks to a machine directly (README §3, D2).
- Renaming the eight existing MCP fleet tools (kept; see §8b).
- Credentials for CLIs on machines ("account switching" — refused, CAPABILITY-MAP G).
- Plugin-contributed tools.

## 8b. Open questions

- **Resolved** by CONTRACTS §11.3: the existing `list_fleet_nodes` tool and the eight existing MCP fleet entries stay exactly as they are beside the new `fleet_<family>_<verb>` names; `fleet_nodes_list` / `fleet_nodes_get` are the new names (the parity test allows exactly the eight legacy names).
- **Resolved** by CONTRACTS §11.3: plural families — `fleet_sessions_question` / `fleet_sessions_answer`.
- **Resolved** by CONTRACTS §2.1: the families now include `logs` and `ports`; log reads → `logs`, port list → `view`, port open / preview / tunnel → `ports`, wake, VM, cloud and Actions runner actions → `machines`, `git.setIdentity` → `commands`, `health.now` → `view` (plan §9.1 uses exactly this).
- **Resolved** by CONTRACTS R-32: an Agent may answer another session's **question** only when its owner enabled "may answer other sessions" on it (FL-05 FR-30); permission prompts are human-only (S6, FR-16).
- **Resolved** by CONTRACTS R-33: held Agent actions are `agent_action_proposals` rows (`actionType: 'fleet_machine_action'`, FL-09's value); no new table.
- `[NEEDS CLARIFICATION: How long may a held fleet action wait for approval? `agent_action_proposals`has only`pending · approved · rejected` and no expiry sweep exists. Default until answered: 24 h, checked at approval time the way merge approvals check staleness (`packages/agent/src/agent-approvals/merge-approval.service.ts:97,210-221`) — an older approval answers `confirmation_required` with a fresh summary and nothing runs (U12); no new status, no sweep.]`

---

## 9. Acceptance criteria

- [ ] **ACC-FL19-01** (FR-1, FR-2) Every fleet tool in the Agent catalogue matches `fleet_<family>_<verb>` and declares its annotation; a test fails on any tool missing one.
- [ ] **ACC-FL19-02** (FR-3) `list_fleet_nodes` and the seven other MCP fleet tools behave exactly as before.
- [ ] **ACC-FL19-03** (FR-4, S1) `fleet_status` returns computers, needs-a-look, kill switch and timestamp in one call.
- [ ] **ACC-FL19-04** (FR-5, U1–U6) Each §8 code is produced with a hint naming the fix, by a test per code.
- [ ] **ACC-FL19-05** (FR-6, S2) A read tool runs with default grants and `view` audience; no Decision, no audit row.
- [ ] **ACC-FL19-06** (FR-7, FR-8, S3, U4, U5) The gate truth table — grants × rung × audience × consent — produces exactly the specified outcome and names the first refusing gate.
- [ ] **ACC-FL19-07** (FR-9) An audience refusal creates no Decision; a ladder refusal creates a refusal record.
- [ ] **ACC-FL19-08** (FR-10) Every Agent-initiated audit row carries `requestedBy: agent:<id>`.
- [ ] **ACC-FL19-09** (FR-11–13, S4, U8, U9) The two-step confirm works for all three classes with the C §2.2 fields and no token; a call against a changed target answers that target's own error.
- [ ] **ACC-FL19-10** (FR-14, U7) `wait: false` returns an operation; `fleet_operations_get` reports every C §3.3 state including `cancelled` and `interrupted`.
- [ ] **ACC-FL19-11** (FR-15, FR-16, S6) Answering another session works only for a question, only with the grant and the "may answer other sessions" setting, is refused for every permission prompt, and is audited.
- [ ] **ACC-FL19-12** (FR-17, FR-18, S8) Every exposed fleet route is in the MCP whitelist with an annotation; enrolment, heartbeat, lease and credential routes are absent (asserted).
- [ ] **ACC-FL19-13** (FR-19–21, S7, U10) Each CLI verb exists, `--json` matches the web shape, exit codes are as specified, `--yes` / `--confirm-name` gate confirmations.
- [ ] **ACC-FL19-14** (FR-22) `fleet session attach` renders, is read-only by default, drives with `--drive`, detaches on `Ctrl-]`.
- [ ] **ACC-FL19-15** (FR-24) The Capabilities block shows per-family read/act and the refusing gate with a link.
- [ ] **ACC-FL19-16** (FR-25) Every tool description carries the no-credits sentence; `fleet_usage_get` exists.
- [ ] **ACC-FL19-17** All strings are i18n keys under `fleet.tools.*`.

---

## 10. Constitution gates

- [x] **I — Plugin-first.** No external integration. Not applicable.
- [x] **II — Capability-driven.** No provider named.
- [x] **III — Source-of-truth repos.** Nothing stored.
- [x] **IV — Job runtime.** Operations are FL-02's; no new long-running work in the API process.
- [x] **V — Forward-only migrations.** No schema change (no slot for FL-19).
- [x] **VI — Tests.** Gate truth table, per-code tests, CLI contract, Playwright for the block.
- [x] **VII — Secrets.** Tools never carry or return credentials; CLI keeps the existing store.
- [x] **VIII — Plugin counts.** Not applicable.
- [x] **IX — Behaviour-first.** No code here.
- [x] **X — Backwards compatibility.** Existing tool names kept; descriptor annotation optional.

---

## 11. References

- Program: [Fleet README](../README.md) D7, D15 · [CONTRACTS](../CONTRACTS.md) §2.1–2.3, §3.3, §7, §8, §11.2, §11.3, R-5, R-19, R-24, R-32, R-33 · [CAPABILITY-MAP](../CAPABILITY-MAP.md) G
- Plan: [`./plan.md`](./plan.md) · Tasks: [`./tasks.md`](./tasks.md)
- Related: [AW-15 Connections & scopes](../../agent-workspace/AW-15-connections-scopes/spec.md) §4.3, [AW-24 Safety rails](../../agent-workspace/AW-24-safety-rails/spec.md) §4.1–4.3, [FL-12](../FL-12-commands/spec.md), [FL-13](../FL-13-schedules-on-computers/spec.md), [FL-20](../FL-20-usage-and-cost/spec.md)
- Constitution: `.specify/memory/constitution.md`
