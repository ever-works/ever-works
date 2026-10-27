/**
 * Cloud computers (FL-17, CONTRACTS R-15, R-20, R-35, R-36, §4.1, §10) — the
 * wire contract every surface shares: the web dialog and Cloud block, the API,
 * the Agent tools, MCP and the CLI.
 *
 * A cloud computer is a Node Ever Works created for its owner at a cloud
 * provider, through a `machine-provider` plugin, with the price shown before
 * Create. The machine enrols itself with a one-time token baked into the
 * platform's bootstrap and is then an ordinary Node (`origin: 'cloud'`). The
 * row keeps what the provider machine IS and what it COSTS in
 * `providerMeta` ({@link FleetCloudMeta}) — never a token, a password or a key.
 *
 * Money is integer-ish **cents** of the provider's currency (USD by default),
 * from the provider's LIST prices: every figure is an estimate and is labelled
 * so ("your bill may differ"). Cloud spend never enters model-spend Budgets or
 * the fleet model-cost ceiling (spec FR-24): different money, different cap.
 */

import type { FleetConfirmationClass } from './fleet-machine-actions.types.js';
import type { FleetNodeView } from './fleet-node.types.js';

// ─── Limits (CONTRACTS §10) and timings ─────────────────────────────────────

/** Cloud computers one owner may have at once (spec FR-12, U10). The eleventh is `limit_exceeded`. */
export const FLEET_CLOUD_MAX_PER_OWNER = 10;

/** CPU under this percentage in every health sample of the window counts as idle (spec FR-26, P2). */
export const FLEET_CLOUD_IDLE_CPU_PERCENT = 5;

/** A machine the provider runs that has not heartbeated this long after Create raises the item (FR-11). */
export const FLEET_CLOUD_UNENROLLED_AFTER_MIN = 10;

/** Provider options are cached per provider + owner this long (plan §5). */
export const FLEET_CLOUD_OPTIONS_CACHE_MS = 10 * 60 * 1000;

/** At most this many power transitions are kept per machine (the cost model reads them). */
export const FLEET_CLOUD_MAX_POWER_TIMELINE = 200;

/** Reconciliation cadence (FR-29: at least hourly) — minute 17 of every hour. */
export const FLEET_CLOUD_RECONCILE_CRON = '17 * * * *';

/** The never-came-online watch (plan §10) — every minute. */
export const FLEET_CLOUD_BOOTSTRAP_WATCH_CRON = '* * * * *';

/** Cost refresh (FR-21: at least every 10 minutes) — P2's `fleet-cloud-usage` job. */
export const FLEET_CLOUD_USAGE_CRON = '*/10 * * * *';

/** Idle policy evaluation (FR-27: at least every 10 minutes, offset 5) — P2's `fleet-cloud-idle` job. */
export const FLEET_CLOUD_IDLE_CRON = '5-55/10 * * * *';

/** The tag every machine carries at its provider, and the prefix of the per-Node tag (spec FR-10). */
export const FLEET_CLOUD_TAG = 'ever-works';
export const FLEET_CLOUD_NODE_TAG_PREFIX = 'ever-works-node:';

/** The per-Node provider tag (`ever-works-node:<nodeId>`) reconciliation recognises a machine by. */
export function fleetCloudNodeTag(nodeId: string): string {
	return `${FLEET_CLOUD_NODE_TAG_PREFIX}${nodeId}`;
}

/**
 * P3 (spec FR-30, U7) — the tag naming the Ever Works deployment that created
 * a machine (`ever-works-site:<fingerprint>`, a short hash of its API origin).
 * Reconciliation adopts an unclaimed machine ONLY when it carries this
 * deployment's site tag: another deployment's machines on the same provider
 * account are never touched.
 */
export const FLEET_CLOUD_SITE_TAG_PREFIX = 'ever-works-site:';

export function fleetCloudSiteTag(fingerprint: string): string {
	return `${FLEET_CLOUD_SITE_TAG_PREFIX}${fingerprint}`;
}

