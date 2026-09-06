---
id: analytics
title: Analytics & Metrics Providers
sidebar_label: Analytics & Metrics
description: How Ever Works reads real numbers out of Stripe, PostHog, Google Analytics or your own HTTP endpoints — the metrics-provider plugins, the windows they support, and how a Goal checks one against a target.
---

# Analytics & Metrics Providers

Ever Works does not run its own analytics warehouse, and it does not ask you to move your numbers into one. It reads them, read-only, out of the tools you already use — through a plugin socket called **`metrics-provider`** — so an autonomous [Goal](/features/goals) can check "am I at $1,000 a month yet?" against the real figure instead of a guess.

Four first-party providers ship today, and you can point the platform at any JSON endpoint of your own.

:::note Where these numbers surface
There is no standalone Analytics screen in the dashboard. A metrics provider is consumed by **Goals** — each evaluation records a sample, the samples draw the Goal's progress line, and every provider call is metered in the plugin usage ledger. This page describes the source; [Goals](/features/goals) describes the thing that reads it.
:::

:::info Not the same as the analytics on your generated site
Your generated website ships with its own visitor analytics — Plausible, Umami, Fathom, GA4 or a custom endpoint, plus PostHog events and Sentry error tracking. That is front-end telemetry about your site's visitors, and it lives in [Generated Site](/features/generated-site). This page is about the platform reading a **number** back so an agent can act on it.
:::

## The providers that ship

A metric is named by a pair — the **provider plugin id** and the **metric id**. These are the real ids:

| Provider plugin ID         | Metric ID           | Unit            | Windows                  | What it reads                                                                              |
| -------------------------- | ------------------- | --------------- | ------------------------ | ------------------------------------------------------------------------------------------ |
| `stripe-metrics`           | `balance_available` | your currency   | Point-in-time            | Available Stripe balance.                                                                  |
| `stripe-metrics`           | `gross_volume`      | your currency   | Daily / Weekly / Monthly | Sum of successful charges **in the configured currency only**.                             |
| `posthog-metrics`          | `event_count`       | `count`         | Daily / Weekly / Monthly | Occurrences of one event. Requires a parameter naming the event.                           |
| `posthog-metrics`          | `active_users`      | `count`         | Daily / Weekly / Monthly | Unique persons in the window.                                                              |
| `google-analytics-metrics` | `active_users`      | `count`         | Daily / Weekly / Monthly | GA4 `activeUsers`.                                                                         |
| `google-analytics-metrics` | `sessions`          | `count`         | Daily / Weekly / Monthly | GA4 `sessions`.                                                                            |
| `google-analytics-metrics` | `conversions`       | `count`         | Daily / Weekly / Monthly | GA4 **key events** — the 2024 rename of "conversions", which is what is queried upstream.  |
| `custom-http-metrics`      | _you choose the id_ | _you choose it_ | Point-in-time            | One JSON endpoint of yours per metric: every endpoint you configure becomes one metric id. |

### What each one needs

| Provider                   | Credentials                                                                                                      | Notes                                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `stripe-metrics`           | `STRIPE_SECRET_KEY` — a restricted read-only `rk_…` key is strongly recommended                                  | Read-only by contract. There is no net-income metric; `gross_volume` is the well-defined approximation        |
| `posthog-metrics`          | `POSTHOG_PERSONAL_API_KEY` (scope it to _Query: Read_) and `POSTHOG_PROJECT_ID`                                  | `event_count` needs the event name in the Goal's **Parameters (JSON)** field, e.g. `{ "event": "$pageview" }` |
| `google-analytics-metrics` | `GOOGLE_ANALYTICS_PROPERTY_ID` and `GOOGLE_ANALYTICS_SERVICE_ACCOUNT_JSON` for a service account with **Viewer** | The GA4 Data API is reporting-only, so it cannot mutate anything                                              |
| `custom-http-metrics`      | Whatever your own endpoint needs, as per-endpoint request headers                                                | GET-only, JSON-only, through the SSRF guard, redirects refused, capped at 1 MB and 15 seconds                 |

Credentials for all four can be set as environment variables **or** through admin or user plugin settings — see [Plugins](/features/plugins).

## Read-only by contract

The `metrics-provider` socket has exactly two methods, and both are declared side-effect free: one enumerates the metrics a provider can serve, the other reads a single value. There is no write path. A provider that could charge a card or edit a GA property would not fit the interface.

