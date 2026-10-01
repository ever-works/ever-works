/**
 * APW-02 T9/T10 — the fork-lifecycle plugin contract: typed provider errors,
 * repository facts, and the nine optional `IGitProviderPlugin` members.
 *
 * Three kinds of assertion live here:
 *
 * 1. **Type-level — the additive-only proof (top priority).** Every member this
 *    contract adds is optional, so a git-provider plugin written before APW-02
 *    still satisfies `IGitProviderPlugin`. That is expressed two ways: the
 *    `IsOptional<…>` pins (making a member required flips one to `false` and the
 *    `toEqualTypeOf<true>()` under it stops compiling) and the assignability
 *    proof, where a plugin typed as `IGitProviderPlugin` MINUS all nine new
 *    members is assigned back to `IGitProviderPlugin`. If any of the nine became
 *    required, that assignment stops compiling. No stub of the ~25 pre-existing
 *    members is needed for either — which is what makes the pin cheap to keep.
 * 2. **Type-level — the pin on what T9's Test line names**: the exact union of
 *    reasons, the exact `details` bag, and the exact signature of every member
 *    (parameters and return type), so a later "small" rename or narrowing is a
 *    compile error rather than a silent break for APW-01 / 05 / 09.
 * 3. **Behavioural** — `GitProviderRequestError` keeps `reason`, `status` and
 *    `details`, is an `instanceof Error`, and is caught as one; plus the
 *    lazy-plugin calling rule ("materialise the method before calling it") the
 *    JSDoc on every member states.
 *
 * NOTE ON HOW THESE BIND: `packages/plugin/tsconfig.json` includes `src/**` but
 * excludes spec files (`*.spec.ts` at any depth), so
 * `pnpm --filter @ever-works/plugin type-check` (`tsc --noEmit`) does not
 * compile this file, and `pnpm test` runs it through esbuild, which erases
 * types. The type-level pins therefore bind when this file is type-checked
 * directly, e.g.
 *
 *     packages/plugin/node_modules/.bin/tsc --noEmit --strict --module ESNext \
 *       --moduleResolution bundler --target ES2021 --skipLibCheck \
 *       --esModuleInterop src/contracts/__tests__/git-provider-app-forks.spec.ts
 *
 * The runtime assertions in every block bind under `pnpm test` as well.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
	GitActionsPermissionsInput,
	GitActionsPermissionsResult,
	GitForkDivergence,
	GitForkSyncResult,
	GitProviderErrorDetails,
	GitProviderErrorReason,
	GitRepositoryCopyInput,
	GitRepositoryCopyResult,
	GitWebhookInput,
	GitWorkflowRef
} from '../capabilities/git-provider.app-forks.js';
import { GitProviderRequestError } from '../capabilities/git-provider.app-forks.js';
import type {
	ForkRepositoryOptions,
	GitBranch,
	GitRepository,
	GitRepositoryWithPermissions
} from '../capabilities/git-provider.interface.js';
import type { IGitProviderPlugin } from '../capabilities/git-provider.interface.js';
// Proves the barrel chain: package root -> contracts -> capabilities -> this module.
import type { GitProviderRequestError as BarrelGitProviderRequestError } from '../../index.js';

/**
 * `true` when `T[K]` may be omitted. Making any of the members below required
 * flips this to `false`, and the `toEqualTypeOf<true>()` assertion under it
 * stops compiling — that is the pin this file exists for.
 */
type IsOptional<T, K extends keyof T> = undefined extends T[K] ? true : false;

/** The nine members APW-02 T10 adds to `IGitProviderPlugin`, all optional. */
type ForkLifecycleMember =
	| 'findExistingFork'
	| 'syncForkBranch'
	| 'getForkDivergence'
	| 'createRepositoryCopy'
	| 'setActionsPermissions'
	| 'createWebhook'
	| 'deleteWebhook'
	| 'createBranchFromSha'
	| 'updateBranchRef';

/** The nine `GitRepository` facts APW-02 T9 adds, all optional. */
type RepositoryFact =
	| 'source'
	| 'allowForking'
	| 'archived'
	| 'visibility'
	| 'stars'
	| 'sizeKb'
	| 'licenseSpdx'
	| 'empty'
	| 'movedFrom';