/** The site fingerprint inside a provider tag list, or null. */
export function fleetCloudSiteFromTags(tags: readonly string[] | null | undefined): string | null {
	for (const tag of tags ?? []) {
		if (typeof tag === 'string' && tag.startsWith(FLEET_CLOUD_SITE_TAG_PREFIX)) {
			const value = tag.slice(FLEET_CLOUD_SITE_TAG_PREFIX.length).trim().toLowerCase();
			if (/^[0-9a-f]{8,64}$/.test(value)) return value;
		}
	}
	return null;
}

/** The Node id inside a provider tag list, or null. */
export function fleetCloudNodeIdFromTags(tags: readonly string[] | null | undefined): string | null {
	for (const tag of tags ?? []) {
		if (typeof tag === 'string' && tag.startsWith(FLEET_CLOUD_NODE_TAG_PREFIX)) {
			const id = tag.slice(FLEET_CLOUD_NODE_TAG_PREFIX.length).trim();
			if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return id.toLowerCase();
		}
	}
	return null;
}

// ─── Names ──────────────────────────────────────────────────────────────────

/** A cloud computer's name (spec FR-13) — also the machine's name at the provider. */
export const FLEET_CLOUD_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}$/;

export function isFleetCloudName(value: unknown): value is string {
	return typeof value === 'string' && FLEET_CLOUD_NAME_PATTERN.test(value);
}

// ─── Software presets (spec FR-3) ───────────────────────────────────────────

export type FleetCloudSoftwareId = 'docker' | 'node' | 'claude-code' | 'codex' | 'overlay-vpn';

export const FLEET_CLOUD_SOFTWARE_IDS: readonly FleetCloudSoftwareId[] = [
	'docker',
	'node',
	'claude-code',
	'codex',
	'overlay-vpn'
];

/** Ticked by default in the dialog (spec FR-3). The overlay-VPN client is opt-in. */
export const FLEET_CLOUD_DEFAULT_SOFTWARE: readonly FleetCloudSoftwareId[] = ['docker', 'node', 'claude-code', 'codex'];

export function isFleetCloudSoftwareId(value: unknown): value is FleetCloudSoftwareId {
	return typeof value === 'string' && (FLEET_CLOUD_SOFTWARE_IDS as readonly string[]).includes(value);
}

/** The software list a request names, deduplicated and in canonical order; unknown ids dropped. */
export function normalizeFleetCloudSoftware(value: unknown): FleetCloudSoftwareId[] {
	if (!Array.isArray(value)) return [...FLEET_CLOUD_DEFAULT_SOFTWARE];
	const wanted = new Set(value.filter(isFleetCloudSoftwareId));
	return FLEET_CLOUD_SOFTWARE_IDS.filter((id) => wanted.has(id));
}

// ─── Idle policy (spec FR-25, P2) ───────────────────────────────────────────

export type FleetCloudIdlePolicyMode = 'nothing' | 'tell-me' | 'power-off';

export const FLEET_CLOUD_IDLE_POLICY_MODES: readonly FleetCloudIdlePolicyMode[] = ['nothing', 'tell-me', 'power-off'];

export interface FleetCloudIdlePolicy {
	mode: FleetCloudIdlePolicyMode;
	/** 1–72 hours of idleness before the policy acts. */
	afterHours: number;
}

export const FLEET_CLOUD_IDLE_MIN_HOURS = 1;
export const FLEET_CLOUD_IDLE_MAX_HOURS = 72;

/** Every cloud computer starts with "Tell me after 3 hours" (spec S6, FR-25). */
export const FLEET_CLOUD_DEFAULT_IDLE_POLICY: Readonly<FleetCloudIdlePolicy> = { mode: 'tell-me', afterHours: 3 };

export function isFleetCloudIdlePolicyMode(value: unknown): value is FleetCloudIdlePolicyMode {
	return typeof value === 'string' && (FLEET_CLOUD_IDLE_POLICY_MODES as readonly string[]).includes(value);
}

/** Clamp an hours value to 1–72 (a whole number); a non-number answers the default 3. */
export function clampFleetCloudIdleHours(value: unknown): number {
	const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
	if (!Number.isFinite(n)) return FLEET_CLOUD_DEFAULT_IDLE_POLICY.afterHours;
	return Math.min(FLEET_CLOUD_IDLE_MAX_HOURS, Math.max(FLEET_CLOUD_IDLE_MIN_HOURS, Math.round(n)));
}

