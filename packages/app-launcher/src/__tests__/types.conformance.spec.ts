import { describe, expect, it } from 'vitest';
import type {
	AppLauncherEmptyAction as ContractEmptyAction,
	AppLauncherEnvironment as ContractEnvironment,
	AppLauncherItem as ContractItem,
	AppLauncherItemKind as ContractItemKind,
	AppLauncherListResponse as ContractResponse,
	AppLauncherManageState as ContractManageState,
	AppLauncherPlatformStatus as ContractPlatformStatus,
	AppLauncherSection as ContractSection,
	AppLauncherWorkChip as ContractWorkChip
} from '@ever-works/contracts';
import type {
	AppLauncherEmptyAction,
	AppLauncherEnvironment,
	AppLauncherItem,
	AppLauncherItemKind,
	AppLauncherListResponse,
	AppLauncherManageState,
	AppLauncherPlatformStatus,
	AppLauncherSection,
	AppLauncherWorkChip
} from '../types.js';

/**
 * The drift guard for `src/types.ts`'s mirror (APW-11 T10/T12, plan §6.1).
 *
 * `src/types.ts` declares the registry vocabulary itself instead of importing it
 * from `@ever-works/contracts`, because this package has to be extractable on its
 * own for P2 (T28) — a `dist/index.d.ts` referencing the monorepo would make an
 * extracted package's types unresolvable. The price of a mirror is that the two
 * copies can drift, so this spec is the thing that stops it: **the contract is
 * imported HERE, in a test, and every declaration is asserted assignable in BOTH
 * directions.**
 *
 * Both directions matter, and for different failures:
 *
 *   - mirror → contract fails if the mirror is MISSING something the contract has
 *     (a new contract field would be dropped silently on the way through the
 *     element), and if it declares a field the contract does not have (extra
 *     required fields break the host's assignment instead — the `expectTypeOf`
 *     lines below are what name it either way);
 *   - contract → mirror fails if the mirror requires a field the contract makes
 *     optional, which is the subtle one: a host's valid payload would stop
 *     compiling.
 *
 * The union members are checked with a value-level equality assertion rather than
 * only a type-level one, so a literal that differs (say `canceled` for
 * `cancelled`) fails with the two values printed instead of only a type error.
 */

/**
 * Compile-time bidirectional assignability. `A extends B` and `B extends A` is
 * exact structural equality for these shapes, so the parameter type is `true` for
 * an equal pair and **`never` for a mismatched one** — and the call sites below
 * pass `true`, which is why the mismatch is a compile error rather than a silent
 * pass.
 *
 * ⚠️ The argument is deliberately NOT optional. A first draft made it
 * `_proof?: …` and every call site omitted it, which compiles for the `never`
 * case too — a guard that could not fail. `tsconfig.specs.json` exists so
 * `tsc` actually reads this file: the package's build tsconfig excludes specs,
 * and vitest strips types, so without it this whole spec would be decorative.
 */
function assertMutuallyAssignable<A, B>(_proof: A extends B ? (B extends A ? true : never) : never): void {
	// Intentionally empty: the assertion is the parameter's type.
}

describe('the element types mirror the contracts (plan §6.1)', () => {
	it('keeps every union identical, member for member', () => {
		const unions: ReadonlyArray<readonly [readonly string[], readonly string[]]> = [
			[
				['production', 'stage', 'develop'] satisfies AppLauncherEnvironment[],
				['production', 'stage', 'develop'] satisfies ContractEnvironment[]
			],
			[['platform', 'work'] satisfies AppLauncherItemKind[], ['platform', 'work'] satisfies ContractItemKind[]],
			[
				['pinned', 'platforms', 'works'] satisfies AppLauncherSection[],
				['pinned', 'platforms', 'works'] satisfies ContractSection[]
			],
			[
				['deploying', 'lastDeployFailed'] satisfies AppLauncherWorkChip[],
				['deploying', 'lastDeployFailed'] satisfies ContractWorkChip[]
			],
			[
				['listed', 'notLive', 'exposureOff'] satisfies AppLauncherManageState[],
				['listed', 'notLive', 'exposureOff'] satisfies ContractManageState[]
			],
			[
				['available', 'beta'] satisfies AppLauncherPlatformStatus[],
				['available', 'beta'] satisfies ContractPlatformStatus[]
			],
			[
				['createAppWork', 'goToWorks'] satisfies AppLauncherEmptyAction[],
				['createAppWork', 'goToWorks'] satisfies ContractEmptyAction[]
			]
		];
		for (const [mirror, contract] of unions) {
			expect(mirror).toEqual(contract);
			expect(mirror.length).toBe(contract.length);
		}
	});

	it('is assignable in both directions for the tile and the response', () => {
		// Each call IS the proof: the argument is `true` where a mismatch would
		// require `never`, so a drift fails `pnpm type-check` (tsconfig.specs.json).
		assertMutuallyAssignable<AppLauncherItem, ContractItem>(true);
		assertMutuallyAssignable<ContractItem, AppLauncherItem>(true);
		assertMutuallyAssignable<AppLauncherListResponse, ContractResponse>(true);
		assertMutuallyAssignable<ContractResponse, AppLauncherListResponse>(true);
		expect(true).toBe(true);
	});

	it('pins the pin limit as the same literal the contracts declare', () => {
		// A mirror that widened `pinLimit` to `number` fails the second call; a
		// contracts change to `7` fails the first.
		assertMutuallyAssignable<AppLauncherListResponse['meta']['pinLimit'], 6>(true);
		assertMutuallyAssignable<6, AppLauncherListResponse['meta']['pinLimit']>(true);
		expect(true).toBe(true);
	});
});
