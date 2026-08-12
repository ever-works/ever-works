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
| **Work Agent**      | The agent that turns a high-level build request into an approval-ready plan, and the guardrails it must stay inside. See [Agents](./agents.md).                                                                                                        |
| **Fleet**           | Machines that are yours — enroll a node, watch it heartbeat, drain it. See [Fleet](./fleet.md).                                                                                                                                                        |
| **Job Runtime**     | Whether background jobs use the platform-default runtime, your own credentials, or a provider you pick. See [Workers](./workers.md).                                                                                                                   |
| **Digest**          | Scheduled activity briefings and their cadence. The personal digest and the organization digest are separate settings — turning one on never changes the other.                                                                                        |
| **Billing**         | Your plan, balance, invoices and the credits ledger. See [Credits & Billing](./credits-and-billing.md).                                                                                                                                                |
| **Usage & Credits** | Where the credits went — per day, model, agent and Work. See [below](#usage--credits).                                                                                                                                                                 |
| **Danger Zone**     | Exporting your account data and deleting your account, behind a typed-email confirmation. Always last in the sidebar.                                                                                                                                  |

**Fleet** sits directly above **Job Runtime** on purpose: Fleet is _where_ work can run, Job Runtime
is _how_ it gets dispatched.

## The PLUGINS section

Below the fixed entries, the sidebar lists your plugins grouped by category. Each entry opens the
plugins of that category so you can enable and configure them; a small dot marks a category
containing a plugin whose required settings are not filled in yet.

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

## Related pages

- [Onboarding & Setup Wizard](./onboarding.md) — where most of these settings are first chosen.
- [Credits & Billing](./credits-and-billing.md) — the ledger, plans and the Billing page.
- [Budgets & Usage](./budgets-and-usage.md) — caps that gate spend before a call runs.
- [Plugin System](../plugin-system/index.md) — what the PLUGINS section is listing.
