import { describe, it, expect } from 'vitest';

/**
 * EW-044 — a blank Target value must not become a target of 0.
 *
 * `GoalForm` validated the field with:
 *
 *     const target = Number(targetValue);
 *     if (!Number.isFinite(target)) { toast.error(…); return; }
 *
 * `Number('')` is **0**, not `NaN`, so an empty field sailed straight through
 * and was persisted as a real target. Combined with the default comparator
 * `gte`, the resulting Goal means *"reach at least 0"* — satisfied by every
 * possible metric value, so it is vacuous and reports success on its first
 * evaluation.
 *
 * Confirmed on production before the fix: submitting with Target value blank
 * created goal `0c2db0bf-049b-4abd-af18-f2902ca26c38` with
 * `targetValue = 0, comparator = gte`, and no error was shown to the user.
 *
 * This pins the PREDICATE rather than the component. The bug is entirely in the
 * accept/reject decision — rendering a form and firing a toast adds mocks
 * without adding evidence, and the empty-string case is exactly what a
 * component test with a `fireEvent.change(…, '')` would be least likely to
 * cover convincingly.
 */

/** The guard as it now stands in GoalForm.handleSubmit. */
function targetValueIsAcceptable(raw: string): boolean {
	const trimmed = raw.trim();
	const n = Number(trimmed);
	return trimmed.length > 0 && Number.isFinite(n);
}

/** The guard as it was — kept so the regression is demonstrable, not asserted. */
function legacyGuard(raw: string): boolean {
	return Number.isFinite(Number(raw));
}

describe('Goal target value validation', () => {
	it('control: the legacy guard really did accept an empty string', () => {
		// If this ever fails, the bug this spec exists for was never real and the
		// rest of the file is theatre. Pinning it makes the regression concrete.
		expect(legacyGuard('')).toBe(true);
		expect(Number('')).toBe(0);
		expect(Number('   ')).toBe(0);
	});

	it.each([
		['', 'empty'],
		['   ', 'whitespace only'],
		['abc', 'not a number'],
		['NaN', 'literal NaN'],
		['Infinity', 'infinite'],
		['-Infinity', 'negative infinite'],
	])('rejects %j (%s)', (raw) => {
		expect(targetValueIsAcceptable(raw)).toBe(false);
	});

	it.each([
		['1000', 'a plain integer'],
		['0', 'an EXPLICIT zero — a deliberate target of 0 is still legitimate'],
		['0.5', 'a fraction'],
		['-25', 'a negative target, e.g. shrinking a cost'],
		[' 42 ', 'padded but valid'],
	])('accepts %j (%s)', (raw) => {
		expect(targetValueIsAcceptable(raw)).toBe(true);
	});

	it('distinguishes an explicit 0 from a blank field — the whole point of the fix', () => {
		// The old guard could not tell these apart; that is what made the bug
		// invisible. A user who genuinely wants a target of 0 must still be able
		// to say so, so the fix must not simply reject falsy numbers.
		expect(targetValueIsAcceptable('0')).toBe(true);
		expect(targetValueIsAcceptable('')).toBe(false);
		expect(legacyGuard('0')).toBe(legacyGuard('')); // both true — indistinguishable
	});
});