/** A stored or requested policy, made valid: an unknown mode is the default, the hours clamped. */
export function normalizeFleetCloudIdlePolicy(value: unknown): FleetCloudIdlePolicy {
	const raw = (value && typeof value === 'object' ? value : {}) as { mode?: unknown; afterHours?: unknown };
	return {
		mode: isFleetCloudIdlePolicyMode(raw.mode) ? raw.mode : FLEET_CLOUD_DEFAULT_IDLE_POLICY.mode,
		afterHours: clampFleetCloudIdleHours(raw.afterHours)
	};
}

// ─── The stored provider facts (`fleet_nodes.providerMeta`, CONTRACTS §4.1) ─

/**
 * Where the create is (spec §5.2): the platform asked the provider
 * (`asking-provider`), the provider is booting the machine (`booting`), its
 * first-boot script is installing (`installing`), it is enrolling
 * (`enrolling`), it heartbeated (`online`) — or the provider refused
 * (`failed`, the provider's first message in `error`).
 */
export type FleetCloudPhase = 'asking-provider' | 'booting' | 'installing' | 'enrolling' | 'online' | 'failed';

export const FLEET_CLOUD_PHASES: readonly FleetCloudPhase[] = [
	'asking-provider',
	'booting',
	'installing',
	'enrolling',
	'online',
	'failed'
];

export function isFleetCloudPhase(value: unknown): value is FleetCloudPhase {
	return typeof value === 'string' && (FLEET_CLOUD_PHASES as readonly string[]).includes(value);
}

/**
 * The machine's power at its provider, as the platform last knew it:
 * `provisioning` (created, not yet running), `running`, `off`, `gone` (the
 * provider no longer knows it — it stopped billing; Remove becomes available,
 * R-36) or `unknown` (never asked, or the provider could not be read).
 */
export type FleetCloudPowerState = 'provisioning' | 'running' | 'off' | 'gone' | 'unknown';

export const FLEET_CLOUD_POWER_STATES: readonly FleetCloudPowerState[] = [
	'provisioning',
	'running',
	'off',
	'gone',
	'unknown'
];

export function isFleetCloudPowerState(value: unknown): value is FleetCloudPowerState {
	return typeof value === 'string' && (FLEET_CLOUD_POWER_STATES as readonly string[]).includes(value);
}

/** An act the provider has accepted but not yet confirmed (spec FR-16, FR-17, FR-18). */
export type FleetCloudPending = 'powering-off' | 'starting' | 'destroying';

export function isFleetCloudPending(value: unknown): value is FleetCloudPending {
	return value === 'powering-off' || value === 'starting' || value === 'destroying';
}

/** One power transition, for the cost model (a provider that bills only while running). */
export interface FleetCloudPowerEvent {
	state: 'running' | 'off' | 'gone';
	/** ISO-8601. */
	at: string;
}

/** The last computed cost (P2's job refreshes it; P1 computes it on read). */
export interface FleetCloudCostSnapshot {
	/** What the machine bills per hour right now (0 when off at a provider that does not bill off, or gone). */
	hourlyCents: number;
	monthToDateCents: number;
	sinceCreatedCents: number;
	projectedMonthCents: number;
	/** The provider's own account-wide month-to-date figure, when the plugin can read it (FR-23). */
	providerMonthToDateCents?: number | null;
	/** ISO-8601 instant the snapshot was computed. */
	computedAt: string;
}

/**
 * `fleet_nodes.providerMeta` (CONTRACTS §4.1): region, size, rate, created at,
 * the power timeline, the idle policy and the cost snapshot. No secrets, ever:
 * no token, no password, no key, no VPN auth key.
 */
