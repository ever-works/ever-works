import type { PlaybookCatalogEntry, PlaybookGuardrails, PlaybookStep } from '@ever-works/contracts';

/**
 * The built-in Playbook catalogue — eight packaged outcomes that ship with
 * the build and are available with no network access at all.
 *
 * Every entry is provisioned through existing Ever Works rows only: an Agent
 * from one of the built-in Agent templates, first-party Skills bound to it, a
 * Task template built from `steps`, a cadence, and the approval guardrails.
 * `builtin-catalog.spec.ts` pins every Skill slug against the first-party
 * Skill catalogue, and the agent package pins every Agent template slug, so
 * a playbook can never reference something the running build does not have.
 *
 * Connections name CAPABILITIES only. Five of the eight need none.
 */

/** Adoption always starts here: every proposed action queues for a human. */
const ASK_BEFORE_EVERYTHING: PlaybookGuardrails = {
	mode: 'require_approval',
	blockedActionTypes: ['budget_override']
};

function steps(
	...items: ReadonlyArray<readonly [title: string, produces: string, requiresApproval?: boolean]>
): PlaybookStep[] {
	return items.map(([title, produces, requiresApproval], index) => ({
		position: index + 1,
		title,
		produces,
		requiresApproval: requiresApproval === true
	}));
}