/**
 * A git-provider plugin as it could be written BEFORE APW-02 P1: the same
 * interface with every new member removed.
 *
 * The assignment below is the additive-only proof. Every member removed here is
 * optional, so a plugin without them is still a valid `IGitProviderPlugin`; make
 * one of them required and `legacyPlugin` no longer satisfies the interface.
 */
type LegacyGitProvider = Omit<IGitProviderPlugin, ForkLifecycleMember | RepositoryFact>;

/**
 * The runtime shadow of {@link LegacyGitProvider} — one object implementing none
 * of the nine new members. The cast is deliberate: the type-level claim is the
 * `Omit<…>` above plus the assignment below, and this object is what the
 * calling-rule block inspects at runtime.
 */
const pluginWithoutNewMembers = { providerName: 'pre-apw-02-provider' } as unknown as LegacyGitProvider;

// If any new `IGitProviderPlugin` member became required, this line stops compiling.
const legacyPlugin: IGitProviderPlugin = pluginWithoutNewMembers;

describe('APW-02 T9/T10 — additive-only: pre-APW-02 plugins still satisfy the contract', () => {
	it('a plugin without any of the nine new members is assignable to IGitProviderPlugin', () => {
		// The assignment above is the assertion; this is its runtime shadow.
		expect(legacyPlugin).toBe(pluginWithoutNewMembers);
	});

	it('every new IGitProviderPlugin member is optional', () => {
		expectTypeOf<IsOptional<IGitProviderPlugin, 'findExistingFork'>>().toEqualTypeOf<true>();
		expectTypeOf<IsOptional<IGitProviderPlugin, 'syncForkBranch'>>().toEqualTypeOf<true>();
		expectTypeOf<IsOptional<IGitProviderPlugin, 'getForkDivergence'>>().toEqualTypeOf<true>();
		expectTypeOf<IsOptional<IGitProviderPlugin, 'createRepositoryCopy'>>().toEqualTypeOf<true>();
		expectTypeOf<IsOptional<IGitProviderPlugin, 'setActionsPermissions'>>().toEqualTypeOf<true>();
		expectTypeOf<IsOptional<IGitProviderPlugin, 'createWebhook'>>().toEqualTypeOf<true>();
		expectTypeOf<IsOptional<IGitProviderPlugin, 'deleteWebhook'>>().toEqualTypeOf<true>();
		expectTypeOf<IsOptional<IGitProviderPlugin, 'createBranchFromSha'>>().toEqualTypeOf<true>();
		expectTypeOf<IsOptional<IGitProviderPlugin, 'updateBranchRef'>>().toEqualTypeOf<true>();
	});

	it('every new GitRepository fact is optional (so no existing read must populate it)', () => {
		expectTypeOf<IsOptional<GitRepository, 'source'>>().toEqualTypeOf<true>();
		expectTypeOf<IsOptional<GitRepository, 'allowForking'>>().toEqualTypeOf<true>();
		expectTypeOf<IsOptional<GitRepository, 'archived'>>().toEqualTypeOf<true>();
		expectTypeOf<IsOptional<GitRepository, 'visibility'>>().toEqualTypeOf<true>();
		expectTypeOf<IsOptional<GitRepository, 'stars'>>().toEqualTypeOf<true>();
		expectTypeOf<IsOptional<GitRepository, 'sizeKb'>>().toEqualTypeOf<true>();
		expectTypeOf<IsOptional<GitRepository, 'licenseSpdx'>>().toEqualTypeOf<true>();
		expectTypeOf<IsOptional<GitRepository, 'empty'>>().toEqualTypeOf<true>();
		expectTypeOf<IsOptional<GitRepository, 'movedFrom'>>().toEqualTypeOf<true>();
	});

	it('the pre-existing members keep their exact signatures (additive, never narrowed)', () => {
		expectTypeOf<IGitProviderPlugin['getRepository']>().toEqualTypeOf<
			(owner: string, repo: string, token: string) => Promise<GitRepositoryWithPermissions | null>
		>();
		expectTypeOf<IGitProviderPlugin['createBranch']>().toEqualTypeOf<
			| ((owner: string, repo: string, name: string, fromRef: string, token: string) => Promise<GitBranch>)
			| undefined
		>();
		expectTypeOf<IGitProviderPlugin['forkRepository']>().toEqualTypeOf<
			| ((
					owner: string,
					repo: string,
					options: ForkRepositoryOptions,
					token: string
			  ) => Promise<GitRepository | null>)
			| undefined
		>();
	});

	it('the pre-existing GitRepository members stay required', () => {
		expectTypeOf<IsOptional<GitRepository, 'owner'>>().toEqualTypeOf<false>();
		expectTypeOf<IsOptional<GitRepository, 'name'>>().toEqualTypeOf<false>();
		expectTypeOf<IsOptional<GitRepository, 'fullName'>>().toEqualTypeOf<false>();
		expectTypeOf<IsOptional<GitRepository, 'defaultBranch'>>().toEqualTypeOf<false>();
		expectTypeOf<IsOptional<GitRepository, 'isPrivate'>>().toEqualTypeOf<false>();
		expectTypeOf<IsOptional<GitRepository, 'url'>>().toEqualTypeOf<false>();
		expectTypeOf<IsOptional<GitRepository, 'cloneUrl'>>().toEqualTypeOf<false>();
	});
});

