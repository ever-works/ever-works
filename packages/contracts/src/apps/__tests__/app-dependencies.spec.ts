import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import * as appsBarrel from '../index.js';
import * as packageRoot from '../../index.js';

import {
	APP_DEPENDENCY_BACKUP_OVERDUE_MS,
	APP_DEPENDENCY_BACKUP_STATES,
	APP_DEPENDENCY_BACKUP_STATE_MESSAGE_LEAVES,
	APP_DEPENDENCY_BACKUP_STATE_MESSAGE_KEY_PREFIX,
	APP_DEPENDENCY_DEFAULT_SIZE_GIB,
	APP_DEPENDENCY_ERROR_CODES,
	APP_DEPENDENCY_EXTERNAL_TEST_MS,
	APP_DEPENDENCY_KINDS,
	APP_DEPENDENCY_MANAGED,
	APP_DEPENDENCY_OUTPUTS,
	APP_DEPENDENCY_OUTPUT_NAMES,
	APP_DEPENDENCY_READY_DEADLINE_MS,
	APP_DEPENDENCY_REASONS,
	APP_DEPENDENCY_REASON_MESSAGE_KEY_PREFIX,
	APP_DEPENDENCY_REASON_MESSAGE_LEAVES,
	APP_DEPENDENCY_REFRESH_AFTER_MS,
	APP_DEPENDENCY_RELAY_DAILY_LIMIT,
	APP_DEPENDENCY_RETRY_DELAY_MS,
	APP_DEPENDENCY_STATUSES,
	APP_DEPENDENCY_STATUS_REASONS,
	APP_DEPENDENCY_STATUS_MESSAGE_KEY_PREFIX,
	APP_DEPENDENCY_STATUS_MESSAGE_LEAVES,
	APP_DEPENDENCY_TRANSIENT_ATTEMPTS,
	appDependencyBackupStateMessageKey,
	appDependencyReasonMessageKey,
	appDependencyStatusMessageKey,
	isAppDependencyReason,
	type AppDependencyBackupState,
	type AppDependencyErrorCode,
	type AppDependencyKind,
	type AppDependencyReason,
	type AppDependencyStatus,
	type AppDependencyStatusReason,
	type AppDependencyView,
	type AppDependencyOutputFlags
} from '../app-dependencies.js';

/**
 * Behavioural contract for APW-07's shared dependency module
 * (`app-dependencies.ts`, plan §3.3:296-325).
 *
 * The normative pins are here: the output table must equal **spec FR-40**
 * member for member with the same secret flags, the four readiness deadlines and
 * the 26-hour overdue line must be their exact millisecond values, and every
 * status, status reason and API error code must resolve to exactly one message
 * key under `dashboard.workDetail.appDependencies.*` in
 * `apps/web/messages/en.json` — the gate APW07-G23 exists for, because a code
 * without copy renders as a raw identifier on a card (plan §5:802-805, §8:918).
 *
 * Every assertion is paired with a deliberate perturbation in the task report; a
 * suite that could not fail would be no evidence at all.
 */

/** Compile-time equality, so a widened or narrowed union fails to type-check. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Forces `Equal<…>` to be `true` at compile time. */
type Expect<T extends true> = T;

/** True when a tuple repeats a member — the compile-time half of the uniqueness pin. */
type HasDuplicates<T extends readonly string[], Seen extends string = never> = T extends readonly [
	infer Head extends string,
	...infer Rest extends string[]
]
	? Head extends Seen
		? true
		: HasDuplicates<Rest, Seen | Head>
	: false;

/**
 * The closed unions restated from the PLAN and SPEC — never from the module — so
 * the pins compare the module to its source rather than to itself.
 */
type SpecAppDependencyKind = 'postgres' | 'redis' | 'objectStorage' | 'smtp'; // plan.md:296, FR-35
type SpecAppDependencyStatus =
	| 'pending'
	| 'awaiting_config'
	| 'provisioning'
	| 'ready'
	| 'degraded'
	| 'failed'
	| 'kept'
	| 'deleting'
	| 'deleted'; // plan.md:210 + plan.md:641, spec.md:433
type SpecAppDependencyBackupState =
	| 'none'
	| 'not_configured'
	| 'healthy'
	| 'overdue'
	| 'failing'
	| 'external'
	| 'unknown'; // plan.md:221, spec FR-48
type SpecAppDependencyReason =
	| 'noDefaultStorageClass'
	| 'clusterUnreachable'
	| 'smtpConnectFailed'
	| 'smtpTlsFailed'
	| 'smtpAuthRefused'
	| 'bucketUnreadable'
	| 'volumeNotReady'
	| 'extensionUnavailable'
	| 'platformServerRefused'
	| 'deadlineExceeded'
	| 'namespaceNotOwned'
	| 'namespaceBaselineMissing'
	| 'clusterPermissionMissing'
	| 'operatorNamespaceUnknown'
	| 'volumeExpansionUnsupported'
	| 'sizeShrinkRefused'
	| 'relayIneligible'
	| 'relaySuspended'
	| 'providerNotSupported'
	| 'dependencyNotDeclared'
	| 'confirmationMismatch'
	| 'deleteInProgress'
	| 'notGenerated'
	| 'notAppWork'
	// APW07-G28 — the plan line carries the twenty-four above; the two below are
	// the card members APW-06's `AppRuntimeTargetUnavailable` needs
	// (`target_none`, `target_not_checked`), appended in the port's own order.
	// `namespace_owned_elsewhere` → `namespaceNotOwned` and
	// `cluster_unreachable` → `clusterUnreachable` needed no new member.
	| 'targetNone'
	| 'targetNotChecked'; // plan.md:913 + APW07-G28
