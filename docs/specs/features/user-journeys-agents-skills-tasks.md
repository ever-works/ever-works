# User Journeys — Agents + Skills + Tasks

**Status**: `Draft`
**Last updated**: 2026-05-25
**Audience**: Product, design, engineering — concrete end-to-end stories showing how the three new features fit together with existing surfaces (Missions, Ideas, Works, KB, Plugins).

> These aren't acceptance criteria — those are in each feature's `spec.md`. These are illustrative narratives so you can spot UX gaps before code is written.

---

## J1 — The Indie Hacker who just wants to ship a blog faster

**Persona**: Aleksei, solo founder. Has 1 Work today (his SaaS marketing site). No Missions. No prior interest in Agents.

**Day 1 — discovers Agents:**

1. Aleksei opens the platform, sees a new "Agents" sidebar item with a `New` badge. Clicks.
2. Empty state explains: *"Agents are AI workers you can name and put to work alongside your Works. Try creating a "Content Writer" Agent to draft blog posts on a schedule."*
3. He clicks `+ New Agent`. The dialog mirrors the Work create dialog:
    - Name: `Content Writer`
    - Title: `Blog content lead`
    - Capabilities: `Write 3 blog posts per week about indie SaaS marketing. Keep voice casual and skeptical. Always link to canonical sources.`
    - Scope: `Work — marketing-site` (selected from dropdown of his existing 1 Work)
    - AI provider: `Use account default` (OpenRouter, gpt-5)
    - Heartbeat: `0 9 * * MON,WED,FRI` (Mon/Wed/Fri at 9am UTC)
    - Budget: $20/month (defaulted; he leaves it)
    - Permissions: `Can commit to repo: on`, everything else off.
4. Clicks Create. Lands on `/agents/content-writer`. Status is `draft`. He clicks `Start` — status flips to `active`, next heartbeat fires Monday 9am.
5. Monday morning, Aleksei gets an in-app notification: "Content Writer drafted a blog post. Review in PR #42." He visits the PR, suggests two edits, merges.
6. Within a week he has 3 posts published. He never opened the Tasks tab. The Skills tab is untouched. Costs: $4.20.

**What worked**: Default-everything path; tenant-scope-by-default; one CTA.
**What we need to verify**: Default budget ($20/month) is high enough for 3 posts/week of a competent model; Skills pre-attached behavior (the Content Writer auto-attached `seo-meta` and `internal-link-suggestions` from the catalog at create — does Aleksei see why?).

---

## J2 — Founder with a Mission, wants a small specialized team

**Persona**: Maya, building a Mission "Cats Business Worldwide". Already has 2 Works (a directory of cat products, a blog).

**Mission setup (already done before this feature):**

- Mission `cats-business-mission` with scheduled tick.
- 2 child Works visible in the Mission's "Works" section.

**Day 1 — Maya creates her CEO Agent:**

1. From `/missions/<id>` (now with a new tab strip), she clicks the new `Agents` tab.
2. Empty. She clicks `+ New Agent`.
3. Name `CEO`. Capabilities: *"You are the CEO of Cats Business Worldwide. Your job: make sure every Idea and Work ladders up to dominating the worldwide cat industry. Set direction. Delegate."*
4. Scope: `Mission — cats-business-mission`. AI provider: `Anthropic claude-sonnet-4-6`.
5. Heartbeat: `0 8 * * *` (daily 8am).
6. Permissions: `Can create Agents: ON`, `Can assign tasks: ON`. Everything else default off.
7. Create. Lands on `/agents/ceo`. She edits `SOUL.md` from the Instructions tab to add: *"Be terse. Use bullet points. Never write more than 200 words at a time."*
8. Saves. Commit lands in `<missionRepo>/.works/agents/ceo/SOUL.md`.

**Day 2 — CEO Agent creates a VP-Engineering:**

1. CEO Agent's first heartbeat runs at 8am.
2. Its response includes a `createSubAgent` tool call: `{name: 'VP-Engineering', scope: 'mission', capabilities: 'You own technical decisions for cats-business. Review schemas, approve plugin choices, escalate to CEO when blocked.', heartbeatCadence: '0 10 * * MON'}`.
3. Platform validates: CEO has `canCreateAgents = true`; scope=mission within CEO's reach — OK. Creates the row, writes files to `<missionRepo>/.works/agents/vp-engineering/`, status `draft` (humans must explicitly start sub-agents).
4. In-app notification: "CEO created VP-Engineering. Click to review and activate."
5. Maya reviews the auto-generated `AGENTS.md`, makes a small edit, clicks Start.