describe('APW-02 T9 — the typed error reason vocabulary', () => {
	it('is exactly the nine reasons of plan §3.3, no more and no fewer', () => {
		const reasons = [
			'not_found',
			'unauthorized',
			'rate_limited',
			'secondary_rate_limited',
			'sso_authorization_required',
			'oauth_app_restricted',
			'permission_missing',
			'conflict',
			'unprocessable'
		] as const satisfies readonly GitProviderErrorReason[];

		// Exact in both directions: a missing member fails `satisfies`, an extra
		// member fails the `toEqualTypeOf` below.
		expectTypeOf<GitProviderErrorReason>().toEqualTypeOf<(typeof reasons)[number]>();
		expect(reasons).toHaveLength(9);
	});

	it('the details bag carries exactly retryAt and permission', () => {
		expectTypeOf<keyof GitProviderErrorDetails>().toEqualTypeOf<'retryAt' | 'permission'>();
		expectTypeOf<GitProviderErrorDetails['retryAt']>().toEqualTypeOf<string | undefined>();
		expectTypeOf<GitProviderErrorDetails['permission']>().toEqualTypeOf<
			'contents' | 'pull_requests' | 'administration' | 'actions' | 'webhooks' | 'metadata' | undefined
		>();
	});

	it('the error class keeps reason / status / details and extends Error', () => {
		type Ctor = ConstructorParameters<typeof GitProviderRequestError>;
		expectTypeOf<Ctor[0]>().toEqualTypeOf<GitProviderErrorReason>();
		expectTypeOf<Ctor[1]>().toEqualTypeOf<number>();
		expectTypeOf<Ctor[2]>().toEqualTypeOf<GitProviderErrorDetails | undefined>();
		expectTypeOf<GitProviderRequestError>().toExtend<Error>();
		expectTypeOf<GitProviderRequestError['reason']>().toEqualTypeOf<GitProviderErrorReason>();
		expectTypeOf<GitProviderRequestError['status']>().toEqualTypeOf<number>();
		expectTypeOf<GitProviderRequestError['details']>().toEqualTypeOf<GitProviderErrorDetails>();
	});
});