type SpecAppDependencyErrorCode =
	| 'volumeExpansionUnsupported'
	| 'sizeShrinkRefused'
	| 'providerNotSupported'
	| 'dependencyNotDeclared'
	| 'confirmationMismatch'
	| 'deleteInProgress'
	| 'notGenerated'
	| 'notAppWork'; // plan.md:798-802
type SpecAppDependencyStatusReason = Exclude<SpecAppDependencyReason, SpecAppDependencyErrorCode>;

/** The FR-40 output table, restated from the spec — names AND secret flags. */
const SPEC_FR_40_OUTPUTS = {
	postgres: { url: true, directUrl: true, host: false, port: false, database: false, user: false, password: true },
	redis: { url: true, host: false, port: false, password: true },
	objectStorage: { endpoint: false, region: false, accessKeyId: true, secretAccessKey: true, 'bucket.*': false },
	smtp: { host: false, port: false, user: false, password: true, from: false, secure: false }
} as const;

/** FR-40's output names in the spec's own order (spec.md:334-337). */
const SPEC_FR_40_OUTPUT_NAMES: Record<SpecAppDependencyKind, readonly string[]> = {
	postgres: ['url', 'directUrl', 'host', 'port', 'database', 'user', 'password'],
	redis: ['url', 'host', 'port', 'password'],
	objectStorage: ['endpoint', 'region', 'accessKeyId', 'secretAccessKey', 'bucket.*'],
	smtp: ['host', 'port', 'user', 'password', 'from', 'secure']
};

const RUNTIME_TUPLES: readonly (readonly [string, readonly string[]])[] = [
	['APP_DEPENDENCY_KINDS', APP_DEPENDENCY_KINDS],
	['APP_DEPENDENCY_STATUSES', APP_DEPENDENCY_STATUSES],
	['APP_DEPENDENCY_BACKUP_STATES', APP_DEPENDENCY_BACKUP_STATES],
	['APP_DEPENDENCY_REASONS', APP_DEPENDENCY_REASONS],
	['APP_DEPENDENCY_STATUS_REASONS', APP_DEPENDENCY_STATUS_REASONS],
	['APP_DEPENDENCY_ERROR_CODES', APP_DEPENDENCY_ERROR_CODES]
];

describe('app-dependencies — closed unions match the plan and the spec (tasks.md:65-76)', () => {
	it('pins every derived union type against the literal union its plan line names', () => {
		const kinds = APP_DEPENDENCY_KINDS satisfies readonly SpecAppDependencyKind[];
		const statuses = APP_DEPENDENCY_STATUSES satisfies readonly SpecAppDependencyStatus[];
		const backupStates = APP_DEPENDENCY_BACKUP_STATES satisfies readonly SpecAppDependencyBackupState[];
		const reasons = APP_DEPENDENCY_REASONS satisfies readonly SpecAppDependencyReason[];
		const statusReasons = APP_DEPENDENCY_STATUS_REASONS satisfies readonly SpecAppDependencyStatusReason[];
		const errorCodes = APP_DEPENDENCY_ERROR_CODES satisfies readonly SpecAppDependencyErrorCode[];

		const kind: Expect<Equal<AppDependencyKind, SpecAppDependencyKind>> = true;
		const status: Expect<Equal<AppDependencyStatus, SpecAppDependencyStatus>> = true;
		const backup: Expect<Equal<AppDependencyBackupState, SpecAppDependencyBackupState>> = true;
		const reason: Expect<Equal<AppDependencyReason, SpecAppDependencyReason>> = true;
		const statusReason: Expect<Equal<AppDependencyStatusReason, SpecAppDependencyStatusReason>> = true;
		const errorCode: Expect<Equal<AppDependencyErrorCode, SpecAppDependencyErrorCode>> = true;

		expect([
			kinds.length,
			statuses.length,
			backupStates.length,
			reasons.length,
			statusReasons.length,
			errorCodes.length,
			kind,
			status,
			backup,
			reason,
			statusReason,
			errorCode
		]).toEqual([4, 9, 7, 26, 18, 8, true, true, true, true, true, true]);
	});

	it('has no duplicate member in any exported tuple', () => {
		expect(RUNTIME_TUPLES.length).toBe(6);
		for (const [name, members] of RUNTIME_TUPLES) {
			expect(members.length, `${name} must not be empty`).toBeGreaterThan(0);
			expect(new Set(members).size, `${name} repeats a member`).toBe(members.length);
			for (const member of members) {
				expect(typeof member, `${name} has a non-string member`).toBe('string');
				expect(member.length, `${name} has an empty member`).toBeGreaterThan(0);
			}
		}
	});

	it('cannot grow a duplicate at compile time either', () => {
		const kinds: Expect<Equal<HasDuplicates<typeof APP_DEPENDENCY_KINDS>, false>> = true;
		const statuses: Expect<Equal<HasDuplicates<typeof APP_DEPENDENCY_STATUSES>, false>> = true;
		const backupStates: Expect<Equal<HasDuplicates<typeof APP_DEPENDENCY_BACKUP_STATES>, false>> = true;
		const reasons: Expect<Equal<HasDuplicates<typeof APP_DEPENDENCY_REASONS>, false>> = true;
		const statusReasons: Expect<Equal<HasDuplicates<typeof APP_DEPENDENCY_STATUS_REASONS>, false>> = true;
		const errorCodes: Expect<Equal<HasDuplicates<typeof APP_DEPENDENCY_ERROR_CODES>, false>> = true;

		expect([kinds, statuses, backupStates, reasons, statusReasons, errorCodes]).toEqual([
			true,
			true,
			true,
			true,
			true,
			true
		]);
	});

	it('carries the four kinds and the seven backup states of FR-48 verbatim', () => {
		expect([...APP_DEPENDENCY_KINDS]).toEqual(['postgres', 'redis', 'objectStorage', 'smtp']);
		expect([...APP_DEPENDENCY_BACKUP_STATES]).toEqual([
			'none',
			'not_configured',
			'healthy',
			'overdue',
			'failing',
			'external',
			'unknown'
		]);
	});
});

