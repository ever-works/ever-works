---
id: goals
title: Goals
sidebar_label: Goals
---

# Goals

A **Goal** is a number you want to move, checked on a schedule. Where a [Mission](./missions.md) keeps
producing work on a topic, a Goal watches a single metric and tells you whether it is heading the right
way.

A Goal does not build anything by itself. It reads a metric from a provider plugin, records what it
saw, and reports progress toward a target.

## When to use a Goal

| You want to…                                                    | Use a…      |
| --------------------------------------------------------------- | ----------- |
| Keep producing new Works and Ideas on a theme                   | **Mission** |
| Track "monthly revenue reaches $1,000" and know when it happens | **Goal**    |
| Track "support tickets stay below 20 a week"                    | **Goal**    |
| Build one site from one prompt                                  | **Work**    |

Goals and Missions are independent — you can run either without the other.

## Creating a Goal

From `/goals`, choose **New Goal**. The form at `/goals/new` collects:

| Field                  | Required | Notes                                                                            |
| ---------------------- | -------- | -------------------------------------------------------------------------------- |
| **Title**              | yes      | Up to 200 characters. Shown on the catalog and the detail page.                  |
| **Description**        | no       | Free context for whoever reads the Goal later.                                   |
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
- It does **not** change anything in your account when a target is hit — it records the outcome.
- It cannot be edited after creation. Title, metric source, target, unit, window and cadence are fixed
  once the Goal exists; to change any of them, create a new Goal.

## Related

- [Missions](./missions.md) — long-running goals that produce Ideas and Works
- [Ideas](./ideas.md) — proposals a Mission generates
- [Budgets and usage](./budgets-and-usage.md) — spend limits, which are enforced rather than observed
