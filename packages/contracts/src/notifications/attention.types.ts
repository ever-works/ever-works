/**
 * Attention controls (AW-13) — the delivery classes an owner can put a daily
 * ceiling on.
 *
 * In-app is deliberately NOT a class: the in-app record is always written and
 * is never counted or held. Only deliveries that leave the product (email to
 * the account address, and messages to connected chat channels) interrupt
 * someone, so only those are budgeted.
 */

export type AttentionTargetClass = 'email' | 'channel';

/** Append only — the order feeds `@IsIn` validators. */
export const ATTENTION_TARGET_CLASSES: readonly AttentionTargetClass[] = ['email', 'channel'];

/**
 * One meter on the notification matrix: how loud the last rolling 24 hours
 * were for one delivery class. `used` may exceed `limit` because urgent
 * events always send and still count.
 */
export interface AttentionBudgetSnapshot {
	readonly targetClass: AttentionTargetClass;
	readonly used: number;
	readonly limit: number;
	readonly held: number;
	/** ISO-8601 instant the oldest counted delivery leaves the window; null when nothing is counted. */
	readonly resetsAt: string | null;
	readonly enabled: boolean;
}