describe('app-dependencies — statuses include awaiting_config (plan §4.9a:641, APW07-G16)', () => {
	it('lists the nine statuses of plan §3.2:210 plus §4.9a, in the spec’s transition order', () => {
		expect([...APP_DEPENDENCY_STATUSES]).toEqual([
			'pending',
			'awaiting_config',
			'provisioning',
			'ready',
			'degraded',
			'failed',
			'kept',
			'deleting',
			'deleted'
		]);
		// The status the 2026-09-17 fix pass added: a provider whose settings only the
		// owner can supply parks here and dispatches nothing, so its card cannot reach
		// `failed deadlineExceeded` inside the 30-second SMTP deadline.
		expect(APP_DEPENDENCY_STATUSES).toContain('awaiting_config');
		expect(APP_DEPENDENCY_STATUSES).not.toContain('awaitingConfig');
		// `varchar(16)` in plan §3.2:210 — a longer member would silently truncate.
		for (const status of APP_DEPENDENCY_STATUSES) {
			expect(status.length, `${status} exceeds the varchar(16) column`).toBeLessThanOrEqual(16);
		}
	});

	it('resolves every status to exactly one message key under dashboard.workDetail.appDependencies.status.*', () => {
		const messages = readEnglishMessages();
		expect(APP_DEPENDENCY_STATUS_MESSAGE_KEY_PREFIX).toBe('dashboard.workDetail.appDependencies.status');
		const leaves = APP_DEPENDENCY_STATUSES.map((status) => APP_DEPENDENCY_STATUS_MESSAGE_LEAVES[status]);
		expect(new Set(leaves).size, 'two statuses share one message leaf').toBe(leaves.length);
		expect(Object.keys(APP_DEPENDENCY_STATUS_MESSAGE_LEAVES).sort()).toEqual([...APP_DEPENDENCY_STATUSES].sort());
		for (const status of APP_DEPENDENCY_STATUSES) {
			const key = appDependencyStatusMessageKey(status);
			const message = leafAt(messages, key);
			expect(
				typeof message,
				`${status} has no message under ${key}. Add it to apps/web/messages/en.json — a status without copy ` +
					`renders as a raw identifier on a card (APW07-G23).`
			).toBe('string');
			expect((message as string).length, `${key} must not be empty`).toBeGreaterThan(0);
			expect(APP_DEPENDENCY_STATUS_MESSAGE_LEAVES[status]).not.toContain('.');
			expect(APP_DEPENDENCY_STATUS_MESSAGE_LEAVES[status]).toMatch(/^[a-z][A-Za-z0-9]*$/);
		}
		// `awaitingConfig` is the camelCase leaf of `awaiting_config` (plan §8:911).
		expect(APP_DEPENDENCY_STATUS_MESSAGE_LEAVES.awaiting_config).toBe('awaitingConfig');
	});

	it('resolves every backup state to exactly one message key under …appDependencies.backup.*', () => {
		const messages = readEnglishMessages();
		expect(APP_DEPENDENCY_BACKUP_STATE_MESSAGE_KEY_PREFIX).toBe('dashboard.workDetail.appDependencies.backup');
		const leaves = APP_DEPENDENCY_BACKUP_STATES.map((state) => APP_DEPENDENCY_BACKUP_STATE_MESSAGE_LEAVES[state]);
		expect(new Set(leaves).size).toBe(leaves.length);
		expect(Object.keys(APP_DEPENDENCY_BACKUP_STATE_MESSAGE_LEAVES).sort()).toEqual(
			[...APP_DEPENDENCY_BACKUP_STATES].sort()
		);
		for (const state of APP_DEPENDENCY_BACKUP_STATES) {
			const key = appDependencyBackupStateMessageKey(state);
			const message = leafAt(messages, key);
			expect(typeof message, `${state} has no message under ${key} (APW07-G23)`).toBe('string');
			expect((message as string).length, `${key} must not be empty`).toBeGreaterThan(0);
		}
		expect(APP_DEPENDENCY_BACKUP_STATE_MESSAGE_LEAVES.not_configured).toBe('notConfigured');
	});
});