**Day 3 — VP-Engineering's first task:**

1. CEO's next heartbeat creates a Task: `Pick a screenshot plugin for the directory (currently using local; investigate ScreenshotOne vs Urlbox)`. Assignee: VP-Engineering. Scope: Work `cats-directory`. Priority p2.
2. Task transitions to `in_progress` immediately (since VP-Eng is an Agent assignee). VP-Engineering's heartbeat runs sooner (it's listed in the task's wait queue, not the normal 10am Mon slot).
3. VP-Engineering's run reads the screenshot plugin manifests, queries pricing pages via the existing `search` plugin, posts a chat reply: *"ScreenshotOne is $19/mo for 5k shots; Urlbox is $29 but supports our cookie-banner workaround. Recommend ScreenshotOne. Want me to switch the Work's plugin?"*
4. Maya replies in the chat: `@vp-engineering yes, switch it`.
5. VP-Engineering's `agent-chat-reply` run picks up the message, calls the `togglePlugin` tool (gated by `canCommitToRepo`), opens a PR against the Work's data repo, posts back: *"PR #43 opened. Will switch on merge."*

**What worked**: Hierarchy clicks for Maya — she sees CEO → VP-Eng → Task → Work flow without code. Tasks chat IS the collaboration medium.
**What we need to verify**: The "sub-agent auto-created in draft" friction is good (not bad) — Maya wants control over what gets activated. Also: when CEO's run cost is debited to CEO's budget but VP-Eng's task work is debited to VP-Eng's budget, is the breakdown clear in the Mission spend tile?

---

## J3 — Engineer using Agents to automate PR reviews across all Works

**Persona**: Devi, technical lead. Wants every PR opened against any of her Works to get an auto-review.

**Setup:**

