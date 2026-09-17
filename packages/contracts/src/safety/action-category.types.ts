import type { TrustRung } from './trust-rung.types.js';

/**
 * Safety rails (AW-24) — the closed taxonomy of what an Agent can do.
 *
 * Ever Works already refuses things: a merge into a protected branch, a tool
 * call the grant matrix does not allow, a run above a budget ceiling, a
 * dispatch while the platform stop flag is set. Every one of those refusals
 * is real and enforced in the platform — but each speaks its own vocabulary,
 * so an owner cannot reason about the whole.
 *
 * This file is that shared vocabulary: **thirteen kinds of work**, and
 * nothing else. Every side-effectful action the platform can take classifies
 * into exactly one of them (FR-1, FR-6). The list is closed — adding to it is
 * a spec change, not a code change — and it is published as a constant so the
 * screen, the API and the docs cannot drift (NFR-10).
 *
 * Pure and dependency-free, like `policy/tool-grant.types.ts` next door.
 */

/** The thirteen kinds of work. Closed list. */
export type ActionCategory =
	| 'read.internal'
	| 'read.external'
	| 'write.internal'
	| 'write.destructive'
	| 'message.internal'
	| 'message.external'
	| 'publish.external'
	| 'spend.metered'
	| 'spend.commitment'
	| 'access.grant'
	| 'machine.run'
	| 'machine.admin'
	| 'agent.fanout';

/**
 * Every category that sits on the ladder.
 *
 * `read.internal` is deliberately excluded (FR-2): what an Agent may read
 * inside the workspace is decided by connections and tool grants, and a
 * second way to express it would be a second thing to get wrong.
 */
export type LadderedActionCategory = Exclude<ActionCategory, 'read.internal'>;

/** All thirteen, in the order the Safety screen renders them. */
export const ACTION_CATEGORIES: readonly ActionCategory[] = Object.freeze([
	'read.internal',
	'read.external',
	'write.internal',
	'write.destructive',
	'message.internal',
	'message.external',
	'publish.external',
	'spend.metered',
	'spend.commitment',
	'access.grant',
	'machine.run',
	'machine.admin',
	'agent.fanout'
] as readonly ActionCategory[]);

/** The twelve that carry a rung, in the same order. */
export const LADDERED_CATEGORIES: readonly LadderedActionCategory[] = Object.freeze(
	ACTION_CATEGORIES.filter((c): c is LadderedActionCategory => c !== 'read.internal')
);

/**
 * The categories whose actions carry a reviewable artefact, and therefore
 * the only ones for which **Draft** is offered (FR-8).
 *
 * Draft means "the exact thing that would have happened is stored and shown".
 * For a category with nothing to show — browsing the web, spending credits,
 * widening access, hiring an agent — Draft would be Ask wearing a different
 * label, so the ladder does not offer it at all.
 */
export const DRAFTABLE_CATEGORIES: readonly LadderedActionCategory[] = Object.freeze([
	'write.internal',
	'write.destructive',
	'message.external',
	'publish.external',
	'machine.run',
	'machine.admin'
] as readonly LadderedActionCategory[]);

/**
 * The highest rung a category may EVER reach — not settable by anyone
 * (FR-11): not the owner, not a workspace member, not a platform operator,
 * not an API key.
 *
 * `spend.commitment` is capped at `off` because the platform exposes no
 * mechanism by which an Agent executes a purchase, refund, subscription
 * change or transfer of funds (FR-12). An Agent that needs one raises a
 * decision describing it, and a person performs it.
 */
export const ACTION_CATEGORY_CEILING: Readonly<Record<LadderedActionCategory, TrustRung>> = Object.freeze({
	'read.external': 'auto',
	'write.internal': 'auto',
	'write.destructive': 'ask',
	'message.internal': 'auto',
	'message.external': 'ask',
	'publish.external': 'ask',
	'spend.metered': 'auto',
	'spend.commitment': 'off',
	'access.grant': 'ask',
	'machine.run': 'auto',
	'machine.admin': 'ask',
	'agent.fanout': 'auto'
} as Record<LadderedActionCategory, TrustRung>);

/**
 * Where a brand-new workspace starts (FR-1, "Shipped default").
 *
 * Low by default and raised deliberately: `message.external` starts at Draft
 * and the two machine categories plus `agent.fanout` start at Ask, even
 * though their ceilings are higher.
 */