export interface FleetCloudMeta {
	/** The provider's display name, kept so the row still reads right if the plugin is disabled (U5). */
	providerName: string;
	regionId: string;
	regionLabel: string;
	sizeId: string;
	sizeLabel: string;
	vcpus: number;
	memoryMiB: number;
	diskGiB: number;
	/** List price per hour in cents (may be fractional: 3.571 = $0.03571/h). */
	hourlyRateCents: number;
	/** List price per month in cents — the most one month of use costs. */
	monthlyPriceCents: number;
	/** ISO-4217 (default `USD`). */
	currency: string;
	/** True when the provider bills a powered-off machine (spec FR-16). */
	billsWhileOff: boolean;
	/** What the provider boots (`Ubuntu 24.04 LTS`), for the block. */
	imageLabel?: string | null;
	/** When the registration was written (ISO-8601) — before the provider was asked (FR-7). */
	createdAt: string;
	/** When the provider accepted the create (ISO-8601) — billing starts here. Null until then. */
	machineCreatedAt: string | null;
	phase: FleetCloudPhase;
	phaseAt: string;
	powerState: FleetCloudPowerState;
	powerStateAt: string;
	pending: FleetCloudPending | null;
	/** The power transitions, oldest first, at most {@link FLEET_CLOUD_MAX_POWER_TIMELINE}. */
	powerTimeline: FleetCloudPowerEvent[];
	/** The provider's first message when it refused (U2), one line, never a secret. */
	error: string | null;
	idlePolicy: FleetCloudIdlePolicy;
	/** Start of the current idle window (P2), or null. */
	idleSince?: string | null;
	cost?: FleetCloudCostSnapshot | null;
	/** When the provider confirmed the machine deleted (destroy) — cost stops here. */
	destroyedAt?: string | null;
	/** The cost recorded at destroy (FR-18, audited). */
	finalCostCents?: number | null;
	/** When reconciliation found the machine gone at the provider (U6) — cost stops here. */
	goneAt?: string | null;
	/** The software the bootstrap installed (ids only). */
	software: FleetCloudSoftwareId[];
	/** The tags the machine carries at its provider. */
	tags: string[];
	/** Public IPv4 address, when the provider reported one — shown, never connected to (D2). */
	ipv4?: string | null;
	/** When the last "never came online" item was raised for this machine (deduplication). */
	unenrolledNoticeAt?: string | null;
	/**
	 * P2 (spec FR-27) — the attention key of the idle window the policy already
	 * acted on (`fleet-node:<id>:cloud-idle:<windowStart>`): exactly one item,
	 * one Inbox notice and at most one power-off per window.
	 */
	idleNotifiedKey?: string | null;
	/** P2 (spec S7) — when the idle policy powered the machine off; cleared when it runs again. */
	poweredOffByPolicyAt?: string | null;
	/**
	 * P3 (spec FR-30, U7) — when reconciliation found this machine at the
	 * provider carrying this deployment's tags with no registration and adopted
	 * it as this row, so its owner sees it (and its bill) and can destroy it.
	 */
	unclaimedAt?: string | null;
}

// ─── Money ──────────────────────────────────────────────────────────────────

/** `$24`, `$2.84`, `$0.036` — a cents figure in the provider's currency, for copy. */
export function formatFleetCloudMoney(cents: number, options: { currency?: string; perHour?: boolean } = {}): string {
	const currency = (options.currency ?? 'USD').toUpperCase();
	const symbol = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : `${currency} `;
	const value = Number.isFinite(cents) ? cents / 100 : 0;
	if (options.perHour) {
		// Hourly rates are small: three decimals ($0.036), never rounded to $0.04.
		return `${symbol}${value.toFixed(value >= 1 ? 2 : 3)}`;
	}
	if (Math.abs(value - Math.round(value)) < 0.005 && value >= 1) return `${symbol}${Math.round(value)}`;
	return `${symbol}${value.toFixed(2)}`;
}

// ─── Cost model (spec FR-21, FR-22) ─────────────────────────────────────────

const HOUR_MS = 60 * 60 * 1000;

function parseMs(value: string | null | undefined): number {
	const ms = value ? Date.parse(value) : NaN;
	return Number.isFinite(ms) ? ms : NaN;
}