describe('APW-02 T10 — every member keeps plan §3.3’s exact signature', () => {
	it('findExistingFork(upstreamOwner, upstreamRepo, targetOwner, token)', () => {
		type M = NonNullable<IGitProviderPlugin['findExistingFork']>;
		expectTypeOf<Parameters<M>>().toEqualTypeOf<[string, string, string, string]>();
		expectTypeOf<ReturnType<M>>().toEqualTypeOf<Promise<GitRepository | null>>();
	});

	it('syncForkBranch(forkOwner, forkRepo, branch, token)', () => {
		type M = NonNullable<IGitProviderPlugin['syncForkBranch']>;
		expectTypeOf<Parameters<M>>().toEqualTypeOf<[string, string, string, string]>();
		expectTypeOf<ReturnType<M>>().toEqualTypeOf<Promise<GitForkSyncResult>>();
	});

	it('getForkDivergence(forkOwner, forkRepo, forkBranch, upstreamOwner, upstreamBranch, token)', () => {
		type M = NonNullable<IGitProviderPlugin['getForkDivergence']>;
		expectTypeOf<Parameters<M>>().toEqualTypeOf<[string, string, string, string, string, string]>();
		expectTypeOf<ReturnType<M>>().toEqualTypeOf<Promise<GitForkDivergence>>();
	});

	it('createRepositoryCopy(input, token)', () => {
		type M = NonNullable<IGitProviderPlugin['createRepositoryCopy']>;
		expectTypeOf<Parameters<M>>().toEqualTypeOf<[GitRepositoryCopyInput, string]>();
		expectTypeOf<ReturnType<M>>().toEqualTypeOf<Promise<GitRepositoryCopyResult>>();
	});

	it('setActionsPermissions(owner, repo, input, token)', () => {
		type M = NonNullable<IGitProviderPlugin['setActionsPermissions']>;
		expectTypeOf<Parameters<M>>().toEqualTypeOf<[string, string, GitActionsPermissionsInput, string]>();
		expectTypeOf<ReturnType<M>>().toEqualTypeOf<Promise<GitActionsPermissionsResult>>();
	});

	it('createWebhook(owner, repo, input, token) -> { id, created }', () => {
		type M = NonNullable<IGitProviderPlugin['createWebhook']>;
		expectTypeOf<Parameters<M>>().toEqualTypeOf<[string, string, GitWebhookInput, string]>();
		expectTypeOf<ReturnType<M>>().toEqualTypeOf<Promise<{ id: number; created: boolean }>>();
	});

	it('deleteWebhook(owner, repo, hookId, token) -> void', () => {
		type M = NonNullable<IGitProviderPlugin['deleteWebhook']>;
		expectTypeOf<Parameters<M>>().toEqualTypeOf<[string, string, number, string]>();
		expectTypeOf<ReturnType<M>>().toEqualTypeOf<Promise<void>>();
	});

	it('createBranchFromSha(owner, repo, name, sha, token) — APW-09’s signature', () => {
		type M = NonNullable<IGitProviderPlugin['createBranchFromSha']>;
		expectTypeOf<Parameters<M>>().toEqualTypeOf<[string, string, string, string, string]>();
		expectTypeOf<ReturnType<M>>().toEqualTypeOf<Promise<GitBranch>>();
	});

	it('updateBranchRef(owner, repo, name, sha, { force: false }, token) — fast-forward only', () => {
		type M = NonNullable<IGitProviderPlugin['updateBranchRef']>;
		expectTypeOf<Parameters<M>[0]>().toEqualTypeOf<string>();
		expectTypeOf<Parameters<M>[1]>().toEqualTypeOf<string>();
		expectTypeOf<Parameters<M>[2]>().toEqualTypeOf<string>();
		expectTypeOf<Parameters<M>[3]>().toEqualTypeOf<string>();
		expectTypeOf<Parameters<M>[4]>().toEqualTypeOf<{ force: false }>();
		expectTypeOf<Parameters<M>[5]>().toEqualTypeOf<string>();
		expectTypeOf<ReturnType<M>>().toEqualTypeOf<Promise<GitBranch>>();
	});
});

