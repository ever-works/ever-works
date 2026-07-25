/**
 * First-party go-to-market Skills — Wave 10 (agent-platform parity).
 *
 * The prebuilt Agent templates (`@ever-works/agent` → `agent-templates.ts`)
 * name the Skills they pair with by slug. Those slugs were a promise with
 * nothing behind them: the first-party skills-provider plugin served a
 * three-entry builtin fallback plus whatever the catalog repo happened to
 * publish, so activating a template produced an Agent whose suggested
 * Skills resolved to nothing.
 *
 * This module is the missing half — a typed, in-code catalog of the
 * go-to-market Skills those templates reference. It lives in
 * `@ever-works/contracts` for the same reason `work-kind.ts` does: the
 * skills-provider plugin (which serves them) and the agent package (which
 * references them from templates) share no other runtime package, and the
 * catalog-integrity check that keeps the two halves honest needs one list
 * to compare against.
 *
 * A Skill here is pure DATA — a declared input/output contract plus the
 * instruction body injected at AI-call time. No Skill runs anything on its
 * own: the LLM work happens through the existing AI facade, and the
 * connector work happens through the existing plugin grants. What each
 * Skill IS deterministic about is its own contract — which keys it reads,
 * which keys it writes, and which tool families it expects to be granted.
 */

/**
 * Go-to-market pipeline stage a Skill belongs to.
 *
 * Mirrors the stage vocabulary of the `gtm-pipeline` pipeline plugin
 * (research → qualify → draft → review → act → follow-up → enrich →
 * measure). Duplicated as a literal union rather than imported because
 * `@ever-works/contracts` sits BELOW the plugin packages in the dependency
 * graph — the stage-parity check lives in the plugin's own suite.
 */
export const GTM_SKILL_STAGES = [
	'research',
	'qualify',
	'draft',
	'review',
	'act',
	'follow-up',
	'enrich',
	'measure'
] as const;

export type GtmSkillStage = (typeof GTM_SKILL_STAGES)[number];

/**
 * One declared input or output key of a Skill.
 *
 * Keys are snake_case and share the vocabulary of the go-to-market
 * pipeline's stage data keys (`contacts`, `signals`, `scored_contacts`,
 * `drafts`, …) so a Skill's contract can be read against the stage that
 * invokes it without a translation table.
 */
export interface GtmSkillIo {
	/** snake_case data key. */
	readonly key: string;
	/** What the key carries — one line, shown in the Skill detail view. */
	readonly description: string;
}

/**
 * A first-party go-to-market Skill.
 *
 * `body` is the SKILL.md text WITHOUT frontmatter: the skills-provider
 * plugin re-emits it as a canonical catalog entry, and the platform stores
 * frontmatter and body separately (see `SkillCatalogEntry` in
 * `@ever-works/plugin`).
 */
export interface GtmSkillDefinition {
	/** Stable kebab-case identifier — the catalog slug and the id templates reference. */
	readonly slug: string;
	/** Human-readable title shown in the Skills catalog. */
	readonly title: string;
	/** One-line summary shown in pickers and search results. */
	readonly description: string;
	/** Which go-to-market stage this Skill powers. */
	readonly stage: GtmSkillStage;
	/** Catalog tags — drive the Skills page filters. */
	readonly tags: readonly string[];
	/** Semver of the Skill body; bumped when the instructions change materially. */
	readonly version: string;
	/** Data keys the Skill expects to be present before it runs. */
	readonly inputs: readonly GtmSkillIo[];
	/** Data keys the Skill is responsible for producing. */
	readonly outputs: readonly GtmSkillIo[];
	/**
	 * Tool families the Skill expects to be granted, as an allowlist hint.
	 * Advisory, not enforcement: actual grants come from the Agent's
	 * permissions and the plugin capability grants. An empty array means the
	 * Skill needs no tools beyond the model itself.
	 */
	readonly allowedTools: readonly string[];
	/** SKILL.md body — the instruction text injected into the AI call. */
	readonly body: string;
}

const VERSION = '1.0.0';

/**
 * The catalog.
 *
 * Ordered by pipeline stage so the list reads as the campaign lifecycle.
 * Every slug referenced by an Agent template MUST appear here — the
 * catalog-integrity suite in `@ever-works/agent` fails the build otherwise.
 */