1. From `/agents`, Devi creates `PR-Reviewer` agent.
2. Scope: `Tenant — available to all`. AI provider: account default. Heartbeat: `manual` (no cron).
3. Capabilities: *"Review pull requests opened against any of my Works. Post inline comments. Use the pr-review skill for the standard rubric."*
4. Permissions: `Can call external tools: ON`, `Can commit to repo: OFF` (we don't want auto-fixes).
5. Devi opens the new `/skills` page, sees `pr-review` in the Available section. Clicks Install. Then on `/agents/pr-reviewer/skills`, attaches the now-installed `pr-review` skill to this Agent.
6. Status flipped to `active` but no cron — runs only on event.

**The event hook (deferred to v2 in the spec):**

> The spec [features/agents/spec.md §6 Out of Scope](agents/spec.md#6-out-of-scope-v1) lists "Run on event" as v2. For now, Devi works around this:
>
> She creates a Task whenever she wants a review: `Review PR #N on cats-directory`, assigns `PR-Reviewer`. Task moves to `in_progress` → Agent run dispatches → reviews, posts inline comments on the PR via the GitHub plugin tools, closes the task.

**v2 ideal flow** (not in v1): a GitHub webhook fires on `pull_request.opened`; platform consults Agent's `runOn: [github.pull_request.opened]` config; creates the Task automatically. Same dispatch path.

**What worked in v1**: Devi can still get value by manually triggering. The Skills hierarchy clicked — install once, attach to one Agent.
**What we need to verify**: Manual-trigger UX is good enough until v2. Is the "Run heartbeat now" button on the Agent detail page discoverable for ad-hoc runs?

---

## J4 — Content team across multiple Works, one shared Skill

**Persona**: Tomás, content lead. Manages 4 Works (4 different niche directories) for his company.

**The workflow:**

1. He creates `Editor` Agent at tenant scope. Scope-membership: explicitly chooses all 4 Works.
2. From `/skills`, he authors a custom skill `house-style` with his company's voice guide. Saves at tenant scope. Attaches to `Editor` Agent.
3. He also goes to each of the 4 Works' `Skills` tabs and toggles `house-style` to "Inject into Generator". Now both the Editor Agent AND the standard pipeline (for items, comparisons, blog posts) inject `house-style`'s description + body excerpt into every AI call.
4. He notices the SEO skill `seo-meta` from the catalog. Installs it. Attaches to Editor AND injects into all 4 Works' Generators.

**Two weeks in:**

5. Tomás updates `house-style.md` (DB-inline since it's tenant scope) to soften "never use semicolons" to "minimize semicolons." His change applies instantly to all 4 Works and the Editor Agent. No re-deploy.
6. Catalog `seo-meta` ships v1.1. Tomás's `/skills` page shows "Update available" on his installed copy. He clicks Update. His copy gets the new body; his Work bindings keep pointing at his copy.

**What worked**: One Skill, many surfaces, single source of truth.
**What we need to verify**: Token budget — Editor runs in a Work that has `house-style` + `seo-meta` injected into the generator AND attached to the Agent. We don't want double-injection of the same skill body. Resolver must dedupe by `slug`.

---

## J5 — Tenant CEO orchestrating multiple Missions

**Persona**: Akira, runs 3 parallel Missions (`cats-business`, `mountain-gear-directory`, `dev-tools-newsletter`).

**Setup:**

1. From `/agents`, creates `Tenant-CEO` agent. Scope: `Tenant — all 3 Missions`.
2. Capabilities: *"You're the CEO across all my businesses. Look at all three Missions weekly. Flag the one with worst momentum. Suggest one concrete next step per Mission."*
3. Heartbeat: `0 9 * * MON` (weekly Monday 9am).
4. Permissions: `Can assign tasks: ON`, everything else off.

**Monday 9am:**

5. Tenant-CEO heartbeat fires. Run loads:
    - The Agent's MD files.
    - `getActivity()` tool reads last 7 days of activity across all 3 Missions.
    - `getMissionState()` tool reads current Ideas/Works counts per Mission.
    - Tenant-CEO's response: a 3-bullet weekly digest + 3 tasks (one per Mission), each assigned to **the existing Mission-scoped CEO Agent** in that Mission.

**This is the cross-scope task-assignment scenario.** Tenant-scoped Agent assigns to Mission-scoped Agents within its membership. Allowed per [architecture §3](../architecture/agents-skills-tasks.md). Each Mission CEO picks up the assigned task on its next heartbeat.

6. Akira reads the digest in the activity feed Monday morning over coffee. He doesn't need to action anything; the chain of CEOs is already executing.

**What worked**: Two-level hierarchy. Tenant CEO sees across; Mission CEOs execute within. Tenant CEO's budget is small (it just reads + assigns); Mission CEOs do the actual work.
**What we need to verify**: Tenant Agent reads across Missions (B2 in QUESTIONS). Default ON or OFF? J5 only works if it's ON.

---

## Cross-journey observations

### What recurs across all 5 journeys

- **Sidebar discovery is the entry point.** All 5 personas start by clicking a new sidebar item. The empty states (Agents, Skills, Tasks) must be self-explanatory.
- **"Use account default" is the friction-killer.** Everywhere a provider/model picker appears, the default selection is "Use account default" — and that's enough for ~80% of users.
- **Tenant scope is the default for the first Agent.** Mission/Work scopes feel like "advanced." We should bias UI defaults that direction.
- **Cost stays small for J1-J4.** Even J5 with 3 Missions stays under $50/month total. The default budget caps (Agent: $20, Work: $50) probably need a "review your defaults" prompt at 50% utilization, not at 80%.

### Where the design currently has holes

- **J3 needs event-trigger Agents.** v1 OOS, but worth documenting that the manual workaround works.
- **J5 needs cross-mission visibility** (QUESTIONS B2). If we pick "no, per-run scoping" the Tenant CEO use case is harder; needs an explicit context-handoff.
- **J2's "sub-agent in draft" friction** could be wrong direction — maybe sub-agents auto-activate but with a banner; collect feedback.
- **J4's deduplication** is a real concern when one skill is injected via two paths (Agent's bindings + Work's Generator). The resolver in [Skills spec §3.3 FR-9](skills/spec.md) dedupes by slug — but we should write a unit test for this exact case.

### Where the design holds up well

- **Hierarchy of CEOs** (J5 → J2 → individual contributors) maps naturally onto Tenant → Mission → Work scopes.
- **Tasks as the only Agent ↔ Agent channel** (per [QUESTIONS B3](../QUESTIONS-agents-skills-tasks.md#b3--agent-to-agent-communication-forced-through-tasks-or-allow-dms)) gives every cross-Agent interaction an audit trail and a budget owner.
- **Skills layered over Works' WorkAdvancedPrompts** lets users keep the per-Work-tweak surface AND add reusable Skills. Two complementary tools, not competing ones.

---

## References

- [`agents/spec.md`](agents/spec.md), [`skills/spec.md`](skills/spec.md), [`task-tracking/spec.md`](task-tracking/spec.md)
- [`../architecture/agents-skills-tasks.md`](../architecture/agents-skills-tasks.md)
- [`../architecture/agent-prompt-assembly.md`](../architecture/agent-prompt-assembly.md)
- [`../QUESTIONS-agents-skills-tasks.md`](../QUESTIONS-agents-skills-tasks.md)
