import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { USER_SELECTABLE_WORK_KINDS, WORK_KINDS } from '../index.js';

/**
 * The published Work-kind vocabulary must match the code that defines it.
 *
 * WHY THIS EXISTS. `repo` shipped as a sixth user-selectable kind while a large
 * documentation pass was being written. Nothing failed: the docs kept saying
 * "five kinds", every page agreed with every other page, the build stayed green,
 * and an adversarial review of each page against the code missed it too — a
 * reviewer checks the claims a page makes, and no page claimed anything false
 * about `repo`. It was simply absent. Only an independent reader starting from
 * the constant rather than the prose noticed, weeks later.
 *
 * That is the failure this test makes impossible. It reads the shipped
 * `work-kinds.md` and asserts every kind in the vocabulary appears in it, so
 * adding a kind is a deliberate multi-surface change — code plus the reference
 * page — rather than a silent divergence nobody is positioned to see.
 *
 * It deliberately checks only PRESENCE, in only the canonical page. A stricter
 * assertion (every page, every table, exact prose) would fail on every ordinary
 * edit and be disabled within a month. This one fails exactly when the docs
 * stop describing something the product ships.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const WORK_KINDS_DOC = resolve(HERE, '../../../../../docs/features/work-kinds.md');

function readDoc(): string {
	try {
		return readFileSync(WORK_KINDS_DOC, 'utf8');
	} catch (error) {
		throw new Error(
			`Could not read the Work-kind reference page at ${WORK_KINDS_DOC}. ` +
				`If it moved, update this test's path — do not delete the test. ` +
				`Original error: ${(error as Error).message}`
		);
	}
}

describe('work-kinds.md documents the shipped vocabulary', () => {
	it('mentions every user-selectable kind', () => {
		const doc = readDoc();
		const missing = USER_SELECTABLE_WORK_KINDS.filter((kind) => !doc.includes(`\`${kind}\``));

		expect(
			missing,
			missing.length
				? `docs/features/work-kinds.md never mentions ${missing.map((k) => `\`${k}\``).join(', ')}. ` +
						`A kind a user can pick on the create screen but cannot read about is invisible: ` +
						`document it there (vocabulary table, capability matrix, metric tiles) before shipping.`
				: ''
		).toEqual([]);
	});

	it('mentions every platform-minted kind too', () => {
		const doc = readDoc();
		// `default` is the column default carried by pre-existing rows and behaves
		// as `directory`; the page explains it in prose rather than as its own kind,
		// so presence of the literal is enough.
		const missing = WORK_KINDS.filter((kind) => !doc.includes(`\`${kind}\``));

		expect(
			missing,
			missing.length
				? `docs/features/work-kinds.md never mentions ${missing.map((k) => `\`${k}\``).join(', ')}. ` +
						`Kinds the platform mints for the user (company, campaign) still need documenting — ` +
						`a reader who sees one on a Work should be able to look it up.`
				: ''
		).toEqual([]);
	});

	it('does not document a kind the code has dropped', () => {
		const doc = readDoc();
		// Guards the other direction: a kind removed from the union but left in the
		// docs sends readers after something that no longer exists. Only literals
		// in backticks that look like kinds are considered.
		const documented = [...doc.matchAll(/`([a-z][a-z-]{2,})`/g)].map((m) => m[1]);
		const known = new Set<string>(WORK_KINDS);
		const kindLike = new Set(
			documented.filter((token) =>
				[
					'website',
					'landing-page',
					'blog',
					'directory',
					'awesome-repo',
					'repo',
					'company',
					'campaign',
					'default'
				].includes(token)
			)
		);
		const stale = [...kindLike].filter((token) => !known.has(token));

		expect(
			stale,
			stale.length
				? `work-kinds.md still documents ${stale.join(', ')}, which WORK_KINDS no longer contains.`
				: ''
		).toEqual([]);
	});
});