export const GTM_SKILLS: readonly GtmSkillDefinition[] = [
	// ── research ────────────────────────────────────────────────────────
	{
		slug: 'lead-research',
		title: 'Lead research',
		description:
			'Build a candidate lead list from seed criteria and public sources, recording a supporting source for every contact.',
		stage: 'research',
		tags: ['gtm', 'sales', 'research'],
		version: VERSION,
		inputs: [
			{ key: 'icp', description: 'Ideal-customer description: segment, size, geography, role titles.' },
			{ key: 'seed_sources', description: 'Seed lists, domains, or saved searches to start from.' },
			{ key: 'max_leads', description: 'Hard cap on how many candidates this run may collect.' }
		],
		outputs: [
			{ key: 'contacts', description: 'Candidate contacts with name, company, title, and a source reference.' }
		],
		allowedTools: ['search', 'content-extractor'],
		body: [
			'Build a candidate lead list from the supplied criteria and seed sources.',
			'',
			'## Rules',
			'- NEVER invent a contact detail. An email address, phone number, or title is recorded only',
			'  when a source supports it; otherwise leave the field empty.',
			'- Record `source` on every contact — the URL or seed list the entry came from. A contact',
			'  without a source is not a lead, it is a guess.',
			'- Respect `max_leads` exactly. Stop collecting when the cap is reached and say how many',
			'  candidates were left unexamined.',
			'- De-duplicate by email when present, otherwise by (company, name).',
			'- Exclude anyone who has asked not to be contacted, and any source that forbids collection.',
			'',
			'## Output',
			'Write `contacts`. Each entry carries `name`, and any of `email`, `company`, `title`,',
			'`source`, `notes` that a source supports. Report the counts examined, kept, and dropped,',
			'with the reason for each drop category.'
		].join('\n')
	},
	{
		slug: 'competitor-watch',
		title: 'Competitor watch',
		description:
			'Monitor a watchlist of companies across public sources and emit dated, source-linked change signals.',
		stage: 'research',
		tags: ['gtm', 'marketing', 'research'],
		version: VERSION,
		inputs: [
			{ key: 'watchlist', description: 'Companies to monitor: name, website, public repositories.' },
			{ key: 'focus_areas', description: 'What to watch: pricing, features, positioning, hiring.' },
			{ key: 'since', description: 'Only report changes observed after this date.' }
		],
		outputs: [{ key: 'signals', description: 'Dated observations with a source URL and the focus area they hit.' }],
		allowedTools: ['search', 'content-extractor'],
		body: [
			'Monitor the watchlist across public sources and report what changed.',
			'',
			'## Rules',
			'- Public sources only: published pages, public announcements, public repositories.',
			'- Every signal carries a source URL and an observation date. No date or no URL means the',
			'  signal is not reportable.',
			'- Separate FACT (what the source says) from ANALYSIS (what you infer). Never blend them in',
			'  the same sentence.',
			'- Report only changes since `since`. If a focus area produced nothing, say so explicitly —',
			'  an empty period is a finding, not a gap to fill.',
			'- Do not speculate about unannounced plans, internal metrics, or private information.',
			'',
			'## Output',
			'Write `signals`. Each entry carries `title`, `url`, `publishedDate`, the focus area, and a',
			'one-line factual summary.'
		].join('\n')
	},
	{
		slug: 'news-signal-detection',
		title: 'News signal detection',
		description:
			'Scan configured topics for newsworthy events and rank them by relevance to the campaign, discarding noise.',
		stage: 'research',
		tags: ['gtm', 'marketing', 'research'],
		version: VERSION,
		inputs: [
			{ key: 'topics', description: 'Topics, keywords, or accounts to scan.' },
			{ key: 'lookback_days', description: 'How far back the scan reaches.' },
			{ key: 'relevance_threshold', description: 'Minimum relevance (0-1) an item must clear to be kept.' }
		],
		outputs: [{ key: 'signals', description: 'Relevance-ranked news items with source URL and publish date.' }],
		allowedTools: ['search', 'content-extractor'],
		body: [
			'Scan the configured topics and keep only what is genuinely newsworthy for this campaign.',
			'',
			'## Rules',
			'- Score each candidate 0-1 for relevance to the campaign brief and drop anything below',
			'  `relevance_threshold`. State the score and the one-line reason for every item you keep.',
			'- Prefer primary sources over aggregators; when both exist, link the primary.',
			'- Collapse duplicate coverage of the same event into one signal with the best source.',
			'- Nothing older than `lookback_days`. Undated items are dropped, not guessed at.',
			'- Never restate a headline as fact when the source hedges it — carry the hedge through.',
			'',
			'## Output',
			'Write `signals` ordered by descending relevance, each with `title`, `url`, `publishedDate`,',
			'the relevance score, and the reason it matters here.'
		].join('\n')
	},

	// ── qualify ─────────────────────────────────────────────────────────
	{
		slug: 'lead-scoring',
		title: 'Lead scoring',
		description:
			'Score contacts 0-100 against a declarative weight table and attach an explainable reason per point awarded.',
		stage: 'qualify',
		tags: ['gtm', 'sales', 'scoring'],
		version: VERSION,
		inputs: [
			{ key: 'contacts', description: 'Candidate contacts to score.' },
			{ key: 'score_weights', description: 'Weight table: signal name → points awarded.' }
		],
		outputs: [
			{ key: 'scored_contacts', description: 'Contacts with `score` (0-100) and `scoreReasons` per contact.' }
		],
		allowedTools: [],
		body: [
			'Score every contact against the supplied weight table.',
			'',
			'## Rules',
			'- The weight table is the whole model. Award points ONLY for signals it names; never invent',
			'  a bonus, and never award points for a signal the contact data does not actually support.',
			'- Clamp the final score to 0-100. Record one `scoreReasons` line per point awarded, in the',
			'  form `<signal> +<points>`, so any score can be re-derived by hand.',
			'- A missing field is worth zero points, never an assumed value.',
			'- Scoring is deterministic: the same contact and the same weight table must always produce',
			'  the same score. Do not break ties with judgement calls — leave ties tied.',
			'',
			'## Output',
			'Write `scored_contacts` sorted by descending score, then report the score distribution and',
			'the three signals that moved the list most.'
		].join('\n')
	},
	{
		slug: 'risk-filter',
		title: 'Risk filter',
		description:
			'Flag low-quality or unsafe contacts against a risk weight table and exclude those at or above the threshold.',
		stage: 'qualify',
		tags: ['gtm', 'sales', 'safety'],
		version: VERSION,
		inputs: [
			{ key: 'scored_contacts', description: 'Contacts already carrying a priority score.' },
			{ key: 'risk_weights', description: 'Risk weight table: risk signal → points.' },
			{ key: 'risk_threshold', description: 'Risk score at or above which a contact is excluded.' }
		],
		outputs: [
			{
				key: 'scored_contacts',
				description: 'The same contacts, now carrying `riskScore`, `riskReasons`, and an excluded flag.'
			}
		],
		allowedTools: [],
		body: [
			'Assess each scored contact for risk and mark — never silently delete — the excluded ones.',
			'',
			'## Rules',
			'- Apply the risk weight table exactly as given; record one `riskReasons` line per point.',
			'- Contacts at or above `risk_threshold` are EXCLUDED from outbound, but they stay in the',
			'  data set with their reasons attached so a human can overturn the call.',
			'- Never drop a contact without a recorded reason. "Looked wrong" is not a reason.',
			'- Risk is about deliverability and safety (unverifiable identity, throwaway domains,',
			'  do-not-contact signals) — it is not a second opinion on fit. Fit is `lead-scoring`.',
			'',
			'## Output',
			'Write the enriched `scored_contacts` and report how many were excluded, grouped by the',
			'dominant risk reason.'
		].join('\n')
	},

	// ── draft ───────────────────────────────────────────────────────────
	{
		slug: 'outreach-personalization',
		title: 'Outreach personalization',
		description:
			'Write one 80-120 word personalized outbound draft per qualified contact, grounded only in known facts.',
		stage: 'draft',
		tags: ['gtm', 'sales', 'writing'],
		version: VERSION,
		inputs: [
			{ key: 'scored_contacts', description: 'Qualified, non-excluded contacts to write for.' },
			{ key: 'campaign_brief', description: 'Offer, proof points, and the single ask.' },
			{ key: 'tone', description: 'Configured tone for the campaign.' }
		],
		outputs: [{ key: 'drafts', description: 'One draft per contact with `ref`, `channel`, `subject`, `body`.' }],
		allowedTools: [],
		body: [
			'Write one outbound draft per qualified contact.',
			'',
			'## Rules',
			'- HARD CONSTRAINT: drafts only. Nothing is sent, scheduled, or queued for delivery here.',
			'- 80-120 words in the body. One ask. No multi-part asks, no "quick question" openers that',
			'  the rest of the message contradicts.',
			'- Personalize ONLY from fields and signals actually present on the contact. If there is no',
			'  personalization material, write the generic version and say so — a fabricated detail is',
			'  worse than a generic opener.',
			'- Write a subject line only for channels that carry one.',
			'- No invented metrics, customer names, or mutual connections. Ever.',
			'',
			'## Output',
			'Write `drafts`, ordered by descending contact score so the review gate sees the best',
			'candidates first. Each draft carries a stable `ref` used later by review and the action log.'
		].join('\n')
	},
	{
		slug: 'newsletter-drafting',
		title: 'Newsletter drafting',
		description:
			'Turn briefs, notes, and collected signals into a scannable newsletter issue with one clear call to action.',
		stage: 'draft',
		tags: ['gtm', 'marketing', 'content', 'writing'],
		version: VERSION,
		inputs: [
			{ key: 'campaign_brief', description: 'Issue theme, audience, and the call to action.' },
			{ key: 'signals', description: 'Collected source material for the issue.' },
			{ key: 'tone', description: 'Configured editorial tone.' }
		],
		outputs: [{ key: 'drafts', description: 'A single newsletter draft: subject line plus sectioned body.' }],
		allowedTools: ['content-extractor'],
		body: [
			'Draft one newsletter issue from the brief and the collected material.',
			'',
			'## Rules',
			'- Draft-first: the issue is produced for human review. Never send or schedule it.',
			'- Structure: subject line, one-sentence hook, 3-5 short sections, one call to action.',
			'  Scannable beats comprehensive.',
			'- Every claim traces to the brief, the knowledge base, or a supplied signal. Link the',
			'  source when the section rests on one.',
			'- Never invent metrics, quotes, or customer names.',
			'- When the source material is thin, say so and list what extra input would raise quality',
			'  rather than padding the issue.',
			'',
			'## Output',
			'Write `drafts` with a single entry: `subject` plus the sectioned `body`.'
		].join('\n')
	},
	{
		slug: 'social-scheduling',
		title: 'Social scheduling',
		description:
			'Plan a channel-fit social calendar and stage each post for review, respecting cadence and angle variety.',
		stage: 'draft',
		tags: ['gtm', 'marketing', 'social', 'writing'],
		version: VERSION,
		inputs: [
			{ key: 'campaign_brief', description: 'Campaign themes, channels, and cadence.' },
			{ key: 'signals', description: 'Source material and trends to build posts from.' },
			{ key: 'cadence', description: 'Posts per channel per period.' }
		],
		outputs: [
			{ key: 'drafts', description: 'Channel-fit post drafts, each with its planned slot in the calendar.' }
		],
		allowedTools: [],
		body: [
			'Plan the social calendar for the cadence window and draft each post.',
			'',
			'## Rules',
			'- Draft-first: posts are STAGED for review. Never publish, never schedule to a live channel.',
			'- Fit each draft to its channel: length, hashtag conventions, and link placement differ and',
			'  a cross-posted body is a tell.',
			'- Do not repeat the same angle inside one cadence window. Track the angle per slot and vary',
			'  it deliberately.',
			'- Build only from the brief, the content Works, and supplied signals. Never invent product',
			'  claims or engagement numbers.',
			'- Respect `cadence` exactly — proposing more slots than the operator configured is not',
			'  ambition, it is a spam risk.',
			'',
			'## Output',
			'Write `drafts` with the planned slot (channel + relative day) on each entry, plus a compact',
			'calendar view of the window.'
		].join('\n')
	},
	{
		slug: 'digest-compilation',
		title: 'Digest compilation',
		description:
			'Compile collected signals into a recurring digest that separates facts from analysis and highlights change.',
		stage: 'draft',
		tags: ['gtm', 'marketing', 'reporting', 'writing'],
		version: VERSION,
		inputs: [
			{ key: 'signals', description: 'Signals collected this period.' },
			{ key: 'previous_digest', description: 'The prior issue, used to compute what changed.' },
			{ key: 'focus_areas', description: 'Sections the digest must cover.' }
		],
		outputs: [{ key: 'drafts', description: 'A digest draft: sections, change highlights, and a trend view.' }],
		allowedTools: [],
		body: [
			'Compile the period digest from the collected signals.',
			'',
			'## Rules',
			'- One section per focus area, in the configured order, every issue. A stable shape is what',
			'  makes a recurring digest readable.',
			'- Every section splits FACTS (sourced, dated, linked) from ANALYSIS (your interpretation),',
			'  under those labels.',
			'- Lead with what CHANGED since `previous_digest`. Unchanged areas get one line, not a',
			'  restatement of last issue.',
			'- No fabrication and no padding: if a focus area produced no signal this period, write',
			'  exactly that.',
			'- Close with a short trend view over the recent periods — direction, not prophecy.',
			'',
			'## Output',
			'Write `drafts` with a single digest entry for review.'
		].join('\n')
	},

	// ── act ─────────────────────────────────────────────────────────────
	{
		slug: 'crm-sync-hygiene',
		title: 'CRM sync hygiene',
		description:
			'Prepare reviewed records for a customer-record sync: normalized fields, no duplicates, no destructive overwrites.',
		stage: 'act',
		tags: ['gtm', 'sales', 'operations'],
		version: VERSION,
		inputs: [
			{ key: 'approved_drafts', description: 'Records cleared by the review gate.' },
			{ key: 'field_map', description: 'Local field → destination field mapping.' }
		],
		outputs: [
			{ key: 'action_log', description: 'Prepared record writes with the field diff and the reason for each.' }
		],
		allowedTools: ['connector'],
		body: [
			'Prepare reviewed records for the destination system without losing data.',
			'',
			'## Rules',
			'- Only records that passed the review gate are eligible. Nothing else, no exceptions.',
			'- NEVER overwrite a populated destination field with an empty local value. Blank does not',
			'  mean "clear it", it means "we do not know".',
			'- Match before you create: search by the destination key (email, then domain + name) and',
			'  update the existing record rather than minting a duplicate.',
			'- Normalize on the way out — casing, phone format, domain form — per `field_map`.',
			'- Record every intended write in `action_log` with its field-level diff BEFORE it is',
			'  applied, so the change is auditable and reversible.',
			'',
			'## Output',
			'Write `action_log` with one entry per record, status `prepared` or `skipped`, and the',
			'reason for every skip.'
		].join('\n')
	},

	// ── follow-up ───────────────────────────────────────────────────────
	{
		slug: 'follow-up-cadence',
		title: 'Follow-up cadence',
		description:
			'Schedule timed re-engagement for quiet threads, with strict caps and an unconditional stop on any reply.',
		stage: 'follow-up',
		tags: ['gtm', 'sales', 'cadence'],
		version: VERSION,
		inputs: [
			{ key: 'action_log', description: 'What was prepared, for whom, and when.' },
			{ key: 'reply_state', description: 'Which threads have received a reply.' },
			{ key: 'cadence', description: 'Follow-up spacing and the maximum number of touches.' }
		],
		outputs: [
			{ key: 'follow_up_queue', description: 'Queued follow-ups with a due offset and the rationale for each.' }
		],
		allowedTools: [],
		body: [
			'Queue follow-ups for threads that have gone quiet.',
			'',
			'## Rules',
			'- HARD STOP on any reply, bounce, or opt-out: that thread leaves the cadence immediately and',
			'  permanently. This overrides every other rule here.',
			'- Never exceed the configured maximum touches per contact, and never shorten the configured',
			'  spacing to fit more in.',
			'- Each follow-up must add something — a new angle, a new proof point, a genuine deadline.',
			'  "Bumping this to the top of your inbox" is not a follow-up.',
			'- Follow-ups are drafts like any other outbound: they re-enter the review gate before',
			'  anything is prepared for delivery.',
			'',
			'## Output',
			'Write `follow_up_queue` with `draftRef`, `channel`, `dueAfterDays`, and the rationale.'
		].join('\n')
	},
	{
		slug: 'reply-detection',
		title: 'Reply detection',
		description:
			'Classify inbound replies into interested / not-now / decline / opt-out and route each to the right next step.',
		stage: 'follow-up',
		tags: ['gtm', 'sales', 'classification'],
		version: VERSION,
		inputs: [
			{ key: 'inbound_messages', description: 'Replies received against prepared outbound.' },
			{ key: 'action_log', description: 'The outbound each reply responds to.' }
		],
		outputs: [
			{ key: 'reply_state', description: 'Per-thread classification, confidence, and the routing decision.' }
		],
		allowedTools: ['connector'],
		body: [
			'Classify each inbound reply and decide what happens to its thread.',
			'',
			'## Classes',
			'`interested` · `not_now` · `decline` · `opt_out` · `auto_reply` · `unclear`',
			'',
			'## Rules',
			'- `opt_out` and `decline` stop the cadence permanently. When in doubt between `opt_out` and',
			'  anything else, choose `opt_out` — the cost of a wrong stop is far below the cost of a',
			'  wrong send.',
			'- `auto_reply` (out-of-office, autoresponder) does NOT count as a reply for cadence',
			'  purposes, but it does update the contact record if it names a new owner.',
			'- Use `unclear` rather than guessing; unclear threads route to a human, they do not route',
			'  to the next touch.',
			'- Record a confidence value and the phrase that drove the classification.',
			'',
			'## Output',
			'Write `reply_state` with the class, confidence, evidence phrase, and routing decision per',
			'thread.'
		].join('\n')
	},

	// ── enrich ──────────────────────────────────────────────────────────
	{
		slug: 'contact-enrichment',
		title: 'Contact enrichment',
		description:
			'Backfill missing contact and account fields from verifiable sources, recording the evidence for each fill.',
		stage: 'enrich',
		tags: ['gtm', 'sales', 'data'],
		version: VERSION,
		inputs: [
			{ key: 'contacts', description: 'Contacts with gaps to fill.' },
			{ key: 'enrichment_fields', description: 'Which fields this run is allowed to fill.' }
		],
		outputs: [
			{ key: 'enriched_contacts', description: 'Contacts with filled fields and a source note per filled field.' }
		],
		allowedTools: ['search', 'content-extractor', 'connector'],
		body: [
			'Fill the requested gaps on each contact — and only those gaps.',
			'',
			'## Rules',
			'- Evidence-bound: a field is filled ONLY when a source supports it, and the source goes in',
			'  the contact notes alongside the value. No source, no fill.',
			'- NEVER guess or pattern-generate an email address. Constructing `first.last@domain` because',
			'  it usually works is fabrication, and it is the single most damaging thing this Skill can do.',
			'- Never overwrite an existing non-empty value. Enrichment fills gaps; corrections are a',
			'  human decision.',
			'- Only touch fields named in `enrichment_fields`.',
			'- When two sources disagree, leave the field empty and flag the conflict.',
			'',
			'## Output',
			'Write `enriched_contacts` and report fill rate per field plus every conflict flagged.'
		].join('\n')
	},

	// ── measure ─────────────────────────────────────────────────────────
	{
		slug: 'seo-audit',
		title: 'Search-visibility audit',
		description:
			'Audit a site or content Work for search visibility and return a prioritized, evidence-cited fix list.',
		stage: 'measure',
		tags: ['gtm', 'marketing', 'seo', 'audit'],
		version: VERSION,
		inputs: [
			{ key: 'pages', description: 'Pages or posts in scope, with their current metadata and headings.' },
			{ key: 'target_keywords', description: 'Keywords or topics the Work is meant to rank for.' },
			{ key: 'previous_audit', description: 'The prior audit, used to report movement and regressions.' }
		],
		outputs: [
			{ key: 'campaign_report', description: 'Prioritized findings with page reference, impact, and fix.' }
		],
		allowedTools: ['content-extractor', 'search'],
		body: [
			'Audit the in-scope pages for search visibility and propose fixes.',
			'',
			'## What to check',
			'Title and description metadata · heading structure and hierarchy · internal linking and',
			'orphan pages · keyword coverage against `target_keywords` and the gaps between them ·',
			'duplicate or thin content · canonical and indexability signals.',
			'',
			'## Rules',
			'- Every finding cites the specific page or setting it applies to and states the expected',
			'  impact. A finding without a page reference is an opinion.',
			'- Return a prioritized top 5-10, quick wins first — not an exhaustive dump.',
			'- Propose changes as reviewable edits or tasks. Never modify published pages directly.',
			'- When `previous_audit` is present, report movement honestly, INCLUDING regressions. A',
			'  clean report that hides a regression is worse than no report.',
			'- No traffic or ranking projections. Estimate effort and impact qualitatively instead.',
			'',
			'## Output',
			'Write `campaign_report` with the prioritized findings and the movement summary.'
		].join('\n')
	},
	{
		slug: 'campaign-reporting',
		title: 'Campaign reporting',
		description:
			'Summarize a campaign period into counted totals, honest insights, and concrete hints for the next cycle.',
		stage: 'measure',
		tags: ['gtm', 'reporting'],
		version: VERSION,
		inputs: [
			{ key: 'action_log', description: 'What the campaign prepared and skipped.' },
			{ key: 'reply_state', description: 'How recipients responded.' },
			{ key: 'scored_contacts', description: 'The qualified population the period worked from.' }
		],
		outputs: [{ key: 'campaign_report', description: 'Totals, insights, and next-cycle variant hints.' }],
		allowedTools: [],
		body: [
			'Report the campaign period and close the loop into the next one.',
			'',
			'## Rules',
			'- Totals are COUNTED from the supplied data, never estimated: contacts, qualified, excluded,',
			'  drafts, approved, prepared, follow-ups queued.',
			'- State the denominator on every rate. A percentage without its base is not a metric.',
			'- Below roughly 30 observations, report counts and refuse to draw a conclusion — small',
			'  samples produce confident nonsense.',
			'- Insights must be falsifiable and tied to a number in the totals.',
			'- End with `nextVariantHints`: concrete, testable changes for the next draft cycle, one per',
			'  line. This is the loop closing — a report that ends at description wasted the period.',
			'',
			'## Output',
			'Write `campaign_report` with `summary`, `totals`, `insights`, and `nextVariantHints`.'
		].join('\n')
	},
	{
		slug: 'engagement-analysis',
		title: 'Engagement analysis',
		description: 'Compare engagement across variants, channels, and segments, and say which differences are real.',
		stage: 'measure',
		tags: ['gtm', 'marketing', 'reporting'],
		version: VERSION,
		inputs: [
			{ key: 'engagement_events', description: 'Per-item engagement observations for the period.' },
			{ key: 'drafts', description: 'The variants the events belong to.' },
			{ key: 'comparison_window', description: 'Prior period to compare against.' }
		],
		outputs: [
			{ key: 'campaign_report', description: 'Per-variant and per-segment engagement with a confidence call.' }
		],
		allowedTools: ['metrics'],
		body: [
			'Analyze engagement and report what actually differs.',
			'',
			'## Rules',
			'- Compare like with like: same channel, same audience segment, comparable send window.',
			'  Cross-channel comparisons need an explicit caveat.',
			'- Report absolute counts alongside every rate.',
			'- Say plainly when a difference is within noise. Declaring a winner on a handful of',
			'  observations is the most common way this analysis misleads a campaign for months.',
			'- Separate what changed (observation) from why (hypothesis), and label hypotheses as such.',
			'- Surface the losing variants too — a variant that consistently underperforms is the',
			'  cheapest thing to stop doing.',
			'',
			'## Output',
			'Write `campaign_report` with the per-variant table, the segment breakdown, and an explicit',
			'confidence statement per comparison.'
		].join('\n')
	}
] as const;

/** Every slug in the first-party go-to-market Skill catalog. */
export const GTM_SKILL_SLUGS: readonly string[] = GTM_SKILLS.map((skill) => skill.slug);

const GTM_SKILL_BY_SLUG: ReadonlyMap<string, GtmSkillDefinition> = new Map(
	GTM_SKILLS.map((skill) => [skill.slug, skill])
);

/** The full catalog, in declared (pipeline-stage) order. */
export function listGtmSkills(): readonly GtmSkillDefinition[] {
	return GTM_SKILLS;
}

/** One Skill by slug; `undefined` when the slug is unknown. NEVER throws. */
export function getGtmSkill(slug?: string | null): GtmSkillDefinition | undefined {
	return typeof slug === 'string' ? GTM_SKILL_BY_SLUG.get(slug.trim().toLowerCase()) : undefined;
}

/** True when `slug` names a first-party go-to-market Skill. */
export function isGtmSkillSlug(slug?: string | null): boolean {
	return getGtmSkill(slug) !== undefined;
}

/** Skills powering a given go-to-market stage, in declared order. */
export function listGtmSkillsForStage(stage: GtmSkillStage): readonly GtmSkillDefinition[] {
	return GTM_SKILLS.filter((skill) => skill.stage === stage);
}
