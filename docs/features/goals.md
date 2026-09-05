---
id: goals
title: Goals
sidebar_label: Goals
---

# Goals

A **Goal** is something you want to be true, checked on a schedule. Where a [Mission](./missions.md)
keeps producing work on a topic, a Goal watches one finish line and tells you whether you are there.

Goals come in two **kinds**:

- A **metric Goal** — the original kind, and what every Goal created before kinds existed is — watches
  a single number and tells you whether it is heading the right way. It reads a metric from a provider
  plugin, records what it saw, and reports progress toward a target.
- A **delivery Goal** has no metric at all. "Ship feature X across three repos" is a delivery Goal: it
  completes when every approved item of its Definition of Done is done or waived. See
  [Delivery goals](#delivery-goals).

A Goal does not build anything by itself. Its execution loop (the orchestrator) hands iterations to
agents; the Goal is the finish line they work toward. **One iteration at a time**, unless you raise
[Concurrent iterations](#concurrent-iterations).

## When to use a Goal

| You want to…                                                    | Use a…              |
| --------------------------------------------------------------- | ------------------- |
| Keep producing new Works and Ideas on a theme                   | **Mission**         |
| Track "monthly revenue reaches $1,000" and know when it happens | **Goal** (metric)   |
| Track "support tickets stay below 20 a week"                    | **Goal** (metric)   |
| Drive "ship feature X across three repos" to done               | **Goal** (delivery) |
| Build one site from one prompt                                  | **Work**            |

Goals and Missions are independent — you can run either without the other.

## Creating a Goal

From `/goals`, choose **New Goal**. The form at `/goals/new` starts as a **metric** Goal; the
**Goal kind** selector in the first card switches it to a delivery Goal, which hides the metric source
and target fields and shows a Definition of Done instead (see [Delivery goals](#delivery-goals)). For a
metric Goal the form collects:

| Field                  | Required | Notes                                                                            |
| ---------------------- | -------- | -------------------------------------------------------------------------------- |
| **Title**              | yes      | Up to 200 characters. Shown on the catalog and the detail page.                  |
| **Description**        | no       | Free context for whoever reads the Goal later.                                   |
| **Goal kind**          | yes      | _Metric target_ (default) or _Delivery_. Fixed once the Goal exists.             |
| **Provider plugin ID** | yes      | The metrics plugin that supplies the number — see below.                         |
| **Metric ID**          | yes      | Which metric to read from that plugin.                                           |
| **Parameters (JSON)**  | no       | Passed to the provider, e.g. `{ "currency": "usd" }`. Must be a JSON **object**. |
| **Direction**          | yes      | _At least_ (grow to target) or _At most_ (stay under it).                        |
| **Target value**       | yes      | The number you are aiming at. See the note below.                                |
| **Unit**               | yes      | Free text — `usd`, `tickets`, `signups`.                                         |
| **Window**             | yes      | Daily, Weekly, Monthly, Total, or Point-in-time.                                 |
| **Deadline**           | no       | Optional date the Goal should be met by.                                         |
| **Check frequency**    | yes      | Minutes between evaluations. **Clamped server-side to a 15-minute minimum.**     |

:::caution Target value is required, including zero
Leave **Target value** blank and the form rejects it. This matters more than it looks: a blank field
used to be stored as a target of `0`, and combined with _At least_, that produced a Goal meaning
"reach at least 0" — satisfied by every possible value, so it reported success immediately and silently.

An **explicit** `0` is still perfectly valid. "Keep failures at most 0" is a real Goal.
:::

New Goals are created in **draft**. Nothing is evaluated until you activate them.

## Delivery goals

A **delivery Goal** is for outcomes that are not a number — "ship feature X across three repos",
"migrate the docs site", "close out the launch checklist". Choose **Delivery** under **Goal kind** on
`/goals/new`.

What changes compared with a metric Goal:

- **No provider, no metric, no target.** The Provider plugin ID, Metric ID, Direction, Target value,
  Unit and Window fields disappear, and the API refuses a delivery Goal that carries any of them. There
  is nothing to read on a schedule and no comparator to satisfy.
- **The Definition of Done is required.** The form takes one criterion per line and needs at least one.
  Every criterion you enter is already approved (a delivery Goal cannot be born with only proposed
  criteria), and the checklist can never be emptied later — a delivery Goal with no finish line would be
  unfinishable, not open-ended. Refine, add, waive and mark criteria done on the Goal page's
  **Definition of Done** tab as usual.
- **Completion is the approved checklist alone.** The Goal completes with outcome **achieved** the
  moment every _approved_ criterion is done or waived — whether the execution loop notices first or the
  scheduled check does. Criteria a planning run _proposed_ never count until you approve them, so an
  agent cannot finish a Goal by proposing that it is finished.
- **Deadline and cadence still apply.** Activating a delivery Goal schedules the same checks as a metric
  Goal; each check re-reads the Definition of Done and the deadline without calling any plugin, so a
  passed deadline still ends the Goal as **missed**. **Evaluate now** does the same on demand.
- **The execution loop, budgets and limits are unchanged.** Spend cap, wall-clock limit, stuck
  threshold, pinning and nudging work exactly as for a metric Goal; the routed agent's brief says
  explicitly that the checklist is the whole definition of done.

Metric Goals behave exactly as before. Existing Goals are metric Goals; the kind is shown as a badge on
the catalog card and the detail header.

### Who runs a brand-new Goal

The loop routes each iteration to the Goal's **pinned agent** if one is set, otherwise round-robin over
the agents that have already worked the Goal. A brand-new Goal has neither — so, when no agent is
pinned and none has worked it yet, the router falls back to the **eligible agents in the Goal's own
scope** (the same Organization / tenant ownership rule the rest of the platform applies) and
round-robins over them, oldest first. It never picks an agent outside the Goal's scope, and a scope
with no agent still leaves the loop **stuck** with `no-candidate-agent` until you create or assign one.

## Concurrent iterations

By default the loop runs **one iteration at a time**: while an iteration's run is queued or running,
the next tick waits. That is deliberate — two iterations of the same Goal working the same branch race
each other's workspace.

**Concurrent iterations** in _Adjust limits_ raises that ceiling (1–10, default 1). At a ceiling of _N_
a tick dispatches as many iterations as there are free slots — _N_ minus what is already in flight —
each as its own Task with its own agent run, and the orchestrator log records one routing line naming
all of them plus one dispatch line each.

:::caution Raise it only when iterations do not share a branch
Nothing here separates workspaces. A Goal whose iterations all edit the same repository on the same
branch will have them overwrite each other. Raise this for a Goal whose iterations are genuinely
independent — different repositories, different areas, research fan-out — and leave it at 1 otherwise.
:::

Every iteration still passes the same gates a single one does: the global stop flag, the concurrency
valves, the plan entitlement, the credits precheck and the agent's own budget. Raising the ceiling asks
for more parallelism; it does not grant more capacity. A Goal that never set it is unchanged, and every
Goal that existed before this shipped is left at 1.

## The metric source

A Goal reads its number from a **metrics provider plugin**, identified by the pair
(_Provider plugin ID_, _Metric ID_). The provider must be installed and enabled for your account
before the Goal can read anything.

:::warning The form's placeholder text is not a working example
The Provider plugin ID field shows `stripe` as its placeholder and Metric ID shows `income`. These are
illustrative, **not** real plugin identifiers. A Goal created by copying them will save and activate
without complaint, then fail on every evaluation.

Check which metrics providers are enabled for your account under **Plugins** before creating a Goal,
and use the plugin's own id.
:::

Activation deliberately does **not** verify that the named provider exists. That keeps you from being
blocked while a plugin is being set up — but it also means a typo surfaces only at the first
evaluation, not at creation.

## Lifecycle

A Goal moves through four states:

| Status        | Meaning                                           |
| ------------- | ------------------------------------------------- |
| **draft**     | created, never evaluated. No schedule is running. |
| **active**    | evaluated on the check frequency.                 |
| **paused**    | schedule stopped; history kept.                   |
| **completed** | finished, with an optional outcome recorded.      |

The action bar shows only the transitions that make sense for the current state — a draft Goal offers
**Activate** and **Delete**; an active one offers **Evaluate now** and **Pause**.

### Evaluate now

Runs a check immediately rather than waiting for the next scheduled one. Each evaluation records a
sample, so the progress sparkline fills in over time. If no metrics provider is enabled, this is where
you will see the failure.

## What a Goal does not do

- It does **not** create Works or Ideas. That is a [Mission](./missions.md).
- It does **not** change anything in your account when a target is hit or a checklist is completed — it
  records the outcome.
- Its **kind** cannot change after creation, and a metric Goal's metric source, target, unit and window
  cannot be given to a delivery Goal (the API refuses them). To change the kind, create a new Goal.
- A delivery Goal cannot lose its Definition of Done: the checklist can be edited but never emptied.

## Related

- [Missions](./missions.md) — long-running goals that produce Ideas and Works
- [Ideas](./ideas.md) — proposals a Mission generates
- [Budgets and usage](./budgets-and-usage.md) — spend limits, which are enforced rather than observed