Each read returns a sample — the numeric `value`, its `unit`, and the ISO-8601 timestamp it was observed at.

## Windows

| Window                   | Meaning                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| `day` / `week` / `month` | Aggregate over that calendar window, anchored to now unless the query names an anchor        |
| `total`                  | Everything, unbounded                                                                        |
| `point`                  | A point-in-time reading, where aggregation does not apply (a Stripe balance, your own gauge) |

A metric declares which windows it supports, and a query naming an unsupported one is refused rather than silently reinterpreted — `custom-http-metrics`, for instance, serves `point` only, because window semantics beyond a single reading are your endpoint's business.

## More than one provider at once

Unlike the sockets where the platform needs a single winner, **several metrics providers can be enabled simultaneously** — one Goal reading Stripe revenue while another reads a PostHog signup count is the normal case. That is why a Goal names its provider explicitly by id.

When no id is given, the usual resolution chain applies: an explicit override, then the Work's active provider, then a provider that declares itself the default for the capability, then the first enabled one.

## How to wire a metric up

1. **Enable the provider.** Open **Plugins** (`/plugins`), find the provider — Stripe Metrics, PostHog Metrics, Google Analytics Metrics or Custom HTTP Metrics — and enable it. Enabling at account level does not cascade into your Works, so also enable it on the Work if a Work-scoped Goal will read it.
2. **Give it credentials.** Use **Settings** on the plugin's card, or set the environment variables from the table above on a self-hosted instance.
3. **Create the Goal** with the exact `(provider plugin id, metric id)` pair from the table, plus a comparator, a target and a window. See [Goals](/features/goals).
4. **Add parameters where the metric needs them** — `posthog-metrics`/`event_count` will not evaluate without `{ "event": "…" }` in **Parameters (JSON)**.
5. **Activate the Goal, then force one check** rather than waiting for the cadence:

    ```bash
    curl -X POST http://localhost:3100/api/me/goals/<goal-id>/evaluate-now \
      -H "Authorization: Bearer <jwt-token>"
    ```

6. **Read the samples back** to confirm real numbers are landing:

    ```bash
    curl http://localhost:3100/api/me/goals/<goal-id>/samples \
      -H "Authorization: Bearer <jwt-token>"
    ```

:::warning A wrong provider id fails at evaluation, not at creation
Activating a Goal deliberately does **not** verify that the named provider exists — that keeps you from being blocked while a plugin is still being set up. The cost is that a typo in the provider or metric id surfaces only on the first evaluation. `evaluate-now` is how you find out immediately.
:::

## Your own numbers with `custom-http-metrics`

Each entry you configure becomes one metric id. An entry declares:

| Field       | Meaning                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------ |
| `id`        | The metric id a Goal will name. Required                                                               |
| `label`     | Display label. Required                                                                                |
| `url`       | The endpoint to read. Required                                                                         |
| `valuePath` | Dot/bracket path to the numeric value inside the JSON response, e.g. `data.metrics[0].value`. Required |
| `unit`      | What the number is measured in                                                                         |
| `headers`   | Request headers, for your own auth                                                                     |

Requests are GET-only and expect JSON. They run through the SSRF guard, refuse redirects, and are capped at 1 MB and 15 seconds — so an endpoint that hangs or streams cannot stall an evaluation.

## What each read costs

Metric reads are metered like any other plugin call. `getMetricValue` is budget-guarded **before** the provider is invoked, under the `metrics` capability, and every call records a usage event; discovery calls record units with no cost. Providers that declare per-call pricing have that cost attributed; the rest contribute units only. See [Budgets & Usage](/features/budgets-and-usage).

## Related

- [Goals](/features/goals) — the thing that reads a metric on a schedule and checks it against a target
- [Plugins](/features/plugins) — enabling a provider, giving it credentials, and scoping it to a Work
- [Budgets & Usage](/features/budgets-and-usage) — where the cost and the units of each read are accounted
- [Generated Site](/features/generated-site) — the visitor-analytics stack your published site ships with
- [Agent Scorecards](/features/agent-scorecards) — the per-Agent equivalent: targets an AI worker is measured against
- [Missions](/features/missions) — the long-running goal a metric usually sits under
- [Plugin Categories](/plugin-system/plugin-categories) — where `metrics-provider` sits among the platform's sockets