export const ACTION_CATEGORY_DEFAULT: Readonly<Record<LadderedActionCategory, TrustRung>> = Object.freeze({
	'read.external': 'auto',
	'write.internal': 'auto',
	'write.destructive': 'ask',
	'message.internal': 'auto',
	'message.external': 'draft',
	'publish.external': 'ask',
	'spend.metered': 'auto',
	'spend.commitment': 'off',
	'access.grant': 'ask',
	'machine.run': 'ask',
	'machine.admin': 'ask',
	'agent.fanout': 'ask'
} as Record<LadderedActionCategory, TrustRung>);

/**
 * Most restrictive FIRST.
 *
 * FR-6: an action must classify into exactly one category, and where two
 * plausibly apply — deploying a site both publishes and spends — the more
 * restrictive one wins. "More restrictive" is a published order rather than a
 * judgement call, so two call sites cannot disagree about which of two
 * categories is the safer answer.
 *
 * The order is the ceiling, then the shipped default, then the blast radius
 * of getting it wrong: money, then things that leave the workspace, then
 * things that change a machine or an access boundary, then internal writes,
 * then reads.
 */
export const ACTION_CATEGORY_RESTRICTIVENESS: readonly ActionCategory[] = Object.freeze([
	'spend.commitment',
	'access.grant',
	'machine.admin',
	'publish.external',
	'message.external',
	'write.destructive',
	'machine.run',
	'agent.fanout',
	'spend.metered',
	'write.internal',
	'message.internal',
	'read.external',
	'read.internal'
] as readonly ActionCategory[]);

/**
 * camelCase i18n leaf name for a category, used under
 * `dashboard.settings.safety.category.*`.
 *
 * A map rather than a derivation: a next-intl leaf key may never contain a
 * literal `.`, and every category id does. Deriving the key would put the
 * dot-stripping rule in whichever file happened to render first.
 */
export const ACTION_CATEGORY_I18N_KEY: Readonly<Record<ActionCategory, string>> = Object.freeze({
	'read.internal': 'readInternal',
	'read.external': 'readExternal',
	'write.internal': 'writeInternal',
	'write.destructive': 'writeDestructive',
	'message.internal': 'messageInternal',
	'message.external': 'messageExternal',
	'publish.external': 'publishExternal',
	'spend.metered': 'spendMetered',
	'spend.commitment': 'spendCommitment',
	'access.grant': 'accessGrant',
	'machine.run': 'machineRun',
	'machine.admin': 'machineAdmin',
	'agent.fanout': 'agentFanout'
} as Record<ActionCategory, string>);

/** Narrowing type guard for unknown input (DTO bodies, stored rows, manifests). */
export function isActionCategory(value: unknown): value is ActionCategory {
	return typeof value === 'string' && (ACTION_CATEGORIES as readonly string[]).includes(value);
}

/** True for every category except `read.internal` (FR-2). */
export function isLadderedCategory(value: unknown): value is LadderedActionCategory {
	return isActionCategory(value) && value !== 'read.internal';
}

/** Whether the ladder offers **Draft** for this category (FR-8). */
export function isDraftableCategory(category: ActionCategory): boolean {
	return (DRAFTABLE_CATEGORIES as readonly string[]).includes(category);
}

/**
 * The more restrictive of two categories, per
 * {@link ACTION_CATEGORY_RESTRICTIVENESS} (FR-6). An id this build does not
 * know sorts last, so a known category always wins over an unknown one.
 */
export function moreRestrictiveCategory(a: ActionCategory, b: ActionCategory): ActionCategory {
	const rank = (c: ActionCategory) => {
		const at = ACTION_CATEGORY_RESTRICTIVENESS.indexOf(c);
		return at < 0 ? Number.MAX_SAFE_INTEGER : at;
	};
	return rank(a) <= rank(b) ? a : b;
}

/** The read-only description of one category, as `GET /api/safety/categories` returns it. */
export interface ActionCategoryDto {
	id: ActionCategory;
	/** False only for `read.internal`. */
	laddered: boolean;
	/** `null` for a category that is not laddered. */
	ceiling: TrustRung | null;
	/** `null` for a category that is not laddered. */
	defaultRung: TrustRung | null;
	draftable: boolean;
	/** camelCase leaf under `dashboard.settings.safety.category.*`. */
	i18nKey: string;
}