describe('APW-02 T9 — the types keep plan §3.3’s exact shape', () => {
	it('GitForkSyncResult.outcome is the five-value union', () => {
		expectTypeOf<GitForkSyncResult['outcome']>().toEqualTypeOf<
			'fast_forwarded' | 'merged' | 'up_to_date' | 'conflict' | 'unprocessable'
		>();
		expectTypeOf<GitForkSyncResult['baseBranch']>().toEqualTypeOf<string | undefined>();
	});

	it('GitForkDivergence carries the four numbers/shas', () => {
		expectTypeOf<keyof GitForkDivergence>().toEqualTypeOf<
			'aheadBy' | 'behindBy' | 'upstreamHeadSha' | 'forkHeadSha'
		>();
		expectTypeOf<GitForkDivergence['aheadBy']>().toEqualTypeOf<number>();
		expectTypeOf<GitForkDivergence['behindBy']>().toEqualTypeOf<number>();
		expectTypeOf<GitForkDivergence['upstreamHeadSha']>().toEqualTypeOf<string>();
		expectTypeOf<GitForkDivergence['forkHeadSha']>().toEqualTypeOf<string>();
	});

	it('GitRepositoryCopyInput / Result carry every field of plan §3.3', () => {
		expectTypeOf<keyof GitRepositoryCopyInput>().toEqualTypeOf<
			'sourceOwner' | 'sourceRepo' | 'sourceBranch' | 'targetOwner' | 'targetRepo' | 'maxSizeKb' | 'branchName'
		>();
		expectTypeOf<GitRepositoryCopyInput['maxSizeKb']>().toEqualTypeOf<number>();
		expectTypeOf<GitRepositoryCopyInput['branchName']>().toEqualTypeOf<string | undefined>();
		expectTypeOf<keyof GitRepositoryCopyResult>().toEqualTypeOf<'pushedSha' | 'alreadyUpToDate'>();
		expectTypeOf<GitRepositoryCopyResult['alreadyUpToDate']>().toEqualTypeOf<boolean>();
	});

	it('GitWorkflowRef is { id, path }', () => {
		expectTypeOf<keyof GitWorkflowRef>().toEqualTypeOf<'id' | 'path'>();
		expectTypeOf<GitWorkflowRef['id']>().toEqualTypeOf<number>();
		expectTypeOf<GitWorkflowRef['path']>().toEqualTypeOf<string>();
	});

	it('GitActionsPermissionsInput is all-optional, with readonly arrays', () => {
		expectTypeOf<keyof GitActionsPermissionsInput>().toEqualTypeOf<
			'enabled' | 'disableWorkflowsExcept' | 'enableWorkflows' | 'skipWorkflowIds' | 'maxWorkflows'
		>();
		expectTypeOf<IsOptional<GitActionsPermissionsInput, 'enabled'>>().toEqualTypeOf<true>();
		expectTypeOf<IsOptional<GitActionsPermissionsInput, 'disableWorkflowsExcept'>>().toEqualTypeOf<true>();
		expectTypeOf<IsOptional<GitActionsPermissionsInput, 'enableWorkflows'>>().toEqualTypeOf<true>();
		expectTypeOf<IsOptional<GitActionsPermissionsInput, 'skipWorkflowIds'>>().toEqualTypeOf<true>();
		expectTypeOf<IsOptional<GitActionsPermissionsInput, 'maxWorkflows'>>().toEqualTypeOf<true>();
		expectTypeOf<GitActionsPermissionsInput['disableWorkflowsExcept']>().toEqualTypeOf<
			readonly string[] | undefined
		>();
		expectTypeOf<GitActionsPermissionsInput['skipWorkflowIds']>().toEqualTypeOf<readonly number[] | undefined>();
	});

	it('GitActionsPermissionsResult reports what was done, including the truncation flag', () => {
		expectTypeOf<keyof GitActionsPermissionsResult>().toEqualTypeOf<
			'actionsEnabled' | 'disabled' | 'kept' | 'enabled' | 'seenIds' | 'truncated'
		>();
		expectTypeOf<GitActionsPermissionsResult['actionsEnabled']>().toEqualTypeOf<boolean>();
		expectTypeOf<GitActionsPermissionsResult['disabled']>().toEqualTypeOf<readonly GitWorkflowRef[]>();
		expectTypeOf<GitActionsPermissionsResult['kept']>().toEqualTypeOf<readonly GitWorkflowRef[]>();
		expectTypeOf<GitActionsPermissionsResult['enabled']>().toEqualTypeOf<readonly GitWorkflowRef[]>();
		expectTypeOf<GitActionsPermissionsResult['seenIds']>().toEqualTypeOf<readonly number[]>();
		expectTypeOf<GitActionsPermissionsResult['truncated']>().toEqualTypeOf<boolean>();
	});

	it('GitWebhookInput is { url, secret, events }', () => {
		expectTypeOf<keyof GitWebhookInput>().toEqualTypeOf<'url' | 'secret' | 'events'>();
		expectTypeOf<GitWebhookInput['events']>().toEqualTypeOf<readonly string[]>();
	});

	it('GitRepository.visibility keeps the provider’s three values', () => {
		expectTypeOf<GitRepository['visibility']>().toEqualTypeOf<'public' | 'private' | 'internal' | undefined>();
		expectTypeOf<GitRepository['licenseSpdx']>().toEqualTypeOf<string | null | undefined>();
		expectTypeOf<GitRepository['source']>().toEqualTypeOf<
			{ readonly owner: string; readonly name: string; readonly fullName: string } | undefined
		>();
	});

	it('the types travel through the package barrel (`contracts -> capabilities`)', () => {
		expectTypeOf<BarrelGitProviderRequestError>().toEqualTypeOf<GitProviderRequestError>();
	});
});