describe('app-dependencies — reasons and API error codes carry copy (plan §5:798-805, §8:913; APW07-G23)', () => {
	it('names the twenty-four reasons of plan §8:913 in the plan’s order, then APW07-G28’s two', () => {
		expect([...APP_DEPENDENCY_REASONS]).toEqual([...SPEC_REASONS]);
		expect(APP_DEPENDENCY_REASONS).toHaveLength(26);
		// The plan's twenty-four stay first and in the plan's order — the two
		// APW07-G28 additions are appended, so nothing already pinned moved.
		expect([...APP_DEPENDENCY_REASONS.slice(0, 24)]).toEqual([...SPEC_PLAN_REASONS]);
		// `varchar(48)` in plan §3.2:211.
		for (const reason of APP_DEPENDENCY_REASONS) {
			expect(reason.length, `${reason} exceeds the varchar(48) column`).toBeLessThanOrEqual(48);
		}
	});

	it('splits the reasons into the eighteen status reasons and the eight API error codes', () => {
		expect([...APP_DEPENDENCY_ERROR_CODES]).toEqual([...SPEC_ERROR_CODES]);
		expect([...APP_DEPENDENCY_STATUS_REASONS]).toEqual([...SPEC_STATUS_REASONS]);
		// The two subsets partition the reason vocabulary: no member is in both, and
		// nothing is in neither.
		expect(new Set([...APP_DEPENDENCY_STATUS_REASONS, ...APP_DEPENDENCY_ERROR_CODES]).size).toBe(
			APP_DEPENDENCY_REASONS.length
		);
		expect([...APP_DEPENDENCY_STATUS_REASONS, ...APP_DEPENDENCY_ERROR_CODES].sort()).toEqual(
			[...APP_DEPENDENCY_REASONS].sort()
		);
		for (const code of APP_DEPENDENCY_ERROR_CODES) {
			expect(APP_DEPENDENCY_STATUS_REASONS).not.toContain(code);
		}
	});

	it('resolves every reason to exactly one message key under dashboard.workDetail.appDependencies.reasons.*', () => {
		const messages = readEnglishMessages();
		expect(APP_DEPENDENCY_REASON_MESSAGE_KEY_PREFIX).toBe('dashboard.workDetail.appDependencies.reasons');

		const resolved: string[] = [];
		for (const reason of APP_DEPENDENCY_REASONS) {
			const key = appDependencyReasonMessageKey(reason);
			const message = leafAt(messages, key);
			expect(
				typeof message,
				`${reason} has no message under ${key}. Add it to apps/web/messages/en.json — a reason without copy ` +
					`renders as a raw identifier on a dependency card (APW07-G23).`
			).toBe('string');
			expect((message as string).length, `${key} must not be empty`).toBeGreaterThan(0);
			resolved.push(key);
		}

		// "Exactly one": the leaf map is total and injective, and the namespace holds
		// no leaf this module does not name.
		const leaves = APP_DEPENDENCY_REASONS.map((reason) => APP_DEPENDENCY_REASON_MESSAGE_LEAVES[reason]);
		expect(new Set(leaves).size, 'two reasons share one message leaf').toBe(leaves.length);
		expect(Object.keys(APP_DEPENDENCY_REASON_MESSAGE_LEAVES).sort()).toEqual([...APP_DEPENDENCY_REASONS].sort());
		expect(resolved.length).toBe(APP_DEPENDENCY_REASONS.length);
		const namespace = leafAt(messages, APP_DEPENDENCY_REASON_MESSAGE_KEY_PREFIX);
		expect(namespace, 'dashboard.workDetail.appDependencies.reasons must exist').toBeTypeOf('object');
		expect(
			Object.keys(namespace as Record<string, unknown>).sort(),
			'a leaf under appDependencies.reasons has no code — every leaf there is one reason'
		).toEqual([...leaves].sort());
	});

	it('keeps every reason leaf a dot-free camelCase identifier (plan §8:894)', () => {
		for (const reason of APP_DEPENDENCY_REASONS) {
			const leaf = APP_DEPENDENCY_REASON_MESSAGE_LEAVES[reason];
			expect(leaf, `${reason} must name a leaf`).not.toContain('.');
			expect(leaf, `${reason} leaf must be camelCase`).toMatch(/^[a-z][A-Za-z0-9]*$/);
			expect(appDependencyReasonMessageKey(reason)).toBe(`dashboard.workDetail.appDependencies.reasons.${leaf}`);
		}
	});

	it('carries APW07-G28’s port reasons, mapped from APW-06’s unavailable vocabulary', () => {
		// APW-06 plan §9.9:1564-1567 and APW-07 plan §4.8:550-556 name the port's
		// four codes; two of them had no card member, and `asReason` reads a stored
		// reason back through this closed union, so an unknown string became `null`
		// and the card read *Failed* with no reason at all.
		const PORT_REASONS = {
			target_none: 'targetNone',
			target_not_checked: 'targetNotChecked',
			namespace_owned_elsewhere: 'namespaceNotOwned',
			cluster_unreachable: 'clusterUnreachable'
		} as const satisfies Record<string, AppDependencyReason>;

		for (const [code, reason] of Object.entries(PORT_REASONS)) {
			// A member of BOTH lists — a definite failure of an attempt is a card
			// reason (FR-43) and never an API error code; the two partition the union.
			expect(APP_DEPENDENCY_REASONS, `${code} → ${reason}`).toContain(reason);
			expect(APP_DEPENDENCY_STATUS_REASONS, `${code} → ${reason}`).toContain(reason);
			expect(APP_DEPENDENCY_ERROR_CODES, `${code} → ${reason}`).not.toContain(reason);
			// The cross-back the service performs on every stored reason: without the
			// member this is false, which is the silently-dropped reason APW07-G28 fixes.
			expect(isAppDependencyReason(reason), `${reason} must survive asReason`).toBe(true);
		}

		// The other two are mappings, not additions — `namespace_owned_elsewhere` →
		// `namespaceNotOwned` is plan §4.9:597-602 verbatim.
		expect(APP_DEPENDENCY_REASONS).toContain('namespaceNotOwned');
		expect(APP_DEPENDENCY_REASONS).toContain('clusterUnreachable');
		expect(APP_DEPENDENCY_REASONS as readonly string[]).not.toContain('namespace_owned_elsewhere');
		expect(APP_DEPENDENCY_REASONS as readonly string[]).not.toContain('cluster_unreachable');
		expect(isAppDependencyReason('namespace_owned_elsewhere')).toBe(false);
		expect(isAppDependencyReason('target_not_checked')).toBe(false);
	});

	it('gives each APW07-G28 reason one non-empty leaf under …appDependencies.reasons.* in en.json', () => {
		const messages = readEnglishMessages();

		for (const reason of ['targetNone', 'targetNotChecked'] as const) {
			expect(APP_DEPENDENCY_REASON_MESSAGE_LEAVES[reason]).toBe(reason);
			const key = appDependencyReasonMessageKey(reason);
			const message = leafAt(messages, key);
			expect(
				typeof message,
				`${reason} has no message under ${key}. Add it to apps/web/messages/en.json — a reason without copy ` +
					`renders as a raw identifier on a dependency card (APW07-G23).`
			).toBe('string');
			expect((message as string).trim().length, `${key} must not be empty`).toBeGreaterThan(0);
		}
	});
});

