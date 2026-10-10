import { describe, expect, it } from 'vitest';

import { sanitiseSlug } from '../k8s.plugin';

/**
 * `sanitiseSlug` turns a project name — the plugin's `projectName` setting, or the Work's
 * website project name passed as `projectNameOverride` — into the Kubernetes object name.
 */
describe('sanitiseSlug', () => {
	/**
	 * CodeQL js/polynomial-redos. Leading and trailing dashes used to be stripped with
	 * `/^-+|-+$/g` BEFORE dash runs were collapsed, and `-+$` backtracks quadratically over a
	 * long run of `-` that is not at the end: every `-` restarts a scan to the end of the run
	 * (50 000 of them took ~2.4 s). Collapsing first leaves no run to rescan.
	 *
	 * Sized, not tightly timed: at 200 000 the old chain needs ~40 s on a dev box and today's
	 * milliseconds, so a 2 s bound can be failed neither by a CPU-throttled CI runner nor passed by
	 * the old chain. (A "< 200 ms" at 50 000 was one scheduler stall from red — develop CI, 2026-10-09.)
	 */
	it('sanitises a name with a long inner run of "-" in linear time', () => {
		const hostile = `a${'-'.repeat(200_000)}a`;

		const started = performance.now();
		const slug = sanitiseSlug(hostile);
		const elapsedMs = performance.now() - started;

		expect(slug).toBe('a-a');
		expect(elapsedMs).toBeLessThan(2_000);
	});

	// The reordered steps must answer exactly what the original chain answered.
	it.each([
		['awesome-time-tracking-website', 'awesome-time-tracking-website'],
		['My Project!!', 'my-project'],
		['--a--b--', 'a-b'],
		['___', ''],
		['-', ''],
		['', ''],
		['a - b', 'a-b'],
		['  spaced  ', 'spaced'],
		['Ünïcode Name', 'n-code-name'],
		['a'.repeat(70), 'a'.repeat(63)],
		// Truncation after the trim can still end on a dash — kept as it was.
		[`${'a'.repeat(62)}-b`, `${'a'.repeat(62)}-`],
		[`${'a'.repeat(62)}!!b`, `${'a'.repeat(62)}-`]
	])('sanitises %j to %j', (input, expected) => {
		expect(sanitiseSlug(input)).toBe(expected);
	});
});
