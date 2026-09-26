import { describe, expect, it } from 'vitest';

import * as root from '../index.js';

import * as agents from '../agents/index.js';
import * as apps from '../apps/index.js';
import * as backup from '../backup/index.js';
import * as billing from '../billing/index.js';
import * as computer from '../computer/index.js';
import * as connections from '../connections/index.js';
import * as conversations from '../conversations/index.js';
import * as delegation from '../delegation/index.js';
import * as digest from '../digest/index.js';
import * as domain from '../domain/index.js';
import * as email from '../email/index.js';
import * as feed from '../feed/index.js';
import * as fleet from '../fleet/index.js';
import * as form from '../form/index.js';
import * as github from '../github/index.js';
import * as hitl from '../hitl/index.js';
import * as home from '../home/index.js';
import * as inbox from '../inbox/index.js';
import * as ingest from '../ingest/index.js';
import * as item from '../item/index.js';
import * as kb from '../kb/index.js';
import * as memory from '../memory/index.js';
import * as modelRouting from '../model-routing/index.js';
import * as notifications from '../notifications/index.js';
import * as playbook from '../playbook/index.js';
import * as policy from '../policy/index.js';
import * as release from '../release/index.js';
import * as runs from '../runs/index.js';
import * as safety from '../safety/index.js';
import * as secret from '../secret/index.js';
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
	['apps', apps],
	['backup', backup],
	['billing', billing],
	['computer', computer],
	['connections', connections],
	['conversations', conversations],
	['delegation', delegation],
	['digest', digest],
	['domain', domain],
	['email', email],
	['feed', feed],
	['fleet', fleet],
	['form', form],
	['github', github],
	['hitl', hitl],
	['home', home],
	['inbox', inbox],
	['ingest', ingest],
	['item', item],
	['kb', kb],
	['memory', memory],
	['model-routing', modelRouting],
	['notifications', notifications],
	['playbook', playbook],
	['policy', policy],
	['release', release],
	['runs', runs],
	['safety', safety],
	['secret', secret],
	['skills', skills],
	['tasks', tasks],
	['terminal', terminal],
	['workflow', workflow]
];

describe('src/index.ts — the package root barrel', () => {
	it('re-exports every area listed in the source file', () => {
		// Guard against an area being added to src/index.ts without being added
		// here, which would leave the collision check below blind to it.
		// COUNTED off the AREAS array above, never added up from two branches'
		// numbers: develop and this branch each reported the total from their
		// own base (develop lacked the AW-22 `backup` area, this branch lacked
		// the AW-13 `notifications` area), so the literal below is re-counted
		// off the merged array instead.
		//
		// The merged array carries BOTH `backup` and `notifications` -> 27,
		// COUNTED off the array above. Develop said 26 and this branch said 26
		// from their own bases; adding the two branches' own additions to
		// either number is how this literal goes wrong.
		const exportLines = AREAS.length;
		// develop's own ledger for the same stretch, kept so neither side's
		// bookkeeping is lost:
		// 31 was COUNTED from the AREAS array after merging develop into the
		// AW-19 Home branch, not added up from either side’s number: develop
		// stood at 30 areas and that branch at 23, and the merged barrel carried
		// the union of both plus the `home` area AW-19 adds — counting the merged
		// array gave 31.
		// 32 is COUNTED the same way after merging develop into the AW-24 safety
		// branch: develop stood at 31 areas and this branch adds exactly one new
		// area (`safety`), and re-counting the merged array gives 32. Note
		// `src/index.ts` has 33 `export *` lines but only 32 AREAS:
		// `./fleet/fleet-task-workspace.types.js` is a second sub-path of the
		// existing `fleet` area, not a new area.
		// Recount the array after every merge instead of trusting either side.
		//
		// 33 is COUNTED the same way after merging that develop (32 areas, Home
		// and safety included) into this AW-22 Workspace-backup branch (27
		// areas): `backup` is the only area develop does not carry, and the six
		// areas develop grew while this branch was open (`billing`, `home`,
		// `safety` and the rest of its own union) the only ones this branch
		// lacked. Neither 27 nor 32 is the answer, and 27 + 32 is nonsense —
		// re-counting the merged array gives 33. `src/index.ts` has 34
		// `export *` lines but only 33 AREAS:
		// `./fleet/fleet-task-workspace.types.js` is a second sub-path of the
		// existing `fleet` area, not a new area.
		// 34 is COUNTED the same way after the App Works programme (APW-01…APW-13)
		// added the `apps` area: that branch stood at 33 areas and adds exactly
		// one (`apps`, re-exported from `src/apps/index.ts`), and re-counting the
		// merged array gives 34. `src/index.ts` has 35 `export *` lines but only
		// 34 AREAS: `./fleet/fleet-task-workspace.types.js` is a second sub-path
		// of the existing `fleet` area, not a new area. Note `apps` is a PLAIN
		// `export *`, not `export type *`, on purpose — it carries 524 runtime
		// exports (closed-union arrays, limits, pure resolvers) that a type-only
		// re-export would drop from the package root without any error here.
		expect(exportLines).toBe(34);
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

	it('surfaces the App Works RUNTIME values at the root, not only its types', () => {
		// Named, not just counted, because `apps` is the one area where getting
		// this wrong is invisible: its modules are mostly types, so changing
		// `export *` to `export type *` in `src/index.ts` would keep every
		// `tsc --noEmit` in this package green (the types still resolve) while
		// silently dropping all 524 runtime names from the package root — the
		// closed-union arrays behind `X = (typeof X)[number]`, the limits, and
		// the pure resolvers consumers actually call. The generic
		// `it.each(AREAS)` case above would catch it too; this one says why.
		for (const name of [
			'APP_DEPLOY_TARGET_CHOICES',
			'APP_SOURCE_REASON_CODES',
			'APP_READINESS_FAILURE_REASONS',
			'APP_REPOSITORY_STAGE_LIMITS',
			'APP_DEPENDENCY_KINDS',
			'APPS_TIER_MAX_JOBS',
			'EVER_ID_SCOPES',
			'resolveAppRepositoryModes'
		]) {
			expect(name in root, `${name} must be visible at the package root`).toBe(true);
		}
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
