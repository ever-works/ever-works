import { describe, expect, it, vi } from 'vitest';
import type { StepExecutionContext, WorkReference } from '@ever-works/plugin';
import { GtmPipelineContext } from '../context.js';
import { ResearchStep } from '../steps/research.step.js';
import { QualifyStep, assessContactRisk, scoreContact } from '../steps/qualify.step.js';
import { DraftStep } from '../steps/draft.step.js';
import { ReviewStep } from '../steps/review.step.js';
import { ActStep } from '../steps/act.step.js';
import { FollowUpStep } from '../steps/follow-up.step.js';
import { MeasureStep } from '../steps/measure.step.js';

const WORK: WorkReference = { id: 'work-1', name: 'Campaign', slug: 'campaign' };

function makeExecContext(overrides: Partial<Record<string, unknown>> = {}): StepExecutionContext {
	return {
		aiFacade: { askJson: vi.fn() },
		searchFacade: { search: vi.fn().mockResolvedValue([]) },
		screenshotFacade: {},
		contentExtractorFacade: {},
		logger: { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
		work: WORK,
		user: { id: 'user-1' },
		...overrides
	} as unknown as StepExecutionContext;
}

function contextWith(config: Record<string, unknown> = {}, prompt = ''): GtmPipelineContext {
	return new GtmPipelineContext(WORK, { prompt, config });
}

describe('research stage', () => {
	it('normalizes and dedupes seed contacts and never fabricates people', async () => {
		const step = new ResearchStep();
		const ctx = contextWith({
			contacts: [
				{ name: ' Ada Lovelace ', email: 'ada@acme.io', company: 'Acme' },
				{ name: 'Ada Lovelace', email: 'ada@acme.io' }, // duplicate by email
				{ email: 'no-name@acme.io' }, // kept — email present
				{ notes: 'nameless and emailless' }, // dropped
				'not-an-object'
			]
		});
		const result = (await step.run(ctx, makeExecContext())) as GtmPipelineContext;
		expect(result.contacts).toHaveLength(2);
		expect(result.contacts[0]).toMatchObject({ name: 'Ada Lovelace', email: 'ada@acme.io', company: 'Acme' });
		expect(result.contacts[1].name).toBe('no-name@acme.io');
	});

	it('collects signals via AI-planned queries and degrades with a warning on AI failure', async () => {
		const step = new ResearchStep();
		const okContext = makeExecContext({
			aiFacade: {
				askJson: vi.fn().mockResolvedValue({
					result: { queries: ['launch news acme', ''] },
					usage: null,
					cost: null,
					provider: 'p',
					model: 'm'
				})
			},
			searchFacade: {
				search: vi
					.fn()
					.mockResolvedValue([{ title: 'Acme ships v2', url: 'https://news.example.com/acme-v2', score: 1 }])
			}
		});
		const ctx = contextWith({}, 'Announce our launch to devtools founders');
		const result = (await step.run(ctx, okContext)) as GtmPipelineContext;
		expect(result.signals).toHaveLength(1);
		expect(result.signals[0]).toMatchObject({ query: 'launch news acme', url: 'https://news.example.com/acme-v2' });

		const failing = makeExecContext({
			aiFacade: { askJson: vi.fn().mockRejectedValue(new Error('provider down')) }
		});
		const degraded = (await step.run(contextWith({}, 'brief'), failing)) as GtmPipelineContext;
		expect(degraded.signals).toEqual([]);
		expect(degraded.warnings.some((w) => w.includes('signal collection degraded'))).toBe(true);
	});
});

describe('qualify stage', () => {
	it('scores with the declarative weight table and explains every rule fired', () => {
		const full = scoreContact({
			name: 'Ada',
			email: 'ada@acme.io',
			company: 'Acme',
			title: 'CTO',
			source: 'referral',
			notes: 'met at conf'
		});
		expect(full.score).toBe(100);
		expect(full.reasons).toEqual(
			expect.arrayContaining(['has-email +25', 'has-company +15', 'has-title +15', 'has-notes +10'])
		);
		const bare = scoreContact({ name: 'Mystery' });
		expect(bare.score).toBe(30);

		const risk = assessContactRisk({ name: 'Mailbox', email: 'info@gmail.com' });
		expect(risk.riskScore).toBeGreaterThanOrEqual(3);
		expect(risk.reasons.join(' ')).toContain('non-personal-mailbox');
	});

	it('keeps qualified contacts sorted by score and excludes risky/low-score ones', async () => {
		const step = new QualifyStep();
		const ctx = contextWith({ qualify_min_score: 50, risk_exclude_threshold: 5 });
		ctx.contacts = [
			{ name: 'Solid', email: 'cto@acme.io', company: 'Acme', title: 'CTO' },
			{ name: 'Bare' }, // low score + high risk → excluded
			{ name: 'Mid', email: 'mid@corp.io', company: 'Corp' }
		];
		const result = (await step.run(ctx, makeExecContext())) as GtmPipelineContext;
		expect(result.scoredContacts.map((c) => c.name)).toEqual(['Solid', 'Mid']);
		expect(result.scoredContacts[0].score).toBeGreaterThanOrEqual(result.scoredContacts[1].score);
		expect(result.excludedContacts.map((c) => c.name)).toEqual(['Bare']);
		expect(result.warnings.some((w) => w.startsWith('Qualify: excluded 1'))).toBe(true);
	});
});

describe('draft stage', () => {
	it('drafts through the AI facade with tone + channels and drops unknown contact/channel refs', async () => {
		const step = new DraftStep();
		const askJson = vi.fn().mockResolvedValue({
			result: {
				drafts: [
					{ contactName: 'Ada', channel: 'email', subject: 'Hello Ada', body: 'A personalized note.' },
					{ contactName: 'Nobody', channel: 'email', subject: 'x', body: 'y' }, // unknown contact
					{ contactName: 'Ada', channel: 'fax', subject: 'x', body: 'y' } // unknown channel
				]
			},
			usage: null,
			cost: null,
			provider: 'p',
			model: 'm'
		});
		const execContext = makeExecContext({ aiFacade: { askJson } });
		const ctx = contextWith({ target_channels: ['email'], tone: 'friendly' }, 'Launch brief');
		ctx.scoredContacts = [
			{
				name: 'Ada',
				email: 'ada@acme.io',
				company: 'Acme',
				score: 90,
				scoreReasons: [],
				riskScore: 0,
				riskReasons: []
			}
		];
		const result = (await step.run(ctx, execContext)) as GtmPipelineContext;
		expect(result.drafts).toHaveLength(1);
		expect(result.drafts[0]).toMatchObject({ ref: 'draft-1', contactName: 'Ada', channel: 'email' });
		const options = askJson.mock.calls[0][2];
		expect(options.variables.tone).toBe('friendly');
		expect(options.variables.channels).toBe('email');
		expect(result.warnings.filter((w) => w.startsWith('Draft: dropped'))).toHaveLength(2);
	});

	it('caps drafted contacts at max_contacts_per_run and degrades on AI failure', async () => {
		const step = new DraftStep();
		const askJson = vi.fn().mockRejectedValue(new Error('quota'));
		const execContext = makeExecContext({ aiFacade: { askJson } });
		const ctx = contextWith({ max_contacts_per_run: 1 });
		ctx.scoredContacts = [
			{ name: 'A', score: 90, scoreReasons: [], riskScore: 0, riskReasons: [] },
			{ name: 'B', score: 80, scoreReasons: [], riskScore: 0, riskReasons: [] }
		];
		const result = (await step.run(ctx, execContext)) as GtmPipelineContext;
		expect(result.drafts).toEqual([]);
		expect(result.warnings.some((w) => w.startsWith('Draft: generation failed'))).toBe(true);
		const contactsVar: string = askJson.mock.calls[0][2].variables.contacts;
		expect(contactsVar).toContain('name: A');
		expect(contactsVar).not.toContain('name: B');
	});
});

describe('review stage — the human gate', () => {
	const drafts = [
		{ ref: 'draft-1', contactName: 'Ada', channel: 'email', subject: null, body: 'one' },
		{ ref: 'draft-2', contactName: 'Grace', channel: 'email', subject: null, body: 'two' }
	];

	it('pauses the run awaiting approval when review is required and none was supplied', async () => {
		const step = new ReviewStep();
		const ctx = contextWith({});
		ctx.drafts = [...drafts];
		const result = (await step.run(ctx, makeExecContext())) as GtmPipelineContext;
		expect(result.pendingReview).toBe(true);
		expect(result.shouldStop).toBe(true);
		expect(result.approvedDrafts).toEqual([]);
		expect(result.warnings.some((w) => w.includes('awaiting human approval for 2'))).toBe(true);
	});

	it('approves the supplied subset and ignores unknown refs with a warning', async () => {
		const step = new ReviewStep();
		const ctx = contextWith({ approved_draft_refs: ['draft-2', 'draft-999'] });
		ctx.drafts = [...drafts];
		const result = (await step.run(ctx, makeExecContext())) as GtmPipelineContext;
		expect(result.pendingReview).toBe(false);
		expect(result.approvedDrafts.map((d) => d.ref)).toEqual(['draft-2']);
		expect(result.warnings.some((w) => w.includes('unknown draft ref "draft-999"'))).toBe(true);
	});

	it("approves everything for 'all', and records an explicit warning when review is disabled", async () => {
		const step = new ReviewStep();
		const allCtx = contextWith({ approved_draft_refs: 'all' });
		allCtx.drafts = [...drafts];
		const approvedAll = (await step.run(allCtx, makeExecContext())) as GtmPipelineContext;
		expect(approvedAll.approvedDrafts).toHaveLength(2);
		expect(approvedAll.shouldStop).toBeUndefined();

		const disabledCtx = contextWith({ review_required: false });
		disabledCtx.drafts = [...drafts];
		const autoApproved = (await step.run(disabledCtx, makeExecContext())) as GtmPipelineContext;
		expect(autoApproved.approvedDrafts).toHaveLength(2);
		expect(autoApproved.warnings.some((w) => w.includes('auto-approved 2'))).toBe(true);
	});
});

describe('act + follow-up + measure stages', () => {
	it('act prepares only approved drafts and never marks anything sent', async () => {
		const step = new ActStep();
		const ctx = contextWith({});
		ctx.drafts = [
			{ ref: 'draft-1', contactName: 'Ada', channel: 'email', subject: null, body: 'one' },
			{ ref: 'draft-2', contactName: 'Grace', channel: 'social', subject: null, body: 'two' }
		];
		ctx.approvedDrafts = [ctx.drafts[0]];
		const result = (await step.run(ctx, makeExecContext())) as GtmPipelineContext;
		expect(result.actionLog).toHaveLength(2);
		expect(result.actionLog[0]).toMatchObject({ draftRef: 'draft-1', status: 'prepared' });
		expect(result.actionLog[1]).toMatchObject({ draftRef: 'draft-2', status: 'skipped' });
		expect(result.actionLog.every((record) => record.status !== ('sent' as string))).toBe(true);
	});

	it('follow-up queues prepared actions with the configured quiet-days window', async () => {
		const step = new FollowUpStep();
		const ctx = contextWith({ follow_up_quiet_days: 6, cadence: 'weekly' });
		ctx.actionLog = [
			{ draftRef: 'draft-1', channel: 'email', status: 'prepared', reason: null, preparedAt: 1 },
			{ draftRef: 'draft-2', channel: 'email', status: 'skipped', reason: 'not approved', preparedAt: 1 }
		];
		const result = (await step.run(ctx, makeExecContext())) as GtmPipelineContext;
		expect(result.followUpQueue).toHaveLength(1);
		expect(result.followUpQueue[0]).toMatchObject({ draftRef: 'draft-1', dueAfterDays: 6 });
	});

	it('measure compiles deterministic totals and survives AI narrative failure', async () => {
		const step = new MeasureStep();
		const execContext = makeExecContext({
			aiFacade: { askJson: vi.fn().mockRejectedValue(new Error('down')) }
		});
		const ctx = contextWith({});
		ctx.contacts = [{ name: 'Ada' }, { name: 'Grace' }];
		ctx.scoredContacts = [{ name: 'Ada', score: 90, scoreReasons: [], riskScore: 0, riskReasons: [] }];
		ctx.drafts = [{ ref: 'draft-1', contactName: 'Ada', channel: 'email', subject: null, body: 'x' }];
		ctx.approvedDrafts = [...ctx.drafts];
		ctx.actionLog = [{ draftRef: 'draft-1', channel: 'email', status: 'prepared', reason: null, preparedAt: 1 }];
		ctx.followUpQueue = [{ draftRef: 'draft-1', channel: 'email', dueAfterDays: 4, rationale: 'quiet' }];
		const result = (await step.run(ctx, execContext)) as GtmPipelineContext;
		expect(result.report).not.toBeNull();
		expect(result.report?.totals).toEqual({
			contacts: 2,
			qualified: 1,
			excluded: 0,
			drafts: 1,
			approved: 1,
			prepared: 1,
			followUpsQueued: 1
		});
		expect(result.report?.summary).toContain('Prepared 1 of 1');
		expect(result.warnings.some((w) => w.startsWith('Measure: narrative degraded'))).toBe(true);
	});
});
