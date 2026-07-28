---
id: quality-gates
title: Quality Gates (acceptance checks)
sidebar_label: Quality Gates
---

# Quality Gates

A **quality gate** is the set of commands that decide whether an Agent's work on a [Task](../api/tasks.md) is actually done. Each command runs after the Agent finishes; exit code `0` is green, anything else is red. Red work goes back to the Agent instead of to you.

Without gates, "the Agent said it was finished" is the only signal you get. With them, "the build passes, the tests pass and the types check" is.

## Declaring checks

A check is a small object:

| Field            | Required | Notes                                                                           |
| ---------------- | -------- | ------------------------------------------------------------------------------- |
| `id`             | yes      | Slug (`^[a-z0-9][a-z0-9-_]{0,40}$`). Also the merge key against a Work default. |
| `name`           | yes      | Human label shown in run reports (≤ 120 chars).                                 |
| `kind`           | yes      | `build` · `test` · `lint` · `typecheck` · `custom` — display grouping only.     |
| `command`        | yes      | What to run (≤ 2000 chars). Exit `0` = green.                                   |
| `required`       | yes      | Required checks decide the gate. Non-required ones only report.                 |
| `cwd`            | no       | Working directory relative to the checkout root.                                |
| `timeoutSec`     | no       | 1–3600. Exceeding it reports `timeout`, which is distinct from `red`.           |
| `disabled`       | no       | On a Task entry, suppresses the same-id inherited Work default.                 |
| `envPassthrough` | no       | Environment variable **names** (never values) this check is allowed to see.     |

Checks run with a **scrubbed environment**. Listing a name in `envPassthrough` is a deliberate grant of that one value; platform-owned configuration (database, auth, job-runtime and plugin credentials) is never granted even if you list it.

## Work defaults and Task overrides

Set `checkDefaults` on the Work (**Work → Settings → Checks**) and every agent-executed Task under it inherits them. A Task's own `acceptanceChecks` are merged over the defaults **by `id`**:

- same `id` → the Task's entry replaces the Work default,
- same `id` with `disabled: true` → the Work default is suppressed for this Task,
- new `id` → added on top,
- `acceptanceChecks: null` → inherit the Work defaults untouched.

Both lists are capped at 20 entries.

## Enforcement policy

`checksPolicy` on the Work decides what a red gate means:

| Policy     | Behaviour                                                             |
| ---------- | --------------------------------------------------------------------- |
| `off`      | Checks never run.                                                     |
| `warn`     | Checks run and report; red does not block the Task.                   |
| `required` | Red blocks Task completion — the Agent iterates instead of finishing. |

## The red → iterate loop

When a required check is red, the run does not fail; the Agent is handed the failing check's name, exit code and log tail and asked to fix it. That repeats up to a **gate-attempt budget**:

- `maxGateAttempts` on the Work is the default (1–5),
- `maxGateAttempts` on a Task overrides it; `null` inherits.

When the budget is spent, the Task stops with the gate red and the failure recorded, rather than looping forever. The budget is also consulted against the Task's spend guardrails, so an expensive iterate loop stops when the budget does.

## Every pull request the platform opens, not just the Agent's

Agent Task runs are not the only place Ever Works opens a pull request. Item
submit / remove / update, the CSV/Excel bulk import, the data-repo generation
and source-sync flows, the markdown sync and the `openPullRequest` Agent tool
all propose changes the same way — and they consult the same gate before they
do.

The rules are the Work-level ones you already configured, with no Task in the
picture (so only `checkDefaults` apply):

| Policy     | What happens to a non-Task pull request                                                        |
| ---------- | ---------------------------------------------------------------------------------------------- |
| `off`      | Nothing runs. Identical to how these flows behaved before gates existed — this is the default. |
| `warn`     | Checks run against the checkout and report; the pull request opens either way.                 |
| `required` | The pull request opens only on a green gate.                                                   |

Under `required`, a refusal never destroys work: the change is still written,
committed and pushed on its branch — only the pull request is withheld, and the
failing check ids come back with the refusal. A Work that declares `required`
but configures **no** checks refuses too: a gate that cannot run must not pass
anything.

## Reading the result

The Task detail page's **Checks** section shows:

- one row per check, with its verdict (`Passed` / `Failed` / `Timeout` / `Error`) and exit code,
- an expandable **log tail** per row,
- a gate chip (`green` / `red` / …) and an "Attempt _n_ of _m_" counter once a run exists,
- an inline editor for the checks and the attempt budget.

Before a run exists, the section shows the Task's _declared_ checks. Once a run has happened it shows the **dispatch-frozen** set that actually ran — so editing a check later never rewrites the history of what was executed.

## Related

- [Task Isolation](./task-isolation.md) — the branch the checks run against.
- [Merge Policy](./merge-policy.md) — `requireGreenGate` makes a green gate a precondition for an agent merge.
- [Budgets & Usage](./budgets-and-usage.md) — the spend guardrails the iterate loop consults.