describe('app-dependencies — outputs equal spec FR-40 exactly (tasks.md:71-72)', () => {
	it('has the same secret flags, member for member, as spec FR-40 (spec.md:334-337)', () => {
		expect(APP_DEPENDENCY_OUTPUTS).toEqual(SPEC_FR_40_OUTPUTS);
		for (const kind of APP_DEPENDENCY_KINDS) {
			expect(Object.keys(APP_DEPENDENCY_OUTPUTS[kind])).toEqual(Object.keys(SPEC_FR_40_OUTPUTS[kind]));
		}
	});

	it('has the same output names, in the same order, as spec FR-40', () => {
		for (const kind of APP_DEPENDENCY_KINDS) {
			expect([...APP_DEPENDENCY_OUTPUT_NAMES[kind]], `${kind} output names`).toEqual([
				...SPEC_FR_40_OUTPUT_NAMES[kind]
			]);
			// The name list and the flag map are two views of one table: a name the
			// flags forgot would make `isAppDependencyOutputSecret` fail closed.
			expect(Object.keys(APP_DEPENDENCY_OUTPUTS[kind]).sort()).toEqual(
				[...APP_DEPENDENCY_OUTPUT_NAMES[kind]].sort()
			);
		}
	});

	it('marks exactly the five secret outputs FR-40 names', () => {
		const secret: string[] = [];
		for (const kind of APP_DEPENDENCY_KINDS) {
			const flags: AppDependencyOutputFlags = APP_DEPENDENCY_OUTPUTS[kind];
			for (const [name, isSecret] of Object.entries(flags)) {
				if (isSecret) secret.push(`${kind}.${name}`);
			}
		}
		expect(secret.sort()).toEqual(
			[
				'objectStorage.accessKeyId',
				'objectStorage.secretAccessKey',
				'postgres.directUrl',
				'postgres.password',
				'postgres.url',
				'redis.password',
				'redis.url',
				'smtp.password'
			].sort()
		);
		// FR-40's sentence names five KINDS of value; `url` appears for two kinds.
		expect(APP_DEPENDENCY_OUTPUTS.objectStorage['bucket.*']).toBe(false);
		expect(APP_DEPENDENCY_OUTPUTS.smtp.secure).toBe(false);
		expect(APP_DEPENDENCY_OUTPUTS.smtp.from).toBe(false);
		expect(APP_DEPENDENCY_OUTPUTS.redis.host).toBe(false);
	});
});

