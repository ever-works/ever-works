---
id: skills-catalog
title: 'Skills Catalog'
sidebar_label: 'Skills Catalog'
---

# Skills Catalog

A **Skill** is a reusable, versioned block of Markdown-with-frontmatter
instructions that an Agent pulls in when it's relevant — the same
`SKILL.md` shape used by the open **agentskills** standard. Ever Works
ships Skills as a plugin capability (`skills-provider`) and sources a
curated public catalog from the [`ever-works/skills`](https://github.com/ever-works/skills)
GitHub repo.

This page covers the catalog **format**, the first-party provider
**plugin**, the sixteen built-in **go-to-market Skills**, and how Skills
**attach to Agents**. For the REST endpoints (catalog reads, per-user
installs), see the [Skills API](/api/skills).

:::note Where to find it
Skills have no sidebar entry of their own — nobody browses Skills without an
Agent in mind — so the catalog renders as the **Skills** block at the bottom
of **Sidebar → Teams → Agents tab** (anchor `/agents#skills`). Its tabs
(**Installed / Available / Custom**), search, **Browse templates** and **New
skill** are unchanged. The old `/skills` link still works: it redirects to
that block and carries your filters across. Skill detail pages
(`/skills/:id`), `/skills/new` and `/skills/templates` are unchanged, as is
the per-Agent **Skills** tab on an Agent's detail page.
:::

**Key sources:**

- `packages/plugins/everworks-skills/src/everworks-skills.plugin.ts` — the provider plugin
- `packages/plugins/everworks-skills/package.json` — plugin manifest (`autoEnable`, capability)
- [`ever-works/skills`](https://github.com/ever-works/skills) — the public catalog repo (`manifest.json` + `skills/<slug>/SKILL.md`)
- `ever-works/agents` → `schema/skills.schema.json` — the `skills.yml` attach schema
- `packages/contracts/src/skills/gtm-skills.ts` — the sixteen first-party go-to-market Skills
- `packages/plugins/everworks-skills/src/gtm-catalog.ts` — how those definitions become catalog entries

## The `SKILL.md` format

Each Skill is a folder in the catalog repo containing a `SKILL.md` file:
YAML frontmatter followed by the instruction body. The frontmatter
follows the agentskills standard — `name` and `description` are the
required keys, and additional keys are preserved as-is. A real example
from the catalog (`skills/check-pr/SKILL.md`):

```markdown
---
name: check-pr
description: >
    Check a GitHub, GitLab, or Perforce PR/MR/CL for review comments,
    failing checks, and PR-body gaps. Use when asked to inspect, fix, or
    prepare a change for submission.
license: MIT
compatibility: Requires git and gh, glab, or p4 installed and authenticated.
metadata:
    author: greptileai
    version: '1.3'
allowed-tools: Bash(gh:*) Bash(glab:*) Bash(git:*) Bash(p4:*)
---

# Check PR

Analyze a pull request … then help address any issues found.
```

The provider parses this with `gray-matter`, guaranteeing `name` and
`description` (falling back to the manifest row or slug) while preserving
any extra frontmatter keys (`allowed-tools`, `metadata`, etc.).

## The public `ever-works/skills` catalog

The catalog repo has a top-level `manifest.json` that indexes each Skill.
Every row carries a `slug`, a `skillPath` pointing at its `SKILL.md`,
plus curated `name`/`summary`/`tags`/`version` and — importantly —
**`license` and `sourceUrl` attribution** for Skills adapted from
upstream sources.

At the time of writing the catalog ships **10 Skills**, each with its
license and source attributed:

| Skill              | License    |
| ------------------ | ---------- |
| `skill-creator`    | Apache-2.0 |
| `mcp-builder`      | Apache-2.0 |
| `webapp-testing`   | Apache-2.0 |
| `frontend-design`  | Apache-2.0 |
| `brand-guidelines` | Apache-2.0 |
| `internal-comms`   | Apache-2.0 |
| `claude-api`       | Apache-2.0 |
| `check-pr`         | MIT        |
| `pr-report`        | MIT        |
| `doc-maintenance`  | MIT        |

## The `everworks-skills` provider plugin

`@ever-works/everworks-skills-plugin` is the first-party
`skills-provider` plugin. Its behavior (verified in
`everworks-skills.plugin.ts`):

- **Catalog source.** It fetches `manifest.json` from the configured repo
  and branch over a plain HTTPS GET (the repo is public — no auth), then
  fetches each row's `SKILL.md`, parses the frontmatter, and caches the
  union in memory with a configurable TTL (`cacheTtlSeconds`, default 1h,
  clamped to `[0, 86400]`).
- **Configurable target.** Admin settings `catalogRepo`
  (`PLUGIN_EVERWORKS_SKILLS_REPO`, default `ever-works/skills`) and
  `catalogBranch` (`PLUGIN_EVERWORKS_SKILLS_BRANCH`, default `main`)
  point it at a different catalog; both are validated against strict
  repo/branch patterns. The plugin is `admin-only`.
- **`BUILTIN_CATALOG` fallback.** If the repo is unreachable, the
  manifest is malformed, or any `SKILL.md` fetch fails, the plugin falls
  back to a small built-in catalog so it always returns _something_ and
  self-recovers when the repo is reachable again. The fallback contains
  **three** built-in Skills: `cron-defaults`, `secret-handling`, and
  `commit-message-style`.
- **Update checks.** `checkForUpdates(installedVersions)` compares
  installed versions against the catalog and reports the Skills whose
  version changed.

### `autoEnable`

The plugin's `package.json` declares it under an `everworks.plugin`
manifest with:

```json
{
	"everworks": {
		"plugin": {
			"id": "everworks-skills",
			"capabilities": ["skills-provider"],
			"autoEnable": true,
			"defaultForCapabilities": ["skills-provider"],
			"distribution": "registry"
		}
	}
}
```

`autoEnable: true` means the platform turns the provider on without a
manual step, and `defaultForCapabilities` makes it the default resolver
for the `skills-provider` capability — so the curated catalog is
available out of the box.

## Go-to-market Skills

Sixteen first-party Skills ship **inside the platform** rather than in the
catalog repo. They are typed definitions in `@ever-works/contracts`
(`packages/contracts/src/skills/gtm-skills.ts`), projected into ordinary
catalog entries by the first-party skills provider — so they install,
render and attach through exactly the same path as a `SKILL.md` from the
public [`ever-works/skills`](https://github.com/ever-works/skills) repo,
and **a published Skill with the same slug wins over the built-in one**.

Two things follow from that, both visible in
`packages/plugins/everworks-skills/src/gtm-catalog.ts`:

- **The contract becomes the body.** The projection renders each
  definition's declared inputs and outputs as an **Inputs** table and an
  **Outputs** table above the instruction text, and keeps `stage`, `inputs`
  and `outputs` as extra frontmatter keys — which the parser preserves
  verbatim — so a Skill's contract survives install and stays inspectable.
- **The pack is served on both catalog paths.** The sixteen are unioned
  into the live `manifest.json` listing _and_ into the `BUILTIN_CATALOG`
  fallback described above, so they are available whether or not the
  catalog repo is reachable.

| Stage       | Skill                    | Slug                       | What it produces                                                                       |
| ----------- | ------------------------ | -------------------------- | -------------------------------------------------------------------------------------- |
| `research`  | Lead research            | `lead-research`            | `contacts` — name, company, title and a source reference; no source, no lead.          |
| `research`  | Competitor watch         | `competitor-watch`         | `signals` — dated observations, each with a source URL and the focus area it hits.     |
| `research`  | News signal detection    | `news-signal-detection`    | `signals` — relevance-ranked news items with source URL and publish date.              |
| `qualify`   | Lead scoring             | `lead-scoring`             | `scored_contacts` — a `score` of 0–100 plus `scoreReasons` per contact.                |
| `qualify`   | Risk filter              | `risk-filter`              | `scored_contacts` again, now carrying `riskScore`, `riskReasons` and an excluded flag. |
| `draft`     | Outreach personalization | `outreach-personalization` | `drafts` — one per contact, each with `ref`, `channel`, `subject` and `body`.          |
| `draft`     | Newsletter drafting      | `newsletter-drafting`      | `drafts` — a single issue: subject line plus sectioned body.                           |
| `draft`     | Social scheduling        | `social-scheduling`        | `drafts` — channel-fit posts, each with its planned slot in the calendar.              |
| `draft`     | Digest compilation       | `digest-compilation`       | `drafts` — a digest of sections, change highlights and a trend view.                   |
| `act`       | CRM sync hygiene         | `crm-sync-hygiene`         | `action_log` — prepared record writes, each with its field diff and reason.            |
| `follow-up` | Follow-up cadence        | `follow-up-cadence`        | `follow_up_queue` — queued touches with a due offset and the rationale for each.       |
| `follow-up` | Reply detection          | `reply-detection`          | `reply_state` — per-thread classification, confidence and routing decision.            |
| `enrich`    | Contact enrichment       | `contact-enrichment`       | `enriched_contacts` — filled fields with a source note recorded per fill.              |
| `measure`   | Search-visibility audit  | `seo-audit`                | `campaign_report` — prioritized findings with page reference, impact and fix.          |
| `measure`   | Campaign reporting       | `campaign-reporting`       | `campaign_report` — counted totals, insights and next-cycle variant hints.             |
| `measure`   | Engagement analysis      | `engagement-analysis`      | `campaign_report` — per-variant and per-segment engagement with a confidence call.     |

Output keys repeat on purpose: three `measure` Skills all write
`campaign_report`, and `risk-filter` reads and rewrites the same
`scored_contacts` that `lead-scoring` produced. The keys are the
go-to-market pipeline's own stage vocabulary, so a Skill's contract can be
read straight against the stage that invokes it.

:::note No Skill for the `review` stage
The pack covers seven of the pipeline's eight stages. There is deliberately
**no Skill for `review`** — that stage is a human gate, not a prompt. See
[Campaigns](./campaigns.md) for how the gate and its approvals work.
:::

Where to find them: the same **Skills** block at the bottom of **Sidebar →
Teams → Agents** (`/agents#skills`) as every other Skill — same tabs, same
search, same install and attach path — and on an Agent's own **Skills** tab.
The prebuilt go-to-market Agent templates already name these slugs as their
suggested Skills.

## Attaching Skills to Agents

An Agent template declares which Skills it wants via a `skills.yml`
manifest. The schema (`ever-works/agents` →
`schema/skills.schema.json`) has two required arrays, `required` and
`recommended`, each a list of `{ slug, why }` entries:

- **`required`** — Skills the Create-Agent wizard **auto-attaches and
  locks**. The user can remove them, but the wizard warns.
- **`recommended`** — Skills the wizard **pre-checks** but leaves the user
  free to deselect.

Each entry needs a `slug` (kebab-case, resolved against the
`ever-works/skills` catalog) and a `why` (8–200 chars, shown as a tooltip
in the wizard). A real example (`templates/starter-coder/skills.yml`):

```yaml
required:
    - slug: git
      why: The Coder branches, commits, and pushes for every Task.
    - slug: github-pr
      why: Opening the PR, polling reviewers, and replying to inline comments.
    - slug: test-runner
      why: The Coder must run lint, type-check, and tests locally before pushing.
recommended:
    - slug: code-search
      why: Read first, edit second. A fast repo-wide search makes the read step cheap.
```

:::note Unknown slugs are ignored, not rejected
A `skills.yml` slug that doesn't (yet) resolve against the catalog is
**ignored by the wizard, not rejected** (per the schema's own
description). This keeps templates forward-compatible with Skills that
haven't landed in the catalog.
:::

## Related pages

- [Skills API](/api/skills) — catalog reads and per-user install endpoints.
- [Agents Catalog](./agents-catalog.md) — the starter-agent templates that
  ship the `skills.yml` manifests.
- [Agents (Your AI Employees)](./agents.md) — the Agent product concept.
- [Campaigns](./campaigns.md) — the go-to-market Work the sixteen built-in
  Skills were written for, and the pipeline stages they map onto.
