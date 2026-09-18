import { describe, expect, it } from 'vitest';
import * as barrel from '../../index.js';

/**
 * The package entry point (APW-06 T13).
 *
 * `src/index.ts` is how APW-07, APW-10 and `apps/api` reach the App capabilities
 * without a deep import, so what it re-exports is a real interface — and it is
 * the one place where three new modules met modules that were already published
 * from here. These assertions pin that meeting:
 *
 *  1. the T13 modules are reachable from the root, with their ports, their
 *     refusal codes and the §6.3 permission list;
 *  2. **`componentSelector` did not silently disappear.** It is the ONE name two
 *     App modules both declare, and TypeScript drops an ambiguous `export *`
 *     name from the root entirely (TS2308) instead of picking one. The entry
 *     re-exports both explicitly: the incumbent label-map builder keeps its name
 *     and the T13 selector string is reachable as `componentLabelSelector`. The
 *     two return DIFFERENT shapes, which is what makes the assertion meaningful.
 *
 * **What each direction is actually guarded by — measured, not assumed.** Two
 * perturbations were run against `src/index.ts`. Deleting the
 * `componentSelector as componentLabelSelector` line (perturbation A) turns the
 * third assertion below RED, so the alias is pinned here. Deleting the explicit
 * `componentSelector` re-export (perturbation B) does NOT turn it red: with the
 * name ambiguous, this spec's bundler still resolves `barrel.componentSelector`
 * to the incumbent — whereas `tsc --noEmit` fails the package with TS2308. That
 * asymmetry is the finding, and it is why the explicit re-export is not optional:
 * the SPEC pins the alias, the TYPE-CHECK pins the ambiguity, and a bundler that
 * resolved the other candidate would quietly hand a rendered-object caller a
 * `'k=v'` string. Renaming the T13 function at source is the durable fix and is
 * reported rather than done here (the module's shape is not this spec's to change).
 */
describe('the k8s plugin package entry point (APW-06 T13)', () => {
	it('re-exports the T13 modules and their ports from the package root', () => {
		expect(typeof barrel.AppStatusReader).toBe('function');
		expect(typeof barrel.AppLifecycle).toBe('function');
		expect(typeof barrel.AppClusterChecker).toBe('function');
	});

	it('re-exports the values those modules define', () => {
		// `APP_LIFECYCLE_CODES` is the code->code map the refusals travel in, not a list.
		expect(Object.keys(barrel.APP_LIFECYCLE_CODES).length).toBeGreaterThan(0);
		expect(barrel.APP_LIFECYCLE_CODES.replicas_out_of_range).toBe('replicas_out_of_range');
		expect(barrel.APP_REQUIRED_PERMISSIONS.length).toBeGreaterThan(0);
		expect(barrel.APP_LOG_LINES_DEFAULT).toBe(200);
		expect(barrel.APP_LOG_LINES_MAX).toBe(500);
	});

	it('keeps both `componentSelector` spellings reachable, and distinct', () => {
		// The incumbent (T6): a label MAP for a rendered object.
		expect(barrel.componentSelector('api')).toEqual({ 'ever-works.io/component': 'api' });
		// The status reader's (T13): a selector STRING for a live read.
		expect(barrel.componentLabelSelector('api')).toBe('ever-works.io/component=api');
		expect(typeof barrel.componentSelector('api')).not.toBe(typeof barrel.componentLabelSelector('api'));
	});
});