describe('app-dependencies — every number is the plan’s value (plan.md:304-325)', () => {
	it('pins the four readiness deadlines of FR-41 (plan.md:304-309)', () => {
		// Postgres and object storage 10 minutes, Redis 5 minutes, mail 30 seconds.
		expect(APP_DEPENDENCY_READY_DEADLINE_MS).toEqual({
			postgres: 600_000,
			redis: 300_000,
			objectStorage: 600_000,
			smtp: 30_000
		});
		expect(APP_DEPENDENCY_READY_DEADLINE_MS.postgres).toBe(600_000);
		expect(APP_DEPENDENCY_READY_DEADLINE_MS.redis).toBe(300_000);
		expect(APP_DEPENDENCY_READY_DEADLINE_MS.objectStorage).toBe(600_000);
		expect(APP_DEPENDENCY_READY_DEADLINE_MS.smtp).toBe(30_000);
		expect(Object.keys(APP_DEPENDENCY_READY_DEADLINE_MS)).toEqual([...APP_DEPENDENCY_KINDS]);
	});

	it('pins the overdue line at 26 hours — 93_600_000 ms (plan.md:315, FR-48)', () => {
		expect(APP_DEPENDENCY_BACKUP_OVERDUE_MS).toBe(93_600_000);
		expect(APP_DEPENDENCY_BACKUP_OVERDUE_MS).toBe(26 * 3_600_000);
		// The card line is 26 h; the zone's own schedule target is 24 h (§4.11:721-725,
		// APW07-G25) — a 25-hour-old timestamp is not yet Overdue on the card.
		expect(APP_DEPENDENCY_BACKUP_OVERDUE_MS).toBeGreaterThan(APP_DEPENDENCY_MANAGED.backupMaxAgeMs);
		expect(APP_DEPENDENCY_BACKUP_OVERDUE_MS - APP_DEPENDENCY_MANAGED.backupMaxAgeMs).toBe(2 * 3_600_000);
	});

	it('pins the external test budget, the default sizes and the retry pair', () => {
		// 30_000 — an external provider's connection test (FR-41, plan.md:310)
		expect(APP_DEPENDENCY_EXTERNAL_TEST_MS).toBe(30_000);
		expect(APP_DEPENDENCY_EXTERNAL_TEST_MS).toBe(APP_DEPENDENCY_READY_DEADLINE_MS.smtp);
		// Default volumes on Your cluster (FR-37, plan.md:311); `smtp` has no volume.
		expect(APP_DEPENDENCY_DEFAULT_SIZE_GIB).toEqual({ postgres: 10, objectStorage: 20, redis: 1 });
		expect(Object.keys(APP_DEPENDENCY_DEFAULT_SIZE_GIB)).toEqual(['postgres', 'objectStorage', 'redis']);
		expect(APP_DEPENDENCY_DEFAULT_SIZE_GIB).not.toHaveProperty('smtp');
		// 3 attempts over 15 minutes = a 5-minute gap (FR-43, plan.md:312-313).
		expect(APP_DEPENDENCY_TRANSIENT_ATTEMPTS).toBe(3);
		expect(APP_DEPENDENCY_RETRY_DELAY_MS).toBe(300_000);
		expect(APP_DEPENDENCY_RETRY_DELAY_MS * (APP_DEPENDENCY_TRANSIENT_ATTEMPTS - 1)).toBe(600_000);
	});

	it('pins the refresh window, the relay limit and every managed-tier number', () => {
		// 900_000 — a card older than 15 minutes is refreshed on open (FR-42, plan.md:314)
		expect(APP_DEPENDENCY_REFRESH_AFTER_MS).toBe(900_000);
		// 200 — relay messages per App Work per day (FR-39/FR-61, plan.md:316)
		expect(APP_DEPENDENCY_RELAY_DAILY_LIMIT).toBe(200);
		// The managed tier's semantics (FR-50/FR-52/FR-53, plan.md:317-325)
		expect(APP_DEPENDENCY_MANAGED).toEqual({
			pgRoleConnectionLimit: 20,
			pgDatabaseConnectionLimit: 25,
			pgStatementTimeoutMs: 60_000,
			pgIdleInTransactionTimeoutMs: 60_000,
			bucketQuotaGiB: 10,
			redisMaxMemoryMiB: 256,
			backupMaxAgeMs: 86_400_000
		});
		expect(APP_DEPENDENCY_MANAGED.pgRoleConnectionLimit).toBe(20);
		expect(APP_DEPENDENCY_MANAGED.pgDatabaseConnectionLimit).toBe(25);
		expect(APP_DEPENDENCY_MANAGED.pgStatementTimeoutMs).toBe(60_000);
		expect(APP_DEPENDENCY_MANAGED.pgIdleInTransactionTimeoutMs).toBe(60_000);
		expect(APP_DEPENDENCY_MANAGED.bucketQuotaGiB).toBe(10);
		expect(APP_DEPENDENCY_MANAGED.redisMaxMemoryMiB).toBe(256);
		expect(APP_DEPENDENCY_MANAGED.backupMaxAgeMs).toBe(86_400_000);
		// FR-52: the role's cap is the tighter one; the database admits the extra five.
		expect(APP_DEPENDENCY_MANAGED.pgDatabaseConnectionLimit).toBeGreaterThan(
			APP_DEPENDENCY_MANAGED.pgRoleConnectionLimit
		);
		expect(APP_DEPENDENCY_MANAGED.pgStatementTimeoutMs).toBe(APP_DEPENDENCY_MANAGED.pgIdleInTransactionTimeoutMs);
		expect(APP_DEPENDENCY_MANAGED.backupMaxAgeMs).toBe(24 * 3_600_000);
		expect(APP_DEPENDENCY_MANAGED.bucketQuotaGiB).toBe(APP_DEPENDENCY_DEFAULT_SIZE_GIB.postgres);
	});
});

