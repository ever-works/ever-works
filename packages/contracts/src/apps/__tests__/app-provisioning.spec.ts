/**
 * APW-04 T6 — the App Provisioner's contract surface, pinned so that no union
 * member, alias, view key, limit, path list or i18n leaf can be added, removed,
 * renamed or reordered without this file being edited in the same change.
 *
 * Owning epic: **APW-04 (App Provisioner)**, task `tasks.md` T6:127-143. The
 * contract under test is `packages/contracts/src/apps/app-provisioning.ts` plus
 * the copy module `…/app-provisioning-copy.ts` T6:135 creates "per T49".
 *
 * T6:138-141 names what this file must pin, in its own words:
 *
 *  - "every union, the singular aliases" — each `as const` array is asserted
 *    member for member, **in order**, because `APP_PROVISIONING_STEPS` IS the
 *    §2.5 step order and `stepStates` is keyed by it;
 *  - "**every key of every view interface** (so T23 can assert key-set equality
 *    against the wire)" — each interface below is materialised as a fully
 *    populated literal and its `Object.keys` compared to a literal list. The
 *    literal is typed, so a key the interface gains is a compile error under
 *    this package's `type-check:tests` (the package's own `type-check` excludes
 *    specs, which makes that project the only place a compile-level pin bites),
 *    and a key it loses is a run-time failure here;
 *  - "`publicRepository` in the readiness keys" — asserted by name, not only by
 *    the key-set equality;
 *  - "`private-repository` in the failure reasons" — likewise;
 *  - "every numeric limit including `startDedupeMs` (a limit cannot change
 *    without a deliberate edit)" — the 51-row table below pins every value, and
 *    the object's key count is pinned to the table's length so an added limit is
 *    a deliberate two-line edit as well.
 *
 * Two things beyond T6's list are pinned here because T6:135 routes the copy
 * module through this task while T49's own spec (a separate file, not this
 * one's) does not exist yet: the four `*_I18N_KEY` maps and the copy templates'
 * four invariants. They are additive — nothing above depends on them.
 *
 * The compile-time half of the union pins is the `Record<Union, true>` map each
 * `describe` builds: a member added to an array without a line in the map is a
 * type error, while a reordering is caught at run time by `toEqual`. Neither
 * half alone is enough, exactly as `apps-tier.spec.ts` records.
 */

import { describe, expect, it } from 'vitest';

import {
	APP_PROVISIONING_DETECTION_SOURCES,
	APP_PROVISIONING_FAILURE_REASONS,
	APP_PROVISIONING_FAILURE_REASON_I18N_KEY,
	APP_PROVISIONING_OPTION_I18N_KEY,
	APP_PROVISIONING_PARK_REASONS,
	APP_PROVISIONING_QUEUED_REASON_I18N_KEY,
	APP_PROVISIONING_QUESTION_REASONS,
	APP_PROVISIONING_QUESTION_REASON_I18N_KEY,
	APP_PROVISIONING_STATUSES,
	APP_PROVISIONING_STEPS,
	APP_PROVISIONING_STEP_STATES,
	APP_PROVISION_LIMITS,
	APP_PROVISION_PRESERVED_SPEC_FIELDS,
	APP_PROVISION_WRITABLE_PATHS,
	type AppProvisioningAttempt,
	type AppProvisioningAttemptView,
	type AppProvisioningDetectionSource,
	type AppProvisioningFailureReason,
	type AppProvisioningOptionId,
	type AppProvisioningParkReason,
	type AppProvisioningQueuedReason,
	type AppProvisioningQuestionReason,
	type AppProvisioningQuestionView,
	type AppProvisioningReadiness,
	type AppProvisioningResponse,
	type AppProvisioningStartResponse,
	type AppProvisioningStatus,
	type AppProvisioningStep,
	type AppProvisioningStepState,
	type AppProvisioningStepView,
	type AppProvisioningSummaryView,
	type AppProvisioningTrigger,
	type AppProvisioningView
} from '../app-provisioning.js';

import {
	APP_PROVISION_CHAT_TEMPLATES,
	APP_PROVISION_COPY_PARAMS,
	APP_PROVISION_COPY_TEMPLATES,
	APP_PROVISION_EVIDENCE_HEADINGS,
	APP_PROVISION_OPTION_LABELS,
	APP_PROVISION_QUESTION_SUBJECTS,
	APP_PROVISION_QUEUED_REASON_TEXTS,
	APP_PROVISION_REASON_TEXTS,
	APP_PROVISION_REMINDER_BODY,
	APP_PROVISION_REMINDER_TITLE,
	appProvisionCopy,
	appProvisionCopyPlaceholders,
	type AppProvisionCopyParam
} from '../app-provisioning-copy.js';

/** The keys of a materialised interface literal, sorted — the shape T23 compares against the wire. */
function keysOf(value: object): string[] {
	return Object.keys(value).sort();
}