describe('APW-02 T9 — GitProviderRequestError keeps reason / status / details', () => {
	it('is an instance of Error and of itself', () => {
		const error = new GitProviderRequestError('not_found', 404);

		expect(error).toBeInstanceOf(Error);
		expect(error).toBeInstanceOf(GitProviderRequestError);
	});

	it('keeps reason, status and an empty details bag when none is given', () => {
		const error = new GitProviderRequestError('rate_limited', 429);

		expect(error.reason).toBe('rate_limited');
		expect(error.status).toBe(429);
		expect(error.details).toEqual({});
		expect(error.message).toBe('rate_limited');
	});

	it('keeps the details it was given', () => {
		const error = new GitProviderRequestError('secondary_rate_limited', 403, {
			retryAt: '2026-09-17T12:00:00.000Z'
		});

		expect(error.details.retryAt).toBe('2026-09-17T12:00:00.000Z');
		expect(error.details.permission).toBeUndefined();
	});

	it('keeps the missing permission, so a hygiene refusal is actionable', () => {
		const error = new GitProviderRequestError('permission_missing', 403, { permission: 'actions' });

		expect(error.reason).toBe('permission_missing');
		expect(error.status).toBe(403);
		expect(error.details).toEqual({ permission: 'actions' });
	});

	it('does not share one details object between instances', () => {
		const first = new GitProviderRequestError('conflict', 409);
		const second = new GitProviderRequestError('conflict', 409);

		expect(first.details).not.toBe(second.details);
	});

	it('survives every reason of the vocabulary', () => {
		const reasons: readonly GitProviderErrorReason[] = [
			'not_found',
			'unauthorized',
			'rate_limited',
			'secondary_rate_limited',
			'sso_authorization_required',
			'oauth_app_restricted',
			'permission_missing',
			'conflict',
			'unprocessable'
		];

		for (const reason of reasons) {
			const error = new GitProviderRequestError(reason, 400);
			expect(error.reason).toBe(reason);
			expect(error).toBeInstanceOf(GitProviderRequestError);
		}
	});

	it('is catchable as an Error, which is what makes `reason` usable at a call site', () => {
		const thrower = (): never => {
			throw new GitProviderRequestError('unprocessable', 422, { retryAt: '2026-09-17T12:00:00.000Z' });
		};

		try {
			thrower();
			expect.unreachable('the call must throw');
		} catch (caught) {
			expect(caught).toBeInstanceOf(Error);
			expect(caught).toBeInstanceOf(GitProviderRequestError);
			const error = caught as GitProviderRequestError;
			expect(error.reason).toBe('unprocessable');
			expect(error.status).toBe(422);
			expect(error.details.retryAt).toBe('2026-09-17T12:00:00.000Z');
		}
	});
});

describe('APW-02 T10 — the lazy-plugin calling rule the JSDoc states', () => {
	it('a plugin without the optional members reports them absent, so a caller refuses instead of crashing', () => {
		// The rule: materialise `plugin.<method>` and test it, because the
		// lazy-plugin proxy over-reports optional methods. On a plugin that
		// implements none of the nine, the test is `false` for all nine.
		const legacy = pluginWithoutNewMembers as unknown as Record<string, unknown>;

		for (const member of [
			'findExistingFork',
			'syncForkBranch',
			'getForkDivergence',
			'createRepositoryCopy',
			'setActionsPermissions',
			'createWebhook',
			'deleteWebhook',
			'createBranchFromSha',
			'updateBranchRef'
		] satisfies readonly ForkLifecycleMember[]) {
			expect(typeof legacy[member]).toBe('undefined');
		}
	});
});