describe('app-dependencies — the card view carries no output value (plan §5:792-796)', () => {
	const FIXTURE = {
		kind: 'postgres',
		declared: true,
		provider: { pluginId: 'k8s', providerId: 'k8s-inline-postgres', label: 'In your cluster' },
		availableProviders: [
			{
				providerId: 'k8s-inline-postgres',
				label: 'In your cluster',
				promptFields: []
			},
			{
				providerId: 'managed-postgres',
				label: 'Ever Works Apps',
				promptFields: [{ key: 'sizeGiB', label: 'Size', secret: false, required: false, set: false }]
			}
		],
		status: 'ready',
		statusReason: null,
		statusDetail: { attempts: 1 },
		awaitingConfig: false,
		actualVersion: '16',
		sizeGiB: 10,
		backup: { policy: 'none', state: 'none', lastBackupAt: null, checkedAt: null },
		inSpec: true,
		keptResources: null,
		outputs: [
			{ name: 'url', secret: true },
			{ name: 'directUrl', secret: true },
			{ name: 'host', secret: false },
			{ name: 'port', secret: false },
			{ name: 'database', secret: false },
			{ name: 'user', secret: false },
			{ name: 'password', secret: true }
		],
		lastProvisionedAt: '2026-09-17T10:00:00.000Z',
		lastCheckedAt: '2026-09-17T10:15:00.000Z'
	} satisfies AppDependencyView;

	it('has one field per plan §5:793 line, plus §4.9a’s awaitingConfig', () => {
		expect(Object.keys(FIXTURE)).toEqual([
			'kind',
			'declared',
			'provider',
			'availableProviders',
			'status',
			'statusReason',
			'statusDetail',
			'awaitingConfig',
			'actualVersion',
			'sizeGiB',
			'backup',
			'inSpec',
			'keptResources',
			'outputs',
			'lastProvisionedAt',
			'lastCheckedAt'
		]);
		// `outputs` names what exists and whether it is secret — never a value, and
		// never the prompted `config` either (plan §5:795).
		expect(FIXTURE).not.toHaveProperty('config');
		expect(FIXTURE).not.toHaveProperty('outputsEncrypted');
		for (const output of FIXTURE.outputs) {
			expect(Object.keys(output)).toEqual(['name', 'secret']);
			expect(typeof output.secret).toBe('boolean');
		}
	});

	it('names every declared output of its kind, with FR-40’s secret flags', () => {
		expect(FIXTURE.outputs.map((output) => output.name)).toEqual([...APP_DEPENDENCY_OUTPUT_NAMES.postgres]);
		for (const output of FIXTURE.outputs) {
			expect(output.secret, `${output.name} secret flag`).toBe(
				APP_DEPENDENCY_OUTPUTS.postgres[output.name as keyof typeof APP_DEPENDENCY_OUTPUTS.postgres]
			);
		}
		// `directUrl` is emitted ONLY when the App spec asks for it (plan §3.3:328):
		// the same card without it names six outputs and still satisfies the type.
		const withoutDirectUrl = {
			...FIXTURE,
			outputs: FIXTURE.outputs.filter((output) => output.name !== 'directUrl')
		} satisfies AppDependencyView;
		expect(withoutDirectUrl.outputs.map((output) => output.name)).toEqual([
			'url',
			'host',
			'port',
			'database',
			'user',
			'password'
		]);
		expect(withoutDirectUrl.outputs.map((output) => output.name)).not.toContain('directUrl');
		// `bucket.<name>` is emitted once per DECLARED bucket, so an object-storage
		// card's output list is open-ended — and still a pattern in the table.
		const buckets = {
			...FIXTURE,
			kind: 'objectStorage',
			outputs: [
				{ name: 'endpoint', secret: false },
				{ name: 'region', secret: false },
				{ name: 'accessKeyId', secret: true },
				{ name: 'secretAccessKey', secret: true },
				{ name: 'bucket.uploads', secret: false },
				{ name: 'bucket.avatars', secret: false }
			]
		} satisfies AppDependencyView;
		expect(buckets.outputs.map((output) => output.name)).toContain('bucket.uploads');
		expect(APP_DEPENDENCY_OUTPUTS.objectStorage).toHaveProperty('bucket.*');
		expect(APP_DEPENDENCY_OUTPUTS.objectStorage).not.toHaveProperty('bucket.uploads');
	});

	it('keeps awaitingConfig in step with the awaiting_config status (plan §4.9a:645)', () => {
		const awaiting = {
			...FIXTURE,
			status: 'awaiting_config',
			awaitingConfig: true,
			statusReason: null,
			keptResources: null
		} satisfies AppDependencyView;
		expect(awaiting.awaitingConfig).toBe(true);
		expect(FIXTURE.awaitingConfig).toBe(false);
		// A kept row lists the resources it left behind by name (FR-45, FR-56).
		const kept = {
			...FIXTURE,
			status: 'kept',
			inSpec: false,
			statusReason: null,
			keptResources: { namespace: 'app-cal-diy', objects: [{ kind: 'PersistentVolumeClaim', name: 'data-0' }] }
		} satisfies AppDependencyView;
		expect(kept.keptResources?.objects[0]?.name).toBe('data-0');
		expect(kept.statusReason).toBeNull();
		// The union types the fixture relies on are the module's own, not copies.
		const status: AppDependencyStatus = kept.status;
		const reason: AppDependencyReason = 'noDefaultStorageClass';
		const backup: AppDependencyBackupState = 'not_configured';
		expect(status).toBe('kept');
		expect(reason).toBe('noDefaultStorageClass');
		expect(backup).toBe('not_configured');
	});
});

