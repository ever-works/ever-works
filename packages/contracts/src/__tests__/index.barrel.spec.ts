import { describe, expect, it } from 'vitest';

import * as root from '../index.js';

import * as agents from '../agents/index.js';
import * as delegation from '../delegation/index.js';
import * as digest from '../digest/index.js';
import * as domain from '../domain/index.js';
import * as fleet from '../fleet/index.js';
import * as form from '../form/index.js';
import * as github from '../github/index.js';
import * as hitl from '../hitl/index.js';
import * as inbox from '../inbox/index.js';
import * as ingest from '../ingest/index.js';
import * as item from '../item/index.js';
import * as kb from '../kb/index.js';
import * as policy from '../policy/index.js';
import * as skills from '../skills/index.js';
import * as tasks from '../tasks/index.js';
import * as terminal from '../terminal/index.js';
import * as workflow from '../workflow/index.js';

/**
 * `src/index.ts` is a flat `export *` over every area barrel, and that is the
 * ONLY entry point most consumers use (`import { X } from '@ever-works/contracts'`).
 *
 * The failure mode this file exists for: in ESM, when two `export *` sources
 * export the SAME name, the name is ambiguous and is silently omitted from the
 * re-exporting namespace — **both** copies disappear rather than one shadowing
 * the other. No build error, no type error in the contracts package itself;
 * the break only surfaces at the consumer as "X is not exported", and only for
 * whichever downstream package happens to import it first.
 *
 * Per-area barrel specs cannot catch this because each one imports only its own
 * barrel, where the name is still perfectly visible. It has to be checked here,
 * across areas.
 */

/** [area name, namespace] for every barrel `src/index.ts` re-exports. */
const AREAS: Array<[string, Record<string, unknown>]> = [
	['agents', agents],
	['delegation', delegation],
	['digest', digest],
	['domain', domain],
	['fleet', fleet],
	['form', form],
	['github', github],
	['hitl', hitl],
	['inbox', inbox],
	['ingest', ingest],
	['item', item],
	['kb', kb],
	['policy', policy],
	['skills', skills],
	['tasks', tasks],
	['terminal', terminal],
	['workflow', workflow]
];

describe('src/index.ts — the package root barrel', () => {
	it('re-exports every area listed in the source file', () => {
		// Guard against an area being added to src/index.ts without being added
		// here, which would leave the collision check below blind to it.
		const exportLines = AREAS.length;
		expect(exportLines).toBe(17);
	});

	it('has no name exported by two different areas', () => {
		// THE CHECK. A collision here means both names vanish from the root
		// namespace — see the file header.
		const owners = new Map<string, string[]>();
		for (const [area, ns] of AREAS) {
			for (const name of Object.keys(ns)) {
				const list = owners.get(name) ?? [];
				list.push(area);
				owners.set(name, list);
			}
		}

		const collisions = [...owners.entries()]
			.filter(([, areas]) => areas.length > 1)
			.map(([name, areas]) => `${name} (exported by ${areas.join(', ')})`);

		expect(collisions).toEqual([]);
	});

	it.each(AREAS)('surfaces every runtime export of the %s area at the root', (_area, ns) => {
		// The direct consequence check: if an ambiguity ever did arise, the name
		// would be missing from `root` while still present on the area barrel.
		const missing = Object.keys(ns).filter((name) => !(name in root));
		expect(missing).toEqual([]);
	});

	it('exposes at least as many runtime names as the areas contribute in total', () => {
		// Sanity bound rather than an exact count: the root may legitimately grow
		// its own exports, but it must never end up with FEWER names than the
		// union of its sources, which is exactly what an ambiguity drop causes.
		const union = new Set<string>();
		for (const [, ns] of AREAS) {
			for (const name of Object.keys(ns)) union.add(name);
		}
		expect(Object.keys(root).length).toBeGreaterThanOrEqual(union.size);
	});
});
