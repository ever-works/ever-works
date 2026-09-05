---
id: settings-map
title: The Settings Map
sidebar_label: Settings Map
---

# The Settings Map

Everything you chose in the [setup wizard](./onboarding.md) — and a good deal you did not — lives
under **Settings**. This page is an orientation: what each entry in the settings navigation is for,
and which feature page covers it in depth.

Settings is laid out as a sidebar next to the page content. The sidebar has three parts, in this
order: a fixed list of account and platform pages, a **PLUGINS** section, and **Danger Zone**
pinned at the bottom.

## Account and platform

| Entry               | What lives there                                                                                                                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Profile**         | Your name, username and avatar, the budget-alert email toggle, and the banner that resends the verification email while your address is unconfirmed. Your email address is shown but cannot be changed here. This is the landing page for `/settings`. |
| **Organization**    | The organizations you belong to, and the Vision you set on one. See [Teams & Organizations](../advanced/teams-and-organizations.md).                                                                                                                   |
| **Security**        | Changing your password.                                                                                                                                                                                                                                |
| **API Keys**        | Programmatic keys for the REST API and the CLI. See [API Keys](./api-keys.md).                                                                                                                                                                         |
| **Data**            | Export your account data as JSON, import it back, and sync your configuration to a private GitHub repository. See [Data Management](./data-management.md).                                                                                             |
| **GitHub App**      | The Ever Works GitHub App installations linked to this workspace — inspect them, re-sync the repository snapshot, and onboard a repository.                                                                                                            |
| **Repositories**    | The account-level registry of repositories an Agent can be granted — manual entries, one-click GitHub App imports, and read-only rows derived from your Works. See [Repositories Registry](./repositories.md).                                         |
| **Work Agent**      | The agent that turns a high-level build request into an approval-ready plan, and the guardrails it must stay inside. See [Agents](./agents.md).                                                                                                        |
| **Fleet**           | Machines that are yours — enroll a node, watch it heartbeat, drain it. See [Fleet](./fleet.md).                                                                                                                                                        |
| **Job Runtime**     | Whether background jobs use the platform-default runtime, your own credentials, or a provider you pick. See [Workers](./workers.md).                                                                                                                   |
| **Environments**    | Named, publishable runtime recipes — pip and npm packages plus a networking posture — that you assign to an Agent. See [Environments](./environments.md).                                                                                              |
| **Connections**     | External MCP servers your Agents may call as tools. Auth header values are stored encrypted and never shown again. See [MCP Connections](./mcp-connections.md).                                                                                        |
| **Digest**          | Scheduled activity briefings and their cadence. The personal digest and the organization digest are separate settings — turning one on never changes the other.                                                                                        |
| **Notifications**   | The event × channel preference grid, plus the optional Novu inbox embed. The grid renders read-only in this version — the write path is the REST API. See [Notifications](./notifications.md).                                                         |
| **Channels**        | Where a notification goes once it leaves the bell — Discord, Slack, Telegram, WhatsApp and Novu — with **Test** and **Remove** on every row. Lives at `/settings/integrations/channels`.                                                               |
| **Email Addresses** | Tenant-managed inbound and outbound addresses for Agents, at `/settings/integrations/emails`. A v0 shell in this version — see [below](#email-addresses-is-a-v0-shell). The feature itself: [Agent Email & Inboxes](./agent-email.md).                 |
| **Billing**         | Your plan, balance, invoices and the credits ledger. See [Credits & Billing](./credits-and-billing.md).                                                                                                                                                |
| **Usage & Credits** | Where the credits went — per day, model, agent and Work. See [below](#usage--credits).                                                                                                                                                                 |
| **Danger Zone**     | Exporting your account data and deleting your account, behind a typed-email confirmation. Always last in the sidebar.                                                                                                                                  |

**Fleet** sits directly above **Job Runtime** on purpose: Fleet is _where_ work can run, Job Runtime
is _how_ it gets dispatched.

**Environments** sits directly below it for the same reason: Job Runtime decides _how_ a run is
dispatched, an Environment decides _what is installed_ inside it and _which hosts it may reach_.

**Channels** and **Email Addresses** point at `/settings/integrations/...` rather than a top-level
path, and there is deliberately **no Integrations entry** between them: `/settings/integrations` has
no index page and soft-404s, so always link the two children directly. Those two entries, together
with **Notifications**, are also the only in-product entry points to those pages — before they were
added the pages existed but could be reached only by typing the URL.

### Email Addresses is a v0 shell

**Settings → Email Addresses** (`/settings/integrations/emails`) renders the list of registered tenant
addresses — **Address**, **Direction**, **Provider**, **Verified**, and a per-row **Edit** — and an
empty registry says so. The header's **Add address** button is not wired up yet: it opens a
placeholder telling you the add wizard lands in a follow-up. Until it does, register addresses over
the API instead of through this screen:

1. `POST /api/email/addresses` with the `address`, a `direction` (`outbound`, `inbound` or `both`)
   and the `pluginId` plus `providerSettings` of the email provider plugin that carries it.
2. `POST /api/email/addresses/:id/verify` to send the verification mail that flips the row's
   **Verified** column.
3. `GET /api/email/addresses` (optionally `?direction=`) to confirm the registry now matches what the
   settings table shows.

Everything the finished screen will manage — outbound and inbound addresses, provider plugins,
routing rules, per-Agent assignment — is described in
[Agent Email & Inboxes](./agent-email.md).

## The PLUGINS section

Below the fixed entries, the sidebar lists your plugins grouped by category. Each entry opens the
plugins of that category so you can enable and configure them; a small dot marks a category
containing a plugin whose required settings are not filled in yet.

Every category entry is one route, `/settings/plugins/<category>` — `/settings/plugins/ai-provider`,
`/settings/plugins/vector-store`, `/settings/plugins/connector`, and so on. Bare `/settings/plugins`
has no content of its own and **redirects to `/settings/plugins/ai-provider`**, so name the category
explicitly whenever you link or bookmark one.

Categories are listed alphabetically. On the hosted platform they are:

| Category          | What it configures                                                               |
| ----------------- | -------------------------------------------------------------------------------- |
| **AI Providers**  | The provider that powers generation — the [wizard's](./onboarding.md) AI choice. |
| **Database**      | Where your Works store their data — the wizard's DB Storage choice.              |
| **Deployment**    | Where Works get deployed — the wizard's deployment choice.                       |
| **Git Providers** | Where Work repositories live — the wizard's Git Storage choice.                  |
| **Pipeline**      | The generation pipeline a Work runs.                                             |
| **Search**        | Search backends used during research.                                            |
| **Utility**       | Assorted helper plugins.                                                         |
| **Vector Store**  | Embedding backends behind the [Knowledge Base](./knowledge-base.md).             |

This section is **built from what your installation actually has**: only categories containing at
least one enabled plugin with user-configurable settings appear, so the list is shorter or longer
depending on the install. **Pipeline** is the exception — it stays listed even with no pipeline
plugin enabled, because the page also carries a global default selector. If your installation ships
no configurable plugins at all, the section is absent entirely.

For what plugins are and how they fit together, see the
[Plugin System](../plugin-system/index.md).

## Usage & Credits

**Settings → Usage & Credits** (`/settings/usage`) answers "where did my credits go?". One reporting
period drives the whole page — the summary tiles and all four charts.

**Choosing the period.** The controls at the top offer:

- **7d** and **30d** — rolling windows.
- A **calendar month** picker, offering the last twelve months, newest first. The page defaults to
  the current month.

**What the page shows.** A row of summary tiles for the period (credits balance, credits used,
credits added, spend, tasks completed, Works active, agent runs), followed by four breakdowns:

| Chart              | What it breaks down                                  |
| ------------------ | ---------------------------------------------------- |
| **Usage per day**  | Spend for each day in the period.                    |
| **Usage by model** | Which AI models the spend went to.                   |
| **Usage by agent** | Which [Agents](./agents.md) spent it.                |
| **Usage by Work**  | Which [Works](./creating-a-work.md) it was spent on. |

Rows that cannot be attributed to a model, agent or Work are grouped as **Unattributed** rather than
dropped. A period with no activity says so instead of drawing an empty chart.

**Export CSV** downloads every usage event in the selected period as a CSV file, so you can do your
own analysis or reconcile against an invoice.

The full ledger behind these numbers — what counts as a credit movement, and what the tiles are
summing — is documented in [Credits & Billing](./credits-and-billing.md). For capping spend _before_
it happens rather than reviewing it afterwards, see [Budgets & Usage](./budgets-and-usage.md).

### The Costs tab

The page has two tabs — **Overview** (everything above) and **Costs**. Costs is a separate deep link,
`/settings/usage?tab=costs`, and it answers a different question: not "where did my credits go?" but
"what did the AI actually cost, and which Agent spent it?".

The two tabs fetch disjoint sets of endpoints and only the active one loads, so opening Costs costs
the Overview nothing — and vice versa. An unrecognised `?tab=` value falls back to Overview rather
than 404ing.

**Choosing the window.** Costs uses rolling day windows only — **7d**, **30d** or **90d**, defaulting
to 30. `?windowDays=` is honoured server-side, so `/settings/usage?tab=costs&windowDays=90` renders
the 90-day view directly. It does not accept the calendar-month periods the Overview tab offers.

**What the tab shows.** Three tiles — **Total spend**, **Agent runs**, **Average per run** — then four
panels:

| Panel                       | What it breaks down                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Spend per day, by agent** | Daily spend stacked by [Agent](./agents.md), with the biggest spenders named and the rest as **Other agents**. |
| **By agent**                | Cost, runs and average per run for each Agent.                                                                 |
| **By model**                | Cost and share of the window per model, with the units behind each number.                                     |
| **Most expensive runs**     | The costliest runs — cost, agent, task, model, start time and status.                                          |

Spend that cannot be attributed to an Agent is shown as **Unattributed**, and an Agent you have since
deleted appears as **Deleted agent**, so the panels always add back up to the tile.

**One number is deliberately missing.** There is no cache-hit rate, and the page says so inline: the
metering path does not record cached-read tokens yet, so the figure cannot be computed honestly
rather than guessed.

## Pages the sidebar does not list

Two settings surfaces have no sidebar entry of their own — each hangs off an entry that does. Both are
ordinary, linkable URLs.

| Page                         | Route                              | Reached from                                                                   |
| ---------------------------- | ---------------------------------- | ------------------------------------------------------------------------------ |
| **Billing → Payment method** | `/settings/billing/payment-method` | The **Manage payment methods** link on the Billing page's payment card.        |
| **Usage & Credits → Costs**  | `/settings/usage?tab=costs`        | The **Costs** tab at the top of Usage & Credits — see [above](#the-costs-tab). |

### Billing → Payment method

`/settings/billing/payment-method` is where cards are added, replaced and removed. Before it existed a
card could only be stored as a side effect of buying credits; `/settings/billing` keeps its read-only
summary card and simply links here.

1. Go to **Settings → Billing** (`/settings/billing`) and, on the payment-method card, click **Manage
   payment methods**.
2. Under **Stored cards**, review what is on file — brand, last four digits and expiry, with the active
   card badged **Default**.
3. Click **Add card**. You are redirected to the payment provider's own hosted page: no card field is
   ever rendered by Ever Works and no card number is posted to any of our routes. What comes back is
   the brand, last four and expiry plus an opaque handle.
4. Use **Make default** on another row to switch which card is charged, and **Remove** to delete one.
5. **Back to billing** returns you to `/settings/billing`.

Two rules the page enforces for you:

- **You cannot remove your last card while a paid plan is active.** The screen explains it, and the
  API refuses it regardless of what any client offers.
- **The whole surface is gated.** Payments sit behind a server-side switch that is off by default and
  additionally require a configured billing provider; with either missing you get a "coming soon"
  card instead of buttons that would error. See [Credits & Billing](./credits-and-billing.md).

## Related pages

- [Onboarding & Setup Wizard](./onboarding.md) — where most of these settings are first chosen.
- [Credits & Billing](./credits-and-billing.md) — the ledger, plans and the Billing page.
- [Budgets & Usage](./budgets-and-usage.md) — caps that gate spend before a call runs.
- [Plugin System](../plugin-system/index.md) — what the PLUGINS section is listing.
- [Repositories Registry](./repositories.md) — the registry behind the Repositories entry.
- [Environments](./environments.md) and [MCP Connections](./mcp-connections.md) — what an Agent's run
  has installed, and what it may call.
- [Notifications](./notifications.md) — the Notifications and Channels entries in depth.
- [Agent Email & Inboxes](./agent-email.md) — the feature behind the Email Addresses shell.