const ENTRIES: PlaybookCatalogEntry[] = [
	{
		slug: 'weekly-operations-report',
		title: 'Weekly operations report',
		outcome: 'One document every Monday: what shipped, what is stuck, and what needs you.',
		summary:
			'Reads the last seven days of Tasks, Runs and open decisions across the workspace and writes one short report into the Knowledge Base. Its "Needs you" section links every open decision instead of creating new ones.',
		category: 'reporting',
		version: '1.0.0',
		icon: 'report',
		trigger: {
			kind: 'schedule',
			cadence: '0 7 * * 1',
			defaultLocalTime: '07:00',
			description: 'Every Monday at 07:00, in your workspace timezone'
		},
		steps: steps(
			['Read the week', 'A list of the Tasks that finished, stalled or were blocked.'],
			['Read the runs', 'Run outcomes and cost for the same seven days.'],
			['Collect open decisions', 'Links to every approval and escalation still waiting.'],
			['Write the report', 'One Knowledge Base document with shipped, stuck and needs-you sections.']
		),
		connections: [],
		artefacts: [{ kind: 'kb_document', title: 'Weekly operations report', where: 'One per week, in Reports' }],
		escalations: [
			{
				when: 'The report links every open decision; it never opens one of its own',
				becomes: 'approval',
				carriesRecommendation: false
			}
		],
		caps: { maxWordCount: 600, maxPerRun: 1 },
		costBand: 'low',
		estimatedTokensPerRun: { min: 8000, max: 20000 },
		tags: ['weekly', 'report', 'operations'],
		provision: {
			agentTemplateSlug: 'content-marketer',
			agentName: 'Ops reporter',
			skillSlugs: ['digest-compilation', 'campaign-reporting'],
			taskTemplate: { name: 'Weekly operations report', slug: 'weekly-operations-report' },
			guardrailsAtAdoption: ASK_BEFORE_EVERYTHING,
			graduatedGuardrails: { mode: 'autonomous', autoApproveActionTypes: ['schedule_task'] }
		}
	},
	{
		slug: 'daily-decision-brief',
		title: 'Morning decision brief',
		outcome: 'Ten lines before you start: what needs you, and what runs today.',
		summary:
			'Every weekday morning it lists the decisions waiting for you, ranked by what they block, and the schedules due to fire today. Short by design — it points at the work rather than repeating it.',
		category: 'operations',
		version: '1.0.0',
		icon: 'sunrise',
		trigger: {
			kind: 'schedule',
			cadence: '0 7 * * 1-5',
			defaultLocalTime: '07:00',
			description: 'Weekdays at 07:00, in your workspace timezone'
		},
		steps: steps(
			['Rank open decisions', 'Waiting approvals and escalations, ordered by what they block.'],
			['List today’s runs', 'The schedules and triggers due to fire today.'],
			['Write the brief', 'A ten-line brief with a link on every line.']
		),
		connections: [],
		artefacts: [{ kind: 'kb_document', title: 'Morning decision brief', where: 'One per weekday, in Briefs' }],
		escalations: [
			{
				when: 'A decision has been waiting for more than two days',
				becomes: 'escalation',
				carriesRecommendation: true
			}
		],
		caps: { maxWordCount: 250, maxDecisionsPerRun: 10 },
		costBand: 'low',
		estimatedTokensPerRun: { min: 5000, max: 12000 },
		tags: ['daily', 'decisions', 'brief'],
		provision: {
			agentTemplateSlug: 'content-marketer',
			agentName: 'Morning briefer',
			skillSlugs: ['digest-compilation'],
			taskTemplate: { name: 'Morning decision brief', slug: 'daily-decision-brief' },
			guardrailsAtAdoption: ASK_BEFORE_EVERYTHING,
			graduatedGuardrails: { mode: 'autonomous', autoApproveActionTypes: ['schedule_task'] }
		}
	},
	{
		slug: 'directory-freshness-sweep',
		title: 'Directory freshness sweep',
		outcome: 'Dead links and stale entries become Tasks, not surprises.',
		summary:
			'Walks the items of a Work once a week, checks each link and how long ago it was updated, and files one Task per problem it finds with the evidence attached. It never edits an item itself.',
		category: 'operations',
		version: '1.0.0',
		icon: 'link',
		trigger: {
			kind: 'schedule',
			cadence: '0 6 * * 3',
			defaultLocalTime: '06:00',
			description: 'Every Wednesday at 06:00, in your workspace timezone'
		},
		steps: steps(
			['Check every link', 'The status of each item’s links.'],
			['Find stale entries', 'Items not updated inside the freshness window.'],
			['File the fixes', 'One Task per problem, with the evidence attached.', true]
		),
		connections: [],
		artefacts: [
			{ kind: 'task', title: 'Fix a stale or broken item', where: 'On the Work’s task board' },
			{ kind: 'run_receipt', title: 'Sweep receipt', where: 'In Runs' }
		],
		escalations: [
			{
				when: 'More than 20 problems are found in one sweep',
				becomes: 'approval',
				carriesRecommendation: true
			}
		],
		caps: { maxPerRun: 20 },
		costBand: 'low',
		estimatedTokensPerRun: { min: 10000, max: 30000 },
		tags: ['links', 'freshness', 'directory'],
		provision: {
			agentTemplateSlug: 'seo-auditor',
			agentName: 'Freshness checker',
			skillSlugs: ['seo-audit'],
			taskTemplate: { name: 'Directory freshness sweep', slug: 'directory-freshness-sweep' },
			guardrailsAtAdoption: ASK_BEFORE_EVERYTHING
		}
	},
	{
		slug: 'knowledge-gap-harvest',
		title: 'Knowledge gap harvest',
		outcome: 'Questions your Knowledge Base could not answer become proposed documents.',
		summary:
			'Collects the week’s questions that got a weak or empty answer from the Knowledge Base, groups them by topic, and drafts a proposed document for each group for you to accept or discard.',
		category: 'content',
		version: '1.0.0',
		icon: 'puzzle',
		trigger: {
			kind: 'schedule',
			cadence: '0 9 * * 5',
			defaultLocalTime: '09:00',
			description: 'Every Friday at 09:00, in your workspace timezone'
		},
		steps: steps(
			['Collect weak answers', 'The questions that found little or nothing.'],
			['Group by topic', 'Clusters of related questions.'],
			['Draft proposals', 'One proposed document per cluster, marked as a draft.', true]
		),
		connections: [],
		artefacts: [{ kind: 'kb_document', title: 'Proposed document', where: 'As drafts, in Proposed' }],
		escalations: [
			{
				when: 'A proposed document is ready to publish',
				becomes: 'approval',
				carriesRecommendation: true
			}
		],
		caps: { maxPerRun: 5, maxWordCount: 800 },
		costBand: 'medium',
		estimatedTokensPerRun: { min: 15000, max: 45000 },
		tags: ['knowledge base', 'gaps', 'weekly'],
		provision: {
			agentTemplateSlug: 'content-marketer',
			agentName: 'Knowledge gardener',
			skillSlugs: ['digest-compilation', 'engagement-analysis'],
			taskTemplate: { name: 'Knowledge gap harvest', slug: 'knowledge-gap-harvest' },
			guardrailsAtAdoption: ASK_BEFORE_EVERYTHING
		}
	},
	{
		slug: 'release-checklist',
		title: 'Release checklist on deploy',
		outcome: 'Every deploy gets the same checklist and a draft of the release notes.',
		summary:
			'Starts when a deploy event arrives, opens a checklist Task with one sub-task per check, and drafts release notes from what merged since the last release. Publishing the notes always waits for you.',
		category: 'operations',
		version: '1.0.0',
		icon: 'checklist',
		trigger: {
			kind: 'inbound_trigger',
			description: 'When a deploy event arrives at the release trigger'
		},
		steps: steps(
			['Open the checklist', 'A parent Task with one sub-task per release check.'],
			['Summarise what merged', 'The changes since the last release.'],
			['Draft release notes', 'A release-notes draft for review.', true]
		),
		connections: [],
		artefacts: [
			{ kind: 'task', title: 'Release checklist', where: 'On the task board' },
			{ kind: 'kb_document', title: 'Release notes draft', where: 'In Releases' }
		],
		escalations: [
			{
				when: 'The release notes are ready to publish',
				becomes: 'approval',
				carriesRecommendation: true
			}
		],
		caps: { maxPerRun: 1 },
		costBand: 'low',
		estimatedTokensPerRun: { min: 6000, max: 14000 },
		tags: ['release', 'deploy', 'checklist'],
		provision: {
			agentTemplateSlug: 'content-marketer',
			agentName: 'Release clerk',
			skillSlugs: ['newsletter-drafting'],
			taskTemplate: { name: 'Release checklist', slug: 'release-checklist' },
			guardrailsAtAdoption: ASK_BEFORE_EVERYTHING
		}
	},
	{
		slug: 'content-refresh-queue',
		title: 'Content refresh queue',
		outcome: 'Your oldest pages, checked against the web, queued for a refresh.',
		summary:
			'Picks the content most overdue for review, searches for what has changed on each topic since it was written, and queues a refresh Task with the new sources attached.',
		category: 'content',
		version: '1.0.0',
		icon: 'refresh',
		trigger: {
			kind: 'schedule',
			cadence: '0 8 * * 2',
			defaultLocalTime: '08:00',
			description: 'Every Tuesday at 08:00, in your workspace timezone'
		},
		steps: steps(
			['Pick overdue content', 'The pages most overdue for review.'],
			['Search for changes', 'New sources on each topic since it was written.'],
			['Queue refreshes', 'One refresh Task per page, with sources attached.', true]
		),
		connections: [
			{
				capability: 'search',
				required: true,
				reason: 'Needed to find what changed on each topic since the page was written.'
			}
		],
		artefacts: [{ kind: 'task', title: 'Refresh a page', where: 'On the Work’s task board' }],
		escalations: [
			{
				when: 'A page looks factually out of date',
				becomes: 'approval',
				carriesRecommendation: true
			}
		],
		caps: { maxPerRun: 5 },
		costBand: 'medium',
		estimatedTokensPerRun: { min: 15000, max: 60000 },
		tags: ['content', 'refresh', 'seo'],
		provision: {
			agentTemplateSlug: 'seo-auditor',
			agentName: 'Content refresher',
			skillSlugs: ['seo-audit', 'news-signal-detection'],
			taskTemplate: { name: 'Content refresh queue', slug: 'content-refresh-queue' },
			guardrailsAtAdoption: ASK_BEFORE_EVERYTHING
		}
	},
	{
		slug: 'market-watch-brief',
		title: 'Market watch brief',
		outcome: 'One living document per source you name — dated entries, links, and what each change may mean.',
		summary:
			'Twice a week it reads each source you track, adds a dated entry for anything that changed with a link to the evidence, and notes what the change might mean for you. A change worth a response opens a decision with a recommendation attached.',
		category: 'research',
		version: '1.0.0',
		icon: 'telescope',
		trigger: {
			kind: 'schedule',
			cadence: '0 8 * * 2,5',
			defaultLocalTime: '08:00',
			description: 'Tuesdays and Fridays at 08:00, in your workspace timezone'
		},
		steps: steps(
			['Read each source', 'What changed on pricing pages, changelogs, blogs and posts.'],
			['Update the document', 'One dated entry per change, every claim with its link.'],
			['Note what it may mean', 'A short paragraph on what the change might mean for you.'],
			['Raise the big ones', 'A decision with a recommendation for a change worth a response.', true]
		),
		connections: [
			{
				capability: 'search',
				required: true,
				reason: 'Needed to find what changed at each source.'
			},
			{
				capability: 'content-extractor',
				required: false,
				reason: 'Reads the full text of a changed page.',
				degradedWithout: 'Entries link out to the page instead of quoting it.'
			}
		],
		artefacts: [
			{ kind: 'kb_document', title: 'Market watch', where: 'One per source, in Research' },
			{ kind: 'run_receipt', title: 'Watch receipt', where: 'In Runs' }
		],
		escalations: [
			{
				when: 'A change looks like it deserves a response',
				becomes: 'approval',
				carriesRecommendation: true
			},
			{
				when: 'Something could not be sourced — it is written in as unconfirmed, never asserted',
				becomes: 'escalation',
				carriesRecommendation: false
			}
		],
		caps: { maxSourcesTracked: 8, maxDecisionsPerRun: 1 },
		costBand: 'medium',
		estimatedTokensPerRun: { min: 15000, max: 60000 },
		tags: ['research', 'market', 'twice weekly'],
		provision: {
			agentTemplateSlug: 'competitive-analyst',
			agentName: 'Market watcher',
			skillSlugs: ['news-signal-detection', 'digest-compilation'],
			taskTemplate: { name: 'Market watch brief', slug: 'market-watch-brief' },
			guardrailsAtAdoption: ASK_BEFORE_EVERYTHING
		}
	},
	{
		slug: 'inbox-triage-drafts',
		title: 'Inbox triage with drafts',
		outcome: 'Everything triaged, replies drafted, nothing sent.',
		summary:
			'Each weekday morning it sorts new mail into needs-you, can-wait and no-reply, and drafts a reply for everything that needs one. Every draft waits for you — sending is never done on its own.',
		category: 'inbox',
		version: '1.0.0',
		icon: 'inbox',
		trigger: {
			kind: 'schedule',
			cadence: '0 7 * * 1-5',
			defaultLocalTime: '07:00',
			description: 'Weekdays at 07:00, in your workspace timezone'
		},
		steps: steps(
			['Sort new mail', 'Needs-you, can-wait and no-reply piles.'],
			['Draft replies', 'A reply draft for each message that needs one.'],
			['Ask before sending', 'One approval per draft; nothing is sent without it.', true]
		),
		connections: [
			{
				capability: 'email-outbound',
				required: true,
				reason: 'Needed to hold reply drafts and send the ones you approve.'
			}
		],
		artefacts: [{ kind: 'email_draft', title: 'Reply draft', where: 'In the agent’s inbox, as drafts' }],
		escalations: [
			{
				when: 'A reply draft is ready to send',
				becomes: 'approval',
				carriesRecommendation: true
			}
		],
		caps: { maxPerRun: 25 },
		costBand: 'medium',
		estimatedTokensPerRun: { min: 20000, max: 55000 },
		tags: ['inbox', 'email', 'drafts'],
		provision: {
			agentTemplateSlug: 'outreach-drafter',
			agentName: 'Inbox triager',
			skillSlugs: ['reply-detection', 'follow-up-cadence'],
			taskTemplate: { name: 'Inbox triage with drafts', slug: 'inbox-triage-drafts' },
			guardrailsAtAdoption: ASK_BEFORE_EVERYTHING,
			graduatedGuardrails: { mode: 'autonomous', autoApproveActionTypes: ['schedule_task'] }
		}
	}
];

function deepFreeze<T>(value: T): T {
	if (value && typeof value === 'object') {
		for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}

/** The eight built-in playbooks, deeply frozen so no caller can mutate the shared catalogue. */
export const BUILTIN_PLAYBOOKS: readonly PlaybookCatalogEntry[] = deepFreeze(ENTRIES);
