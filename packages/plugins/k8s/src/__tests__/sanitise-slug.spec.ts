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
	 */
	it('sanitises a name with a long inner run of "-" in linear time', () => {
		const hostile = `a${'-'.repeat(50_000)}a`;

		const started = performance.now();
		const slug = sanitiseSlug(hostile);
		const elapsedMs = performance.now() - started;

		expect(slug).toBe('a-a');
		expect(elapsedMs).toBeLessThan(200);
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
