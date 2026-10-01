/**
 * T3 — the `Work` object-size rule (plan §3.1:272; APW10-G21, tasks T3/T5).
 *
 * Plan §3.1:272 states "Whole object ≤ 512 KiB (validated by the controller **and** a CRD
 * `x-kubernetes-validations` size rule)". The second half of that sentence is not implementable:
 * a CEL rule inside a structural schema cannot measure the size of the object it is validating,
 * and the plan's own fix pass says so — APW10-G21 (plan §3.1's fix list) replaces "the CRD size
 * rule" claim with per-field `maxLength`/`maxItems` bounds and moves the whole-object refusal to
 * T5's `work-spec.validator.ts`. The per-field bounds live in `work.ts` (`maxItems`,
 * `maxLength`, `maxProperties`, `maximum`); the whole-object rule lives **here**, as the one pure
 * function T5's validator calls, so the rule has one implementation rather than a comment.
 *
 * The measurement is the UTF-8 byte length of the object's JSON serialisation — the bytes that
 * would travel to the API server — not a character count of the YAML a human reads. Only the size
 * is decided here: the refusal code the owner sees (`SPEC_LIMIT_EXCEEDED`) is T5's, and this
 * function deliberately returns a boolean so a caller cannot mistake it for a validator.
 */
import { APPS_TIER_MAX_WORK_BYTES } from '@ever-works/contracts';

/** The whole-object ceiling — plan §3.1:272 (`APPS_TIER_MAX_WORK_BYTES`, 512 KiB). */
export const WORK_OBJECT_LIMIT_BYTES = APPS_TIER_MAX_WORK_BYTES;

/** The object's serialised size in bytes, as the API server would receive it. */
export function workObjectBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}

/**
 * Whether the object exceeds the 512 KiB ceiling.
 *
 * The boundary is inclusive of the limit: an object of exactly
 * {@link WORK_OBJECT_LIMIT_BYTES} bytes is **within** it (plan §3.1:272 says "≤ 512 KiB"), and
 * one byte more is not.
 */
export function exceedsWorkObjectLimit(value: unknown): boolean {
	return workObjectBytes(value) > WORK_OBJECT_LIMIT_BYTES;
}
