---
id: goals
title: Goals & Metrics
sidebar_label: Goals
---

# Goals & Metrics

A **Goal** is a number you are trying to move, plus the metric that proves whether you moved it.
Where a [Mission](./missions.md) says _what the platform should keep working on_, a Goal says _what
success is worth measuring_ — "monthly Stripe income of $1,000", "5,000 sessions a week".

Goals are authored on their own, on `/goals`. They are then **attached** to the Missions they belong
to, so a Mission's detail page can show what it is being judged on. One Goal can be attached to more
than one Mission.

## Creating a Goal

Go to **`/goals/new`** (Sidebar → **Goals** → new Goal). The form is four blocks: **Basics**,
**Metric source**, **Target**, and **Evaluation cadence**.

### Basics

| Field           | Required | Notes                                                          |
| --------------- | -------- | -------------------------------------------------------------- |
| **Title**       | Yes      | Up to 200 characters — e.g. _Monthly Stripe income of $1,000_. |
| **Description** | No       | Optional context for whoever reads the Goal later.             |

### Metric source

This is where the number comes from. It is a **provider plugin** plus a **metric** that plugin
publishes.

| Field                  | Required | Notes                                                                         |
| ---------------------- | -------- | ----------------------------------------------------------------------------- |
| **Provider plugin ID** | Yes      | The plugin that supplies the metric — the field's own example is `stripe`.    |
| **Metric ID**          | Yes      | The metric within that plugin — the field's own example is `income`.          |
| **Parameters (JSON)**  | No       | Provider-specific options as a **JSON object**, e.g. `{ "currency": "usd" }`. |

Which plugin IDs and metric IDs are available depends on your installation — see the
[Plugin System](../plugin-system/index.md) for what is installed and enabled on yours.

The parameters box is validated as you leave the field. It must parse as JSON **and** be an object —
a JSON array or a bare string is rejected with _Parameters must be a JSON object._ Leave it empty if
the metric needs no options.

### Target

| Field            | Required | Notes                                                                                      |
| ---------------- | -------- | ------------------------------------------------------------------------------------------ |
| **Direction**    | Yes      | **At least (grow to target)** or **At most (shrink to target)**. Defaults to _At least_.   |
| **Target value** | Yes      | A number. Non-numeric input is refused.                                                    |
| **Unit**         | Yes      | Free text up to 32 characters — e.g. `usd`, `sessions`, `%`.                               |
| **Window**       | Yes      | **Daily**, **Weekly**, **Monthly**, **Total** or **Point-in-time**. Defaults to _Monthly_. |
| **Deadline**     | No       | A date and time. Leave empty for an open-ended Goal.                                       |

**Direction** is what makes a Goal readable without further explanation: _At least_ is for numbers
you want to grow to the target, _At most_ for numbers you want to shrink to it.

### Evaluation cadence

**Check frequency (minutes)** is how often the Goal is evaluated. **The minimum is 15 minutes, and
lower values are clamped** — entering `1` does not give you a one-minute cadence, it gives you the
minimum. The field's own hint says so.

:::caution Required fields report themselves in a toast
**Title**, **Provider plugin ID**, **Metric ID**, **Target value** and **Unit** are all required. If
one is missing the form does not highlight the field — it raises a brief toast (_"Provider plugin ID
and metric ID are required."_, _"Unit is required."_, and so on) and stays put. The toast is easy to
miss, so if **Create Goal** appears to do nothing, check those five fields first.
:::

## After you create one

A new Goal lands as a **draft**. It is not evaluated on the cadence you just set until you activate
it — you do that from the Goal's own detail page, once you are satisfied the metric source resolves.
Creating a Goal takes you straight there.

## Attaching a Goal to a Mission

Open a [Mission](./missions.md), and on the **Overview** tab use the **Goals** panel:

1. Under **Attach a Goal**, pick one of your Goals from the select.
2. Optionally tick **Set as primary**. Only one Goal can be primary on a Mission at a time.
3. Choose **Attach**.

**Detach** removes the link. The Goal itself is not deleted — it stays on the Goals page and on any
other Mission it is attached to.

:::note Attaching a Goal never changes the Mission's status
This is deliberate, and the panel says so in place. A Mission does not become complete because a
Goal attached to it was met — **completing a Mission stays an explicit action** you take with the
**Complete** button. Goals measure; they do not drive the Mission state machine.
:::

If you have more than 100 Goals the picker shows your 100 most recent and says so; open the Goals
page for the full list.

## Related pages

- [Missions](./missions.md) — the long-running goal a Goal is attached to.
- [Tasks](./tasks.md) — the unit of work Agents actually execute.
- [Budgets & Usage](./budgets-and-usage.md) — caps on spend, which are enforced rather than measured.
- [Plugin System](../plugin-system/index.md) — where metric sources come from.