describe('app-dependencies — reachable from the apps barrel and the package root (tasks.md:56-57, R-1)', () => {
	/** Every RUNTIME name this module adds for T2. */
	const RUNTIME_EXPORTS: readonly string[] = [
		'APP_DEPENDENCY_KINDS',
		'APP_DEPENDENCY_OUTPUTS',
		'APP_DEPENDENCY_OUTPUT_NAMES',
		'APP_DEPENDENCY_STATUSES',
		'APP_DEPENDENCY_BACKUP_STATES',
		'APP_DEPENDENCY_REASONS',
		'APP_DEPENDENCY_STATUS_REASONS',
		'APP_DEPENDENCY_ERROR_CODES',
		'APP_DEPENDENCY_REASON_MESSAGE_LEAVES',
		'APP_DEPENDENCY_REASON_MESSAGE_KEY_PREFIX',
		'APP_DEPENDENCY_STATUS_MESSAGE_LEAVES',
		'APP_DEPENDENCY_STATUS_MESSAGE_KEY_PREFIX',
		'APP_DEPENDENCY_BACKUP_STATE_MESSAGE_LEAVES',
		'APP_DEPENDENCY_BACKUP_STATE_MESSAGE_KEY_PREFIX',
		'APP_DEPENDENCY_READY_DEADLINE_MS',
		'APP_DEPENDENCY_EXTERNAL_TEST_MS',
		'APP_DEPENDENCY_DEFAULT_SIZE_GIB',
		'APP_DEPENDENCY_TRANSIENT_ATTEMPTS',
		'APP_DEPENDENCY_RETRY_DELAY_MS',
		'APP_DEPENDENCY_REFRESH_AFTER_MS',
		'APP_DEPENDENCY_BACKUP_OVERDUE_MS',
		'APP_DEPENDENCY_RELAY_DAILY_LIMIT',
		'APP_DEPENDENCY_MANAGED',
		'appDependencyReasonMessageKey',
		'appDependencyStatusMessageKey',
		'appDependencyBackupStateMessageKey'
	];

	it('surfaces every runtime name of this module on the apps barrel and at the root', () => {
		for (const name of RUNTIME_EXPORTS) {
			expect(name in appsBarrel, `${name} must be on the apps barrel`).toBe(true);
			expect(name in packageRoot, `${name} must be at the package root`).toBe(true);
		}
	});

	it('resolves the same bindings — not copies — from the package root', () => {
		expect(packageRoot.APP_DEPENDENCY_OUTPUTS).toBe(APP_DEPENDENCY_OUTPUTS);
		expect(packageRoot.APP_DEPENDENCY_STATUSES).toBe(APP_DEPENDENCY_STATUSES);
		expect(packageRoot.APP_DEPENDENCY_REASONS).toBe(APP_DEPENDENCY_REASONS);
		expect(packageRoot.APP_DEPENDENCY_MANAGED).toBe(APP_DEPENDENCY_MANAGED);
		expect(packageRoot.appDependencyReasonMessageKey).toBe(appDependencyReasonMessageKey);
		expect(packageRoot.appDependencyReasonMessageKey('deadlineExceeded')).toBe(
			'dashboard.workDetail.appDependencies.reasons.deadlineExceeded'
		);
	});

	it('resolves this module’s TYPES from the package root too, not only the values', () => {
		const view: packageRoot.AppDependencyView = FIXTURE_SHAPE;
		const kind: packageRoot.AppDependencyKind = 'objectStorage';
		const code: packageRoot.AppDependencyErrorCode = 'sizeShrinkRefused';
		expect(view.kind).toBe('postgres');
		expect(kind).toBe('objectStorage');
		expect(code).toBe('sizeShrinkRefused');
	});
});

/** One card, reused by the root-type assertions above. */
const FIXTURE_SHAPE: AppDependencyView = {
	kind: 'postgres',
	declared: true,
	provider: { pluginId: 'k8s', providerId: 'k8s-inline-postgres', label: 'In your cluster' },
	availableProviders: [],
	status: 'provisioning',
	statusReason: 'clusterUnreachable',
	statusDetail: null,
	awaitingConfig: false,
	actualVersion: null,
	sizeGiB: 10,
	backup: { policy: 'none', state: 'unknown', lastBackupAt: null, checkedAt: null },
	inSpec: true,
	keptResources: null,
	outputs: [{ name: 'url', secret: true }],
	lastProvisionedAt: null,
	lastCheckedAt: null
};

/**
 * plan §8:913, verbatim and in order, then APW07-G28's two appended members —
 * the reason vocabulary, restated from the plan.
 */
const SPEC_REASONS = [
	'noDefaultStorageClass',
	'clusterUnreachable',
	'smtpConnectFailed',
	'smtpTlsFailed',
	'smtpAuthRefused',
	'bucketUnreadable',
	'volumeNotReady',
	'extensionUnavailable',
	'platformServerRefused',
	'deadlineExceeded',
	'namespaceNotOwned',
	'namespaceBaselineMissing',
	'clusterPermissionMissing',
	'operatorNamespaceUnknown',
	'volumeExpansionUnsupported',
	'sizeShrinkRefused',
	'relayIneligible',
	'relaySuspended',
	'providerNotSupported',
	'dependencyNotDeclared',
	'confirmationMismatch',
	'deleteInProgress',
	'notGenerated',
	'notAppWork',
	// APW07-G28: APW-06's `AppRuntimeTargetUnavailable.target_none` and
	// `.target_not_checked`, which had no card member and so read back as `null`.
	'targetNone',
	'targetNotChecked'
] as const;

/** `SPEC_REASONS` exactly as plan §8:913 writes it — the twenty-four, unextended. */
const SPEC_PLAN_REASONS = SPEC_REASONS.slice(0, 24);

/** plan §5:798-802 — the codes the API answers with, restated from the plan. */
const SPEC_ERROR_CODES = [
	'volumeExpansionUnsupported',
	'sizeShrinkRefused',
	'providerNotSupported',
	'dependencyNotDeclared',
	'confirmationMismatch',
	'deleteInProgress',
	'notGenerated',
	'notAppWork'
] as const;

/** plan §8:913 minus plan §5:798-802 — the reasons a card shows for a failed attempt. */
const SPEC_STATUS_REASONS = SPEC_REASONS.filter((reason) => !(SPEC_ERROR_CODES as readonly string[]).includes(reason));

const HERE = dirname(fileURLToPath(import.meta.url));
const EN_JSON = resolve(HERE, '../../../../../apps/web/messages/en.json');

function readEnglishMessages(): Record<string, unknown> {
	try {
		return JSON.parse(readFileSync(EN_JSON, 'utf8')) as Record<string, unknown>;
	} catch (error) {
		throw new Error(
			`Could not read the English messages at ${EN_JSON}. If it moved, update this test's path — do not delete the test. ` +
				`Original error: ${(error as Error).message}`
		);
	}
}

/** The leaf at `a.b.c`, or `undefined` — never a throw, so the assertion reports the key. */
function leafAt(messages: Record<string, unknown>, path: string): unknown {
	return path.split('.').reduce<unknown>((node, segment) => {
		if (node === null || typeof node !== 'object') return undefined;
		return (node as Record<string, unknown>)[segment];
	}, messages);
}