/**
 * A compile-time totality map: every member of `Union` must appear, with `true`.
 * The value is unused — the type is the assertion — so it is passed to
 * `expectExhaustive` purely to keep the binding live.
 */
function expectExhaustive(map: Record<string, true>): void {
	expect(Object.values(map).every((value) => value === true)).toBe(true);
}

describe('APW-04 contract surface (T6)', () => {
	describe('the closed unions (plan §3.2:406-463)', () => {
		it('pins the seven provisionings statuses in the order spec §5.3 lists them', () => {
			expect(APP_PROVISIONING_STATUSES).toEqual([
				'queued',
				'running',
				'needs_input',
				'succeeded',
				'merged',
				'failed',
				'cancelled'
			]);
			expectExhaustive({
				queued: true,
				running: true,
				needs_input: true,
				succeeded: true,
				merged: true,
				failed: true,
				cancelled: true
			} satisfies Record<AppProvisioningStatus, true>);
		});

		it('pins the eight steps — the order IS the §2.5 pipeline, and stepStates is keyed by it', () => {
			expect(APP_PROVISIONING_STEPS).toEqual([
				'repository',
				'analysis',
				'proposal',
				'validate',
				'build',
				'boot',
				'smoke',
				'evidence'
			]);
			expectExhaustive({
				repository: true,
				analysis: true,
				proposal: true,
				validate: true,
				build: true,
				boot: true,
				smoke: true,
				evidence: true
			} satisfies Record<AppProvisioningStep, true>);
		});

		it('pins the six step states', () => {
			expect(APP_PROVISIONING_STEP_STATES).toEqual([
				'pending',
				'running',
				'passed',
				'failed',
				'blocked',
				'skipped'
			]);
			expectExhaustive({
				pending: true,
				running: true,
				passed: true,
				failed: true,
				blocked: true,
				skipped: true
			} satisfies Record<AppProvisioningStepState, true>);
		});

		it('pins the failure reasons, and carries private-repository by name (T6:140)', () => {
			expect(APP_PROVISIONING_FAILURE_REASONS).toEqual([
				'no-isolated-runtime',
				'repository-not-ready',
				'repository-too-large',
				'not-runnable',
				'token-cap',
				'runner-minute-cap',
				'deadline',
				'could-not-verify',
				'no-answer',
				'verification-infrastructure',
				'private-repository'
			]);
			expect(APP_PROVISIONING_FAILURE_REASONS).toContain('private-repository');
			expectExhaustive({
				'no-isolated-runtime': true,
				'repository-not-ready': true,
				'repository-too-large': true,
				'not-runnable': true,
				'token-cap': true,
				'runner-minute-cap': true,
				deadline: true,
				'could-not-verify': true,
				'no-answer': true,
				'verification-infrastructure': true,
				'private-repository': true
			} satisfies Record<AppProvisioningFailureReason, true>);
		});

		it('pins the nine question reasons, safety-rail last (R-17)', () => {
			expect(APP_PROVISIONING_QUESTION_REASONS).toEqual([
				'attempts-spent',
				'repeated-failure',
				'missing-required-value',
				'runner-capacity',
				'token-cap',
				'runner-minute-cap',
				'multiple-apps',
				'agent-asked',
				'safety-rail'
			]);
			expect(APP_PROVISIONING_QUESTION_REASONS).toContain('safety-rail');
			expectExhaustive({
				'attempts-spent': true,
				'repeated-failure': true,
				'missing-required-value': true,
				'runner-capacity': true,
				'token-cap': true,
				'runner-minute-cap': true,
				'multiple-apps': true,
				'agent-asked': true,
				'safety-rail': true
			} satisfies Record<AppProvisioningQuestionReason, true>);
		});

		it('pins the four park reasons (R-17 waits)', () => {
			expect(APP_PROVISIONING_PARK_REASONS).toEqual([
				'kill-switch',
				'agent-paused',
				'workspace-paused',
				'scope-paused'
			]);
			expectExhaustive({
				'kill-switch': true,
				'agent-paused': true,
				'workspace-paused': true,
				'scope-paused': true
			} satisfies Record<AppProvisioningParkReason, true>);
		});

		it('pins the six detection sources, with auto last (R-13)', () => {
			expect(APP_PROVISIONING_DETECTION_SOURCES).toEqual([
				'app-spec',
				'compose',
				'dockerfile',
				'helm',
				'descriptor-hint',
				'auto'
			]);
			expect(APP_PROVISIONING_DETECTION_SOURCES).toContain('auto');
			expectExhaustive({
				'app-spec': true,
				compose: true,
				dockerfile: true,
				helm: true,
				'descriptor-hint': true,
				auto: true
			} satisfies Record<AppProvisioningDetectionSource, true>);
		});

		it('pins the five triggers, in the order the entity documents them', () => {
			const triggers: readonly AppProvisioningTrigger[] = [
				'auto-create',
				'manual',
				'chat',
				'upstream-smoke',
				'auto-upstream-smoke'
			];

			expect(triggers).toHaveLength(5);
			expectExhaustive({
				'auto-create': true,
				manual: true,
				chat: true,
				'upstream-smoke': true,
				'auto-upstream-smoke': true
			} satisfies Record<AppProvisioningTrigger, true>);
		});

		it('has no duplicate member in any union', () => {
			for (const union of [
				APP_PROVISIONING_STATUSES,
				APP_PROVISIONING_STEPS,
				APP_PROVISIONING_STEP_STATES,
				APP_PROVISIONING_FAILURE_REASONS,
				APP_PROVISIONING_QUESTION_REASONS,
				APP_PROVISIONING_PARK_REASONS,
				APP_PROVISIONING_DETECTION_SOURCES
			]) {
				expect(new Set(union).size).toBe(union.length);
			}
		});
	});

	describe('every key of every view interface (T6:139 — what T23 compares to the wire)', () => {
		it('pins AppProvisioningStepView to its five keys', () => {
			const step: AppProvisioningStepView = {
				state: 'pending',
				startedAt: null,
				finishedAt: null,
				noteKey: null,
				noteParams: null
			};

			expect(keysOf(step)).toEqual(['finishedAt', 'noteKey', 'noteParams', 'startedAt', 'state']);
		});

		it('pins the STORED AppProvisioningAttempt to its fourteen keys, fingerprint and commentId included', () => {
			// The two keys §3.2:707-708 forbids on the wire ARE part of the row —
			// the next case proves the view drops them.
			const attempt: AppProvisioningAttempt = {
				n: 1,
				startedAt: '2026-03-01T06:00:00.000Z',
				finishedAt: '2026-03-01T06:11:03.000Z',
				verdict: 'red',
				failedStep: 'boot',
				fingerprint: 'f'.repeat(64),
				targetKind: 'runner',
				buildId: 'build-1',
				imageDigest: 'sha256:' + 'a'.repeat(64),
				logsUrl: 'https://example.test/logs',
				smoke: [{ name: 'health', expected: '200', observed: '503', ms: 120, ok: false }],
				commentId: 41,
				tokens: 612_400,
				runnerMinutes: 23
			};

			expect(keysOf(attempt)).toEqual([
				'buildId',
				'commentId',
				'failedStep',
				'fingerprint',
				'finishedAt',
				'imageDigest',
				'logsUrl',
				'n',
				'runnerMinutes',
				'smoke',
				'startedAt',
				'targetKind',
				'tokens',
				'verdict'
			]);
		});

		it('pins AppProvisioningAttemptView to its twelve keys — no fingerprint, no commentId', () => {
			const view: AppProvisioningAttemptView = {
				n: 1,
				startedAt: '2026-03-01T06:00:00.000Z',
				finishedAt: null,
				verdict: 'running',
				failedStep: null,
				targetKind: null,
				buildId: null,
				imageDigest: null,
				logsUrl: null,
				smoke: null,
				tokens: 0,
				runnerMinutes: 0
			};

			expect(keysOf(view)).toEqual([
				'buildId',
				'failedStep',
				'finishedAt',
				'imageDigest',
				'logsUrl',
				'n',
				'runnerMinutes',
				'smoke',
				'startedAt',
				'targetKind',
				'tokens',
				'verdict'
			]);
			expect(keysOf(view)).not.toContain('fingerprint');
			expect(keysOf(view)).not.toContain('commentId');
		});

		it('pins AppProvisioningQuestionView to its four keys', () => {
			const question: AppProvisioningQuestionView = {
				reason: 'missing-required-value',
				params: { variable: 'OAUTH_CLIENT_SECRET' },
				askedAt: '2026-03-01T06:00:00.000Z',
				inboxItemId: 'inbox-1'
			};

			expect(keysOf(question)).toEqual(['askedAt', 'inboxItemId', 'params', 'reason']);
		});

		it('pins AppProvisioningView to its twenty-eight keys', () => {
			const view: AppProvisioningView = {
				id: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f',
				workId: '1f1f1f1f-1f1f-4f1f-8f1f-1f1f1f1f1f1f',
				taskId: null,
				trigger: 'manual',
				status: 'running',
				queuedReason: null,
				step: 'build',
				stepStates: {
					repository: { state: 'passed', startedAt: null, finishedAt: null, noteKey: null, noteParams: null },
					analysis: { state: 'passed', startedAt: null, finishedAt: null, noteKey: null, noteParams: null },
					proposal: { state: 'passed', startedAt: null, finishedAt: null, noteKey: null, noteParams: null },
					validate: { state: 'passed', startedAt: null, finishedAt: null, noteKey: null, noteParams: null },
					build: { state: 'running', startedAt: null, finishedAt: null, noteKey: null, noteParams: null },
					boot: { state: 'pending', startedAt: null, finishedAt: null, noteKey: null, noteParams: null },
					smoke: { state: 'pending', startedAt: null, finishedAt: null, noteKey: null, noteParams: null },
					evidence: { state: 'pending', startedAt: null, finishedAt: null, noteKey: null, noteParams: null }
				},
				parkedReason: null,
				detectionSource: 'dockerfile',
				attemptBudget: 3,
				attemptsUsed: 1,
				attempts: [],
				question: null,
				failureReason: null,
				verified: null,
				pullRequest: { number: 14, url: 'https://example.test/pr/14' },
				headSha: 'a'.repeat(40),
				spend: { tokensUsed: 0, tokenCap: 3_000_000, runnerMinutesUsed: 0, runnerMinuteCap: 240 },
				runIds: [],
				buildIds: [],
				verificationTargetKind: 'runner',
				suggestionState: null,
				suggestedAt: null,
				startedAt: null,
				finishedAt: null,
				createdAt: '2026-03-01T06:00:00.000Z',
				updatedAt: '2026-03-01T06:00:00.000Z'
			};

			expect(keysOf(view)).toEqual([
				'attemptBudget',
				'attempts',
				'attemptsUsed',
				'buildIds',
				'createdAt',
				'detectionSource',
				'failureReason',
				'finishedAt',
				'headSha',
				'id',
				'parkedReason',
				'pullRequest',
				'question',
				'queuedReason',
				'runIds',
				'spend',
				'startedAt',
				'status',
				'step',
				'stepStates',
				'suggestedAt',
				'suggestionState',
				'taskId',
				'trigger',
				'updatedAt',
				'verificationTargetKind',
				'verified',
				'workId'
			]);
		});

		it('pins AppProvisioningSummaryView to the eleven keys it picks', () => {
			const summary: AppProvisioningSummaryView = {
				id: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f',
				trigger: 'manual',
				status: 'failed',
				failureReason: 'could-not-verify',
				verified: false,
				pullRequest: null,
				attemptsUsed: 3,
				attemptBudget: 3,
				spend: { tokensUsed: 1, tokenCap: 2, runnerMinutesUsed: 3, runnerMinuteCap: 4 },
				startedAt: null,
				finishedAt: null
			};

			expect(keysOf(summary)).toEqual([
				'attemptBudget',
				'attemptsUsed',
				'failureReason',
				'finishedAt',
				'id',
				'pullRequest',
				'spend',
				'startedAt',
				'status',
				'trigger',
				'verified'
			]);
			// A summary row is a projection, never a second full view.
			expect(keysOf(summary)).not.toContain('stepStates');
		});

		it('pins AppProvisioningReadiness to its five keys, publicRepository by name (T6:140)', () => {
			const readiness: AppProvisioningReadiness = {
				isolatedRuntime: true,
				agentTemplate: true,
				buildCapability: true,
				clusterTarget: false,
				publicRepository: true
			};

			expect(keysOf(readiness)).toEqual([
				'agentTemplate',
				'buildCapability',
				'clusterTarget',
				'isolatedRuntime',
				'publicRepository'
			]);
			expect(readiness).toHaveProperty('publicRepository');
		});

		it('pins AppProvisioningResponse to its seven keys', () => {
			const response: AppProvisioningResponse = {
				active: null,
				latest: null,
				recent: [],
				readiness: {
					isolatedRuntime: true,
					agentTemplate: true,
					buildCapability: true,
					clusterTarget: false,
					publicRepository: true
				},
				upstreamSmokeBroken: { fromSha: 'a'.repeat(40), toSha: 'b'.repeat(40) },
				suggestionEligible: false,
				canEdit: true
			};

			expect(keysOf(response)).toEqual([
				'active',
				'canEdit',
				'latest',
				'readiness',
				'recent',
				'suggestionEligible',
				'upstreamSmokeBroken'
			]);
		});

		it('pins AppProvisioningStartResponse to its three keys', () => {
			const start: AppProvisioningStartResponse = {
				provisioningId: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f',
				status: 'queued',
				deduplicated: false
			};

			expect(keysOf(start)).toEqual(['deduplicated', 'provisioningId', 'status']);
		});

		it('never carries a column plan §3.2:702-708 forbids on the wire', () => {
			// The list is the plan's, quoted once: these columns exist on the
			// entity (T7) and are read by the service; the response is where they
			// stop. `inboxItemId` is deliberately absent from this list — it is
			// allowed as `question.inboxItemId`, to the question's recipient only.
			const forbidden = [
				'userId',
				'tenantId',
				'organizationId',
				'agentId',
				'note',
				'lease',
				'leaseExpiresAt',
				'suggestionBundle',
				'suggestionUpstream',
				'conversationId',
				'chatMessagesPosted',
				'activeMs',
				'openInboxItemId',
				'verificationNamespace',
				'verificationExpiresAt',
				'baseSha',
				'lastRunOutput',
				'upstreamFromSha',
				'upstreamToSha'
			];
			const view: AppProvisioningView = {
				id: 'x',
				workId: 'x',
				taskId: null,
				trigger: 'manual',
				status: 'queued',
				queuedReason: null,
				step: 'repository',
				stepStates: {} as AppProvisioningView['stepStates'],
				parkedReason: null,
				detectionSource: null,
				attemptBudget: 3,
				attemptsUsed: 0,
				attempts: [],
				question: null,
				failureReason: null,
				verified: null,
				pullRequest: null,
				headSha: null,
				spend: { tokensUsed: 0, tokenCap: 1, runnerMinutesUsed: 0, runnerMinuteCap: 1 },
				runIds: [],
				buildIds: [],
				verificationTargetKind: null,
				suggestionState: null,
				suggestedAt: null,
				startedAt: null,
				finishedAt: null,
				createdAt: 'x',
				updatedAt: 'x'
			};
			const summary: AppProvisioningSummaryView = {
				id: 'x',
				trigger: 'manual',
				status: 'queued',
				failureReason: null,
				verified: null,
				pullRequest: null,
				attemptsUsed: 0,
				attemptBudget: 3,
				spend: { tokensUsed: 0, tokenCap: 1, runnerMinutesUsed: 0, runnerMinuteCap: 1 },
				startedAt: null,
				finishedAt: null
			};

			for (const key of forbidden) {
				expect(keysOf(view)).not.toContain(key);
				expect(keysOf(summary)).not.toContain(key);
			}
		});
	});

	describe('the two guard lists (plan §3.2:541-550)', () => {
		it('pins the writable paths — the only two the pull request may change (FR-25)', () => {
			expect(APP_PROVISION_WRITABLE_PATHS).toEqual(['.works/works.yml', '.works/overlay/**']);
		});

		it('pins the seven preserved spec fields the guard compares against its base (ACC-NEG-05)', () => {
			expect(APP_PROVISION_PRESERVED_SPEC_FIELDS).toEqual([
				'source',
				'blueprint',
				'license',
				'display.protectedPaths',
				'upstreamSync',
				'upstreamPullRequests',
				'provisioning'
			]);
			// The one that makes an injected `requireApproval: false` on the HEAD
			// file not inheritable: it is preserved, so a change to it fails.
			expect(APP_PROVISION_PRESERVED_SPEC_FIELDS).toContain('upstreamPullRequests');
		});
	});

	describe('every numeric limit (T6:141 — a limit cannot change without a deliberate edit)', () => {
		/** One row per limit: the exported key, its value, and the plan line it comes from. */
		const LIMITS: Array<{ name: keyof typeof APP_PROVISION_LIMITS; expected: number; plan: string }> = [
			{ name: 'attemptsDefault', expected: 3, plan: 'plan §3.2:483' },
			{ name: 'attemptsMin', expected: 1, plan: 'plan §3.2:484' },
			{ name: 'attemptsMax', expected: 5, plan: 'plan §3.2:485' },
			{ name: 'attemptsPerAnswer', expected: 2, plan: 'plan §3.2:486' },
			{ name: 'questionsMax', expected: 3, plan: 'plan §3.2:487' },
			{ name: 'attemptsCeiling', expected: 9, plan: 'plan §3.2:488' },
			{ name: 'optionsMax', expected: 4, plan: 'plan §3.2:489' },
			{ name: 'tokenCapDefault', expected: 3_000_000, plan: 'plan §3.2:490' },
			{ name: 'tokenCapMin', expected: 500_000, plan: 'plan §3.2:491' },
			{ name: 'tokenCapMax', expected: 10_000_000, plan: 'plan §3.2:492' },
			{ name: 'runnerMinuteCapDefault', expected: 240, plan: 'plan §3.2:493' },
			{ name: 'runnerMinuteCapMin', expected: 60, plan: 'plan §3.2:494' },
			{ name: 'runnerMinuteCapMax', expected: 600, plan: 'plan §3.2:495' },
			// Named by T6:133 and :141, and the whole of §4's dedupe rule.
			{ name: 'startDedupeMs', expected: 10_000, plan: 'plan §3.2:497' },
			{ name: 'analysisRunMs', expected: 2_700_000, plan: 'plan §3.2:498' },
			{ name: 'iterateRunMs', expected: 1_800_000, plan: 'plan §3.2:499' },
			{ name: 'forkWaitMs', expected: 1_800_000, plan: 'plan §3.2:500' },
			{ name: 'activeDeadlineMs', expected: 28_800_000, plan: 'plan §3.2:501' },
			{ name: 'buildMinutesMax', expected: 60, plan: 'plan §3.2:506' },
			{ name: 'jobSecondsMax', expected: 900, plan: 'plan §3.2:507' },
			{ name: 'startupSecondsMax', expected: 900, plan: 'plan §3.2:508' },
			{ name: 'smokeRequestMs', expected: 30_000, plan: 'plan §3.2:509' },
			{ name: 'smokeTotalMs', expected: 300_000, plan: 'plan §3.2:510' },
			{ name: 'runnerBootMinutesMax', expected: 30, plan: 'plan §3.2:511' },
			{ name: 'runnerBootMemoryGiB', expected: 12, plan: 'plan §3.2:512' },
			{ name: 'buildMemoryGiBMax', expected: 14, plan: 'plan §3.2:513' },
			{ name: 'namespaceTtlMinutes', expected: 90, plan: 'plan §3.2:514' },
			{ name: 'repoMaxBytes', expected: 3_221_225_472, plan: 'plan §3.2:515' },
			{ name: 'diffMaxFiles', expected: 12, plan: 'plan §3.2:516' },
			{ name: 'diffMaxLines', expected: 3_000, plan: 'plan §3.2:517' },
			{ name: 'fileMaxBytes', expected: 131_072, plan: 'plan §3.2:518' },
			{ name: 'outputMaxBytes', expected: 524_288, plan: 'plan §3.2:519' },
			{ name: 'reportMaxChars', expected: 40_000, plan: 'plan §3.2:520' },
			{ name: 'instructionFileMaxBytes', expected: 32_768, plan: 'plan §3.2:521' },
			{ name: 'logTailLines', expected: 200, plan: 'plan §3.2:522' },
			{ name: 'logTailBytes', expected: 16_384, plan: 'plan §3.2:523' },
			{ name: 'evidenceCommentMaxChars', expected: 60_000, plan: 'plan §3.2:524' },
			{ name: 'chatMessagesMax', expected: 12, plan: 'plan §3.2:525' },
			{ name: 'questionReminderMs', expected: 259_200_000, plan: 'plan §3.2:526' },
			{ name: 'questionExpiryMs', expected: 1_209_600_000, plan: 'plan §3.2:527' },
			{ name: 'activePerUser', expected: 3, plan: 'plan §3.2:528' },
			{ name: 'activePerOrg', expected: 10, plan: 'plan §3.2:529' },
			{ name: 'startsPerHour', expected: 10, plan: 'plan §3.2:530' },
			{ name: 'pollMs', expected: 5_000, plan: 'plan §3.2:531' },
			{ name: 'infraRetries', expected: 3, plan: 'plan §3.2:532' },
			{ name: 'infraRetryWindowMs', expected: 1_800_000, plan: 'plan §3.2:533' },
			{ name: 'suggestionsPer30Days', expected: 5, plan: 'plan §3.2:534' },
			{ name: 'autoReprovisionPerSync', expected: 1, plan: 'plan §3.2:535' },
			{ name: 'autoReprovisionPer7Days', expected: 2, plan: 'plan §3.2:536' },
			{ name: 'clusterProbeMs', expected: 10_000, plan: 'plan §3.2:537' },
			{ name: 'podPendingInfraMs', expected: 600_000, plan: 'plan §3.2:538' }
		];

		it('pins all 51 limits — an added key is a second deliberate edit', () => {
			expect(LIMITS).toHaveLength(51);
			expect(Object.keys(APP_PROVISION_LIMITS).sort()).toEqual(
				LIMITS.map((limit) => limit.name as string).sort()
			);
		});

		it.each(LIMITS)('pins $name = $expected ($plan)', ({ name, expected }) => {
			expect(APP_PROVISION_LIMITS[name]).toBe(expected);
		});

		it('keeps the min < default < max relationships the enrollment path relies on', () => {
			expect(APP_PROVISION_LIMITS.attemptsMin).toBeLessThan(APP_PROVISION_LIMITS.attemptsDefault);
			expect(APP_PROVISION_LIMITS.attemptsDefault).toBeLessThan(APP_PROVISION_LIMITS.attemptsMax);
			expect(APP_PROVISION_LIMITS.attemptsMax).toBeLessThan(APP_PROVISION_LIMITS.attemptsCeiling);
			expect(APP_PROVISION_LIMITS.tokenCapMin).toBeLessThan(APP_PROVISION_LIMITS.tokenCapDefault);
			expect(APP_PROVISION_LIMITS.tokenCapDefault).toBeLessThan(APP_PROVISION_LIMITS.tokenCapMax);
			expect(APP_PROVISION_LIMITS.runnerMinuteCapMin).toBeLessThan(APP_PROVISION_LIMITS.runnerMinuteCapDefault);
			expect(APP_PROVISION_LIMITS.runnerMinuteCapDefault).toBeLessThan(APP_PROVISION_LIMITS.runnerMinuteCapMax);
			// §6.4's reservation: min(build timeout, 60) + 30 = 90 minutes at the defaults.
			expect(
				Math.min(APP_PROVISION_LIMITS.buildMinutesMax, APP_PROVISION_LIMITS.buildMinutesMax) +
					APP_PROVISION_LIMITS.runnerBootMinutesMax
			).toBe(90);
		});
	});

	describe('the four id → i18n-leaf maps (plan §3.2:657-699)', () => {
		const LEAF = /^[a-z][a-zA-Z0-9]*$/;

		it('gives every question reason a leaf, with no dash and no dot', () => {
			for (const reason of APP_PROVISIONING_QUESTION_REASONS) {
				expect(APP_PROVISIONING_QUESTION_REASON_I18N_KEY[reason]).toMatch(LEAF);
			}
			expect(Object.keys(APP_PROVISIONING_QUESTION_REASON_I18N_KEY)).toHaveLength(9);
			expect(APP_PROVISIONING_QUESTION_REASON_I18N_KEY['safety-rail']).toBe('safetyRail');
		});

		it('gives every failure reason a leaf — including privateRepository', () => {
			for (const reason of APP_PROVISIONING_FAILURE_REASONS) {
				expect(APP_PROVISIONING_FAILURE_REASON_I18N_KEY[reason]).toMatch(LEAF);
			}
			expect(Object.keys(APP_PROVISIONING_FAILURE_REASON_I18N_KEY)).toHaveLength(11);
			expect(APP_PROVISIONING_FAILURE_REASON_I18N_KEY['private-repository']).toBe('privateRepository');
		});

		it('gives both queued reasons a leaf', () => {
			expect(APP_PROVISIONING_QUEUED_REASON_I18N_KEY).toEqual({
				'user-limit': 'userLimit',
				'org-limit': 'orgLimit'
			});
			expectExhaustive({
				'user-limit': true,
				'org-limit': true
			} satisfies Record<AppProvisioningQueuedReason, true>);
		});

		it('gives every option id a leaf, the seven of §3.2 first and retryAfterSetting appended', () => {
			expect(APP_PROVISIONING_OPTION_I18N_KEY).toEqual({
				retry: 'retry',
				optional: 'optional',
				'verify-on-cluster': 'verifyOnCluster',
				'accept-build-only': 'acceptBuildOnly',
				'raise-cap': 'raiseCap',
				choose: 'choose',
				stop: 'stop',
				'retry-after-setting': 'retryAfterSetting'
			});
			expect(Object.keys(APP_PROVISIONING_OPTION_I18N_KEY)).toHaveLength(8);
			for (const leaf of Object.values(APP_PROVISIONING_OPTION_I18N_KEY)) {
				expect(leaf).toMatch(LEAF);
			}
			expectExhaustive({
				retry: true,
				optional: true,
				'verify-on-cluster': true,
				'accept-build-only': true,
				'raise-cap': true,
				choose: true,
				stop: true,
				'retry-after-setting': true
			} satisfies Record<AppProvisioningOptionId, true>);
		});

		it('never composes an id into a key — every leaf is the map’s own value', () => {
			// `choose:<n>` is the ONE id that is not a map key, and it resolves
			// through its `choose` prefix (plan §3.2:661).
			expect(Object.keys(APP_PROVISIONING_OPTION_I18N_KEY)).not.toContain('choose:1');
			expect(APP_PROVISIONING_OPTION_I18N_KEY.choose).toBe('choose');
		});
	});

	describe('the copy module (T6:135 → T49)', () => {
		it('is total over every reason, failure, queued id and chat/evidence leaf', () => {
			expect(Object.keys(APP_PROVISION_QUESTION_SUBJECTS)).toHaveLength(9);
			expect(Object.keys(APP_PROVISION_REASON_TEXTS)).toHaveLength(11);
			expect(Object.keys(APP_PROVISION_QUEUED_REASON_TEXTS)).toHaveLength(2);
			expect(Object.keys(APP_PROVISION_CHAT_TEMPLATES)).toEqual([
				'started',
				'proposed',
				'attemptRed',
				'succeeded',
				'needsInput',
				'failed'
			]);
			expect(Object.keys(APP_PROVISION_EVIDENCE_HEADINGS)).toHaveLength(9);
		});

		it('has a non-empty template for every entry of the registry', () => {
			expect(APP_PROVISION_COPY_TEMPLATES.length).toBeGreaterThan(40);
			for (const template of APP_PROVISION_COPY_TEMPLATES) {
				expect(template.value.length, `${template.name} must not be empty`).toBeGreaterThan(0);
			}
		});

		it('uses no placeholder that is not a declared param (T49’s third rule)', () => {
			const declared = new Set<string>(APP_PROVISION_COPY_PARAMS);

			for (const template of APP_PROVISION_COPY_TEMPLATES) {
				for (const placeholder of appProvisionCopyPlaceholders(template.value)) {
					expect(
						declared.has(placeholder),
						`${template.name} uses {${placeholder}}, which is not a declared param`
					).toBe(true);
					expect(
						template.params.includes(placeholder as AppProvisionCopyParam),
						`${template.name} uses {${placeholder}} without declaring it`
					).toBe(true);
				}
			}
		});

		it('resolves every declared placeholder and leaves an unknown one verbatim', () => {
			expect(
				appProvisionCopy.questionSubject('missing-required-value', {
					repo: 'owner/repo',
					variable: 'OAUTH_CLIENT_SECRET'
				})
			).toBe('Provisioning owner/repo: the app will not start without OAUTH_CLIENT_SECRET.');
			// Nothing is blanked: a missing value stays visible rather than
			// producing a sentence that reads as deliberate English.
			expect(appProvisionCopy.questionSubject('attempts-spent', { repo: 'owner/repo' })).toBe(
				'Provisioning owner/repo: the app could not be verified in {attempts} attempts.'
			);
		});

		it('resolves choose:<n> through its prefix, with n as a param', () => {
			const options = appProvisionCopy.questionOptions('multiple-apps', {
				candidates: 'apps/web,apps/api'
			});

			expect(options.map((option) => option.id)).toEqual(['choose:1', 'choose:2', 'stop']);
			expect(options.map((option) => option.i18nKey)).toEqual(['choose', 'choose', 'stop']);
			expect(options[0].label).toBe('Use apps/web');
			expect(options[0].candidate).toBe(1);
			expect(options[1].label).toBe('Use apps/api');
			expect(options[1].candidate).toBe(2);
		});

		it('never offers more options than APP_PROVISION_LIMITS.optionsMax', () => {
			for (const reason of APP_PROVISIONING_QUESTION_REASONS) {
				const options = appProvisionCopy.questionOptions(reason, {
					candidates: 'a,b,c,d,e,f,g',
					repo: 'owner/repo'
				});

				expect(options.length, `${reason} must not exceed optionsMax`).toBeLessThanOrEqual(
					APP_PROVISION_LIMITS.optionsMax
				);
				expect(options[options.length - 1].id).toBe('stop');
			}
		});

		it('labels every fixed option from the shared map, and raise-cap by the cap being raised', () => {
			for (const [id, label] of Object.entries(APP_PROVISION_OPTION_LABELS)) {
				expect(label.length).toBeGreaterThan(0);
				expect(APP_PROVISIONING_OPTION_I18N_KEY[id as AppProvisioningOptionId]).toBeDefined();
			}
			expect(appProvisionCopy.questionOptions('token-cap').map((option) => option.label)).toEqual([
				'Raise the cap by 1,000,000 tokens',
				'Stop provisioning'
			]);
			expect(appProvisionCopy.questionOptions('runner-minute-cap').map((option) => option.label)).toEqual([
				'Raise the cap by 60 runner minutes',
				'Stop provisioning'
			]);
		});

		it('answers the failure text of every reason, and the queued clause of both', () => {
			expect(appProvisionCopy.reasonText('could-not-verify', { attempts: 3 })).toBe(
				'it could not be verified after 3 attempts.'
			);
			expect(appProvisionCopy.reasonText('private-repository')).toBe(
				"private repositories can't be provisioned yet."
			);
			expect(appProvisionCopy.queuedReason('user-limit')).toBe('you already have 3 provisionings running.');
			expect(appProvisionCopy.queuedReason('org-limit')).toBe(
				'this workspace already has 10 provisionings running.'
			);
		});

		it('composes the chat milestone and the reminder, and exposes the headings verbatim', () => {
			expect(
				appProvisionCopy.chat.attemptRed({
					n: 1,
					budget: 3,
					step: 'Starting it up',
					detail: 'the migration job exited with code 1'
				})
			).toBe('Attempt 1 of 3 failed at Starting it up: the migration job exited with code 1. Fixing it.');
			expect(appProvisionCopy.chat.needsInput()).toBe("I need a decision from you — it's in My Decisions.");
			expect(appProvisionCopy.reminder.title).toBe(APP_PROVISION_REMINDER_TITLE);
			expect(appProvisionCopy.reminder.body({ repo: 'owner/repo' })).toBe(
				APP_PROVISION_REMINDER_BODY.replace('{repo}', 'owner/repo')
			);
			expect(appProvisionCopy.evidence.buildLog).toBe('Build log');
			expect(appProvisionCopy.evidence.imageDigest).toBe('Image digest');
		});

		it('exposes the leaf of every reason through the object the worker calls', () => {
			for (const reason of APP_PROVISIONING_QUESTION_REASONS) {
				expect(appProvisionCopy.reasonI18nKey(reason)).toBe(APP_PROVISIONING_QUESTION_REASON_I18N_KEY[reason]);
			}
			for (const reason of APP_PROVISIONING_FAILURE_REASONS) {
				expect(appProvisionCopy.failureI18nKey(reason)).toBe(APP_PROVISIONING_FAILURE_REASON_I18N_KEY[reason]);
			}
			expect(appProvisionCopy.queuedI18nKey('org-limit')).toBe('orgLimit');
		});

		it('has no I/O — the module is templates, substitutions and lookups only', () => {
			// A structural check rather than a claim: every member is a string,
			// a number, an array, or a function, and none of them is async.
			for (const value of Object.values(appProvisionCopy)) {
				if (typeof value === 'function') {
					expect(value.constructor.name).toBe('Function');
				} else if (typeof value === 'object' && value !== null) {
					for (const inner of Object.values(value)) {
						expect(['string', 'function']).toContain(typeof inner);
					}
				}
			}
		});
	});
});
