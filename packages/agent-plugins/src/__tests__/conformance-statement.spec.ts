import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Keeps the published conformance statement honest.
 *
 * A conformance claim nobody can falsify is decoration. These tests make
 * `docs/specs/features/agent-plugins/conformance.md` fail the build when it
 * stops matching the specification it claims to answer:
 *
 * - a requirement added to `spec.md` with no row in the statement,
 * - a row claiming a requirement id that does not exist,
 * - a row whose status is not one of the defined values,
 * - a summary that disagrees with the rows above it.
 *
 * The first direction matters most. Adding AP-24 to the spec and forgetting
 * the statement would leave a page that reads as complete while silently
 * omitting a requirement — worse than having no page, because it invites
 * trust it has not earned.
 *
 * Every pattern here tolerates column padding. Prettier aligns markdown
 * tables and CI enforces Prettier, so an exact-spacing matcher would break on
 * the next format run and teach whoever hit it to delete the guard.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS = join(HERE, '..', '..', '..', '..', 'docs', 'specs', 'features', 'agent-plugins');
const SPEC = join(DOCS, 'spec.md');
const STATEMENT = join(DOCS, 'conformance.md');

interface StatementRow {
	id: string;
	status: string;
	evidence: string;
}

/** Requirement ids the specification defines, in `- **AP-N**:` form. */
async function specRequirementIds(): Promise<string[]> {
	const text = await readFile(SPEC, 'utf8');
	const ids = [...text.matchAll(/^- \*\*(AP-\d+)\*\*:/gmu)].map((m) => m[1]);
	return [...new Set(ids)];
}

/** Requirement ids the statement has a table row for. */
async function statementRows(): Promise<StatementRow[]> {
	const text = await readFile(STATEMENT, 'utf8');
	return [...text.matchAll(/^\|\s*(AP-\d+)\s*\|(.+?)\|(.+?)\|(.+?)\|\s*$/gmu)].map((m) => ({
		id: m[1],
		status: m[3].trim(),
		evidence: m[4].trim()
	}));
}

/** The number in the second cell of a summary row, or null when absent. */
function summaryCount(text: string, pattern: RegExp): number | null {
	const found = pattern.exec(text);
	return found ? Number(found[1]) : null;
}

const MET_ROW = /^\|\s*Met \/ Met \(library\)\s*\|\s*(\d+)\s*\|/mu;
const PARTIAL_ROW = /^\|\s*Partial\s*\|\s*(\d+)\s/mu;
const NOT_YET_ROW = /^\|\s*Not yet\s*\|\s*(\d+)\s/mu;

const PERMITTED_STATUSES = new Set(['Met', '**Met**', 'Met (library)', '**Partial**', '**Not yet**']);

describe('published conformance statement', () => {
	it('has a row for every requirement the specification defines', async () => {
		const spec = await specRequirementIds();
		const rows = await statementRows();
		const covered = new Set(rows.map((r) => r.id));

		// Sanity: if either parser breaks, every assertion here would pass
		// vacuously, so both counts are floored before anything is compared.
		expect(spec.length).toBeGreaterThanOrEqual(23);
		expect(rows.length).toBeGreaterThanOrEqual(23);

		expect(spec.filter((id) => !covered.has(id))).toEqual([]);
	});

	it('does not claim a requirement the specification does not define', async () => {
		const spec = new Set(await specRequirementIds());
		const rows = await statementRows();

		expect(rows.map((r) => r.id).filter((id) => !spec.has(id))).toEqual([]);
	});

	it('uses only defined status values', async () => {
		const rows = await statementRows();

		// An ad-hoc status like "mostly" would let a gap hide behind a word
		// nobody has defined.
		const bad = rows.filter((r) => !PERMITTED_STATUSES.has(r.status));
		expect(bad.map((r) => `${r.id}: ${r.status}`)).toEqual([]);
	});

	it('gives every row some evidence', async () => {
		const rows = await statementRows();

		// "Not yet" rows count too: their evidence is the explanation of what
		// is missing, which is the part a reader needs most.
		expect(rows.filter((r) => r.evidence.length < 10).map((r) => r.id)).toEqual([]);
	});

	it('states a summary consistent with its own rows', async () => {
		const rows = await statementRows();
		const text = await readFile(STATEMENT, 'utf8');

		const met = rows.filter((r) => r.status.replace(/\*/gu, '').startsWith('Met')).length;
		const partial = rows.filter((r) => r.status.includes('Partial')).length;
		const notYet = rows.filter((r) => r.status.includes('Not yet')).length;

		// The summary is written by hand and can drift from the rows above it.
		// A summary that OVERSTATES what is met is exactly the failure this
		// page exists to prevent.
		expect(summaryCount(text, MET_ROW)).toBe(met);
		expect(summaryCount(text, PARTIAL_ROW)).toBe(partial);
		expect(summaryCount(text, NOT_YET_ROW)).toBe(notYet);
	});
});