/** UTC start of the calendar month containing `ms`. */
export function fleetCloudMonthStartMs(ms: number): number {
	const d = new Date(ms);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** UTC start of the next calendar month after the one containing `ms`. */
export function fleetCloudNextMonthStartMs(ms: number): number {
	const d = new Date(ms);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/**
 * The intervals the machine billed in, up to `untilMs`: from the provider's
 * create (or, before it answered, nothing) to its destruction / disappearance.
 * A provider that bills powered-off machines bills the whole lifetime; one
 * that does not bills only the `running` stretches of the power timeline.
 */
export function fleetCloudBilledIntervals(meta: FleetCloudMeta, untilMs: number): Array<[number, number]> {
	const start = parseMs(meta.machineCreatedAt);
	if (!Number.isFinite(start)) return [];
	let end = untilMs;
	const destroyed = parseMs(meta.destroyedAt ?? null);
	const gone = parseMs(meta.goneAt ?? null);
	if (Number.isFinite(destroyed)) end = Math.min(end, destroyed);
	if (Number.isFinite(gone)) end = Math.min(end, gone);
	if (end <= start) return [];
	if (meta.billsWhileOff) return [[start, end]];
	const events = [...(meta.powerTimeline ?? [])]
		.map((event) => ({ state: event.state, at: parseMs(event.at) }))
		.filter((event) => Number.isFinite(event.at))
		.sort((a, b) => a.at - b.at);
	const out: Array<[number, number]> = [];
	let billingFrom: number | null = start;
	for (const event of events) {
		if (event.at <= start) {
			billingFrom = event.state === 'running' ? start : null;
			continue;
		}
		if (event.at >= end) break;
		if (event.state === 'running') {
			if (billingFrom === null) billingFrom = event.at;
		} else if (billingFrom !== null) {
			out.push([billingFrom, event.at]);
			billingFrom = null;
		}
	}
	if (billingFrom !== null && billingFrom < end) out.push([billingFrom, end]);
	return out;
}

/** True when the machine is billing at `nowMs` (it exists and, at a provider that bills only while running, runs). */
export function fleetCloudIsBilling(meta: FleetCloudMeta, nowMs: number): boolean {
	const intervals = fleetCloudBilledIntervals(meta, nowMs + 1);
	const last = intervals[intervals.length - 1];
	return Boolean(last) && last[1] >= nowMs && meta.powerState !== 'gone' && !meta.destroyedAt;
}

/**
 * The machine's cost, per second, capped at the monthly price in every
 * calendar month (UTC) — the first provider's billing rule (FR-21):
 *
 *  - `sinceCreatedCents` — every month of its life, each capped;
 *  - `monthToDateCents` — this month so far (a machine destroyed this month
 *    still counts what it cost, FR-22);
 *  - `projectedMonthCents` — this month if it stays as it is until month end,
 *    capped at the monthly price;
 *  - `hourlyCents` — what it bills per hour right now.
 */
export function fleetCloudCost(
	meta: FleetCloudMeta,
	nowMs: number = Date.now()
): Omit<FleetCloudCostSnapshot, 'computedAt'> {
	const rate = Number.isFinite(meta.hourlyRateCents) && meta.hourlyRateCents > 0 ? meta.hourlyRateCents : 0;
	const cap =
		Number.isFinite(meta.monthlyPriceCents) && meta.monthlyPriceCents > 0 ? meta.monthlyPriceCents : Infinity;
	const perMonth = new Map<number, number>();
	for (const [from, to] of fleetCloudBilledIntervals(meta, nowMs)) {
		let cursor = from;
		while (cursor < to) {
			const monthEnd = Math.min(to, fleetCloudNextMonthStartMs(cursor));
			const month = fleetCloudMonthStartMs(cursor);
			perMonth.set(month, (perMonth.get(month) ?? 0) + ((monthEnd - cursor) / HOUR_MS) * rate);
			cursor = monthEnd;
		}
	}
	let sinceCreated = 0;
	for (const cents of perMonth.values()) sinceCreated += Math.min(cap, cents);
	const thisMonth = fleetCloudMonthStartMs(nowMs);
	const monthToDate = Math.min(cap, perMonth.get(thisMonth) ?? 0);
	const billing = fleetCloudIsBilling(meta, nowMs);
	const remainingHours = (fleetCloudNextMonthStartMs(nowMs) - nowMs) / HOUR_MS;
	const projected = Math.min(cap, monthToDate + (billing ? remainingHours * rate : 0));
	return {
		hourlyCents: billing ? rate : 0,
		monthToDateCents: round2(monthToDate),
		sinceCreatedCents: round2(sinceCreated),
		projectedMonthCents: round2(projected)
	};
}

function round2(value: number): number {
	return Math.round(value * 100) / 100;
}

// ─── Remove from Fleet (CONTRACTS R-36, spec FR-19) ─────────────────────────

/**
 * Whether "Remove from Fleet" may delete a cloud computer's registration now:
 * only when no billing machine can be left behind — the provider reported it
 * gone (U6) or the create failed before any machine existed (U2). Anything
 * else is refused `unsupported_on_node` ("destroy it instead").
 */
export function fleetCloudRemovable(input: {
	hasMachine: boolean;
	meta: Pick<FleetCloudMeta, 'powerState' | 'phase'> | null | undefined;
}): boolean {
	const meta = input.meta;
	if (!meta) return !input.hasMachine;
	if (meta.powerState === 'gone') return true;
	return !input.hasMachine && meta.phase === 'failed';
}

/** The hint every surface shows with the R-36 refusal. */
export const FLEET_CLOUD_REMOVE_HINT = 'destroy it instead; it bills until destroyed';

// ─── Confirmation classes and summaries (CONTRACTS §2.2, spec §4.1) ─────────

export const FLEET_CLOUD_ACTION_CLASS: Readonly<
	Record<'create' | 'power-on' | 'power-off' | 'destroy' | 'idle-policy' | 'retry-enrollment', FleetConfirmationClass>
> = {
	create: 'confirm',
	'power-on': 'confirm',
	'power-off': 'confirm',
	destroy: 'confirm-destructive',
	'idle-policy': 'plain',
	'retry-enrollment': 'plain'
};

export type FleetCloudPowerAction = 'on' | 'off';

export function isFleetCloudPowerAction(value: unknown): value is FleetCloudPowerAction {
	return value === 'on' || value === 'off';
}

interface PriceFacts {
	providerName: string;
	monthlyPriceCents: number;
	hourlyRateCents: number;
	billsWhileOff: boolean;
	currency?: string;
}

/**
 * The price sentence the dialog shows before Create and the 409
 * `confirmation_required` carries as its summary (spec §0, FR-6).
 */
export function fleetCloudPriceSentence(facts: PriceFacts): string {
	const month = formatFleetCloudMoney(facts.monthlyPriceCents, { currency: facts.currency });
	const hour = formatFleetCloudMoney(facts.hourlyRateCents, { currency: facts.currency, perHour: true });
	const whileOff = facts.billsWhileOff ? ' — also while powered off' : '';
	return (
		`About ${month}/month (${hour}/hour), billed by ${facts.providerName} to your account from the moment it exists ` +
		`until you destroy it${whileOff}. Ever Works stores no password or key for this machine; it enrols itself as its own computer.`
	);
}

/** The Agent's Decision text for a held create (spec S9, FR-34). */
export function fleetCloudCreateSummary(
	facts: PriceFacts & { name: string; regionId: string; vcpus: number; memoryMiB: number }
): string {
	const month = formatFleetCloudMoney(facts.monthlyPriceCents, { currency: facts.currency });
	const hour = formatFleetCloudMoney(facts.hourlyRateCents, { currency: facts.currency, perHour: true });
	const memory = facts.memoryMiB >= 1024 ? `${Math.round(facts.memoryMiB / 1024)} GB` : `${facts.memoryMiB} MB`;
	return (
		`Creates ${facts.name}, a ${facts.vcpus} CPU · ${memory} cloud computer at ${facts.providerName} (${facts.regionId}) ` +
		`for about ${month}/month (${hour}/hour), billed to your ${facts.providerName} account until destroyed.`
	);
}

/** The Power off confirmation (spec §5.4, FR-16). */
export function fleetCloudPowerOffSummary(name: string, providerName: string, billsWhileOff: boolean): string {
	return billsWhileOff
		? `Power off ${name}? ${providerName} still bills this size while it is off. Sessions on it end.`
		: `Power off ${name}? Sessions on it end.`;
}

/** The Destroy confirmation, with the cost so far and the creation date (spec S4, FR-18). */
export function fleetCloudDestroySummary(input: {
	name: string;
	providerName: string;
	costSoFarCents: number;
	createdAt: string | null;
	currency?: string;
}): string {
	const cost = formatFleetCloudMoney(input.costSoFarCents, { currency: input.currency });
	const since = input.createdAt ? ` since ${input.createdAt.slice(0, 10)}` : '';
	return (
		`Destroy ${input.name}? It has cost ${cost}${since}. The machine and its disk are deleted at ` +
		`${input.providerName}; this cannot be undone.`
	);
}

// ─── Wire shapes ────────────────────────────────────────────────────────────

/** One machine provider in the dialog's picker (`GET /api/fleet/providers`). */
export interface FleetCloudProviderView {
	/** The plugin id — the only place a provider is named on the wire. */
	pluginId: string;
	/** The plugin's display name. */
	name: string;
	/** The provider's display name, as its plugin states it. */
	providerName: string;
	/** True when a token is saved or a sign-in completed (spec FR-2). */
	configured: boolean;
	/** The connected account's label, when the provider could be read. */
	account: string | null;
	/** True when "Sign in with <provider>" is available (P3, the operator registered an app). */
	oauthAvailable: boolean;
}

export interface FleetCloudProvidersView {
	providers: FleetCloudProviderView[];
}

export interface FleetCloudRegionView {
	id: string;
	label: string;
	available: boolean;
}

export interface FleetCloudSizeView {
	id: string;
	label: string;
	vcpus: number;
	memoryMiB: number;
	diskGiB: number;
	priceHourlyCents: number;
	priceMonthlyCents: number;
	regions: string[];
	available: boolean;
}

/** `GET /api/fleet/providers/:plugin/options` — fresh list prices (spec FR-3, FR-4). */
export interface FleetCloudOptionsView {
	pluginId: string;
	providerName: string;
	regions: FleetCloudRegionView[];
	sizes: FleetCloudSizeView[];
	software: Array<{ id: FleetCloudSoftwareId; default: boolean }>;
	billsWhileOff: boolean;
	currency: string;
	account: { label: string };
	imageLabel: string | null;
	/** ISO-8601 instant the provider was read (the cache may serve it for 10 minutes). */
	fetchedAt: string;
	/** The owner's cloud computers and the cap (spec FR-12). */
	limits: { maxPerOwner: number; used: number };
}

/** `POST /api/fleet/cloud` (spec FR-7, FR-34). */
export interface FleetCloudCreateRequest {
	providerPluginId: string;
	name: string;
	regionId: string;
	sizeId: string;
	software?: FleetCloudSoftwareId[];
	/** The monthly price (cents) the caller was shown — refused `invalid` when it no longer matches (FR-4). */
	acknowledgedPriceCents: number;
	/** CONTRACTS §2.2 — the price sentence was seen. */
	confirm?: boolean;
	/** P3: the overlay-VPN client's one-time auth key — passed into the bootstrap only, never stored. */
	vpnAuthKey?: string;
}

/** Create answers 202 with the new Node and the operation id (spec FR-7). */
export interface FleetCloudCreateResponse {
	nodeId: string;
	/** The operation that tracks the create (the Node id: the row carries the phase). */
	operationId: string;
}

export interface FleetCloudPowerRequest {
	action: FleetCloudPowerAction;
	confirm?: boolean;
}

export interface FleetCloudDestroyRequest {
	/** CONTRACTS §2.2 `confirm-destructive` — the machine's exact name. */
	confirmName?: string;
}

/** A power / destroy / retry answers 202 with the operation id; destroy adds the cost so far. */
export interface FleetCloudOperationResponse {
	operationId: string;
	costSoFarCents?: number;
}

/**
 * The Cloud block on a computer's Overview (spec FR-15, §5.3) — what
 * `FleetNodeView.cloud` carries for a cloud computer, owner and shared views
 * alike (it carries prices and states, never a credential).
 */
export interface FleetNodeCloudView {
	providerPluginId: string;
	providerName: string;
	regionId: string;
	regionLabel: string;
	sizeId: string;
	sizeLabel: string;
	vcpus: number;
	memoryMiB: number;
	diskGiB: number;
	hourlyRateCents: number;
	monthlyPriceCents: number;
	currency: string;
	billsWhileOff: boolean;
	imageLabel: string | null;
	createdAt: string;
	machineCreatedAt: string | null;
	phase: FleetCloudPhase;
	phaseAt: string;
	powerState: FleetCloudPowerState;
	powerStateAt: string;
	pending: FleetCloudPending | null;
	error: string | null;
	ipv4: string | null;
	software: FleetCloudSoftwareId[];
	idlePolicy: FleetCloudIdlePolicy;
	idleSince: string | null;
	cost: FleetCloudCostSnapshot;
	goneAt: string | null;
	/** P2 (spec S6): the idle window has reached the policy's hours (and the policy is not `nothing`). */
	idleWindowReached?: boolean;
	/** P2 (spec S7): when the idle policy powered it off (still billing while off where the provider does). */
	poweredOffByPolicyAt?: string | null;
	/** P3 (spec FR-30, U7): when reconciliation adopted it as an unclaimed machine (no Ever Works computer created it here). */
	unclaimedAt?: string | null;
	/** True when a machine exists (or existed) at the provider. */
	hasMachine: boolean;
	/** CONTRACTS R-36: whether "Remove from Fleet" may run now. */
	removable: boolean;
}

/** One row of the Cloud computers usage block (spec FR-23, §5.7). */
export interface FleetCloudUsageRow {
	nodeId: string;
	name: string;
	providerName: string;
	regionId: string;
	sizeLabel: string;
	hourlyCents: number;
	monthToDateCents: number;
	sinceCreatedCents: number;
	state: FleetCloudPowerState;
	/** ISO-8601 when it was destroyed this month (it still counts toward this month). */
	destroyedAt: string | null;
}

/**
 * P2 (spec FR-23) — the provider's OWN month-to-date figure for the owner's
 * whole account at that provider, where its plugin can read it. Shown beside
 * the estimate and labelled as the provider's; never added to the estimate
 * (it covers everything on the account, not only Ever Works machines).
 */
export interface FleetCloudProviderMonthToDate {
	providerPluginId: string;
	providerName: string;
	monthToDateCents: number;
	/** ISO-8601 instant the cost job read it. */
	computedAt: string;
}

/** `GET /api/fleet/cloud/usage` and the `usage` of `GET /api/fleet/cloud` (spec S8, FR-23). */
export interface FleetCloudUsageView {
	hourlyCents: number;
	monthToDateCents: number;
	projectedMonthCents: number;
	currency: string;
	/** Always true: every figure is an estimate from list prices. */
	estimate: true;
	machines: FleetCloudUsageRow[];
	computedAt: string;
	/** P2 (FR-23): the providers' own month-to-date figures for the caller's accounts, when readable. */
	providerMonthToDate?: FleetCloudProviderMonthToDate[];
}

/** P2 (spec FR-21): a cost snapshot younger than this is not recomputed (two overlapping fires write once). */
export const FLEET_CLOUD_USAGE_FRESH_MS = 5 * 60 * 1000;

/** `GET /api/fleet/cloud` — the caller's cloud computers and their usage. */
export interface FleetCloudListView {
	machines: FleetNodeView[];
	usage: FleetCloudUsageView;
}

// ─── Idle policy, P2 (spec FR-25 – FR-28) ───────────────────────────────────

/** `requestedBy` of the audit rows reconciliation writes when it repairs or adopts a machine (CONTRACTS §2.3). */
export const FLEET_CLOUD_RECONCILE_REQUESTER = 'system:cloud-reconcile';

/** `requestedBy` of the audit row the idle policy writes when it powers a machine off (CONTRACTS §2.3). */
export const FLEET_CLOUD_IDLE_REQUESTER = 'system:idle-policy';

/** The attention key one idle window is deduplicated on (spec FR-27). */
export function fleetCloudIdleAttentionKey(nodeId: string, windowStart: string): string {
	return `fleet-node:${nodeId}:cloud-idle:${windowStart}`;
}

/** Session states that keep a machine busy (spec FR-26: no Session in `working` or `needs_you`). */
export const FLEET_CLOUD_BUSY_SESSION_STATES: readonly string[] = ['starting', 'working', 'needs_you'];

/** `PUT` / `PATCH /api/fleet/cloud/:id/idle-policy` (spec FR-25). */
export interface FleetCloudIdlePolicyRequest {
	mode: FleetCloudIdlePolicyMode;
	afterHours: number;
}

/** "Idle for 4 h", in hours, from the window start — or null when not idle. */
export function fleetCloudIdleHours(idleSince: string | null | undefined, nowMs: number = Date.now()): number | null {
	const at = idleSince ? Date.parse(idleSince) : NaN;
	if (!Number.isFinite(at) || nowMs < at) return null;
	return Math.floor((nowMs - at) / HOUR_MS);
}
