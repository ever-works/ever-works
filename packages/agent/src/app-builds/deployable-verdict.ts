import {
    computeBuildInputsHash,
    evaluateBuildDeployability,
    type AppBuildDeployabilityInput,
    type AppBuildKind,
    type AppBuildNotDeployableReason,
    type AppBuildScanSummary,
    type AppBuildSecretCheckResult,
    type AppBuildSignatureState,
    type AppBuildStatus,
    type AppBuildTrigger,
    type AppBuildValueFingerprint,
} from '@ever-works/contracts';

/**
 * APW-05 T17 — the deployable verdict of plan §5.1 (`plan.md:1243-1265`), FR-31.
 *
 * ## The clause order IS the answer
 *
 * ```
 * deployable = status == succeeded
 *           && trigger in (push, manual) && branch == trackedBranch
 *           && specValidAtCommit == true
 *           && secretsSyncedAt <= startedAt && buildInputsHash == currentInputsHash
 *           && secretCheck in (passed, not_needed)
 *           && digestConfirmed
 *           && (buildKind != apps-builder || (signatureState == signed
 *               && !(policy.blockFixableCritical && scan.fixableCritical > 0)))
 * ```
 *
 * "The first failing clause, in that order, becomes `notDeployableReason`"
 * (`plan.md:1255`). A Build can fail several clauses at once, and the reason the
 * owner sees is the FIRST one — which is why every case in
 * `__tests__/deployable-verdict.spec.ts` is paired with a
 * "fails this clause *and* a later one" case: the pair is what pins the order,
 * not the single-clause case.
 *
 * ## The evaluator is inherited, not restated
 *
 * `evaluateBuildDeployability` and `computeBuildInputsHash` are **already
 * declared and landed** in `packages/contracts/src/apps/builds.ts` (T1,
 * `builds.ts:775` and `:871`), and §5.1 says so explicitly: `secret-sync.ts` and
 * this verdict call the very same function "so the two can never drift"
 * (`plan.md:1259`). This module therefore does not re-implement the clauses — a
 * second copy is exactly the drift R-1 exists to prevent. What it adds is the
 * **reader**: it turns a `work_builds` row plus the resolver's current
 * fingerprints into the contracts input, in one place, so no caller can pass the
 * terms in a different order or forget the NULL-is-`staleInputs` rule.
 *
 * ## The two terms §5.1 spells out, in code
 *
 * - A **NULL `buildInputsHash` or `secretsSyncedAt` is `staleInputs`**
 *   (`plan.md:1260`) — not "unknown", not "skip the clause".
 * - A preparation that synced **zero** values still records `secretsSyncedAt` and
 *   the hash of the empty list, so it **passes** that clause rather than failing
 *   it (`plan.md:1263-1265`). `computeBuildInputsHash([])` is `sha256("")`, and
 *   an unreadable fingerprint map (`null`) is reported as `staleInputs` by
 *   {@link evaluateBuildVerdict} rather than being hashed as empty — "cannot
 *   answer" and "answered: nothing" are different facts.
 */

/**
 * The clause order of §5.1, as the reason each clause produces.
 *
 * `verification` sits before `pullRequest` because §5.1's second clause is
 * `trigger in (push, manual)`, and FR-54 splits the two non-deployable triggers:
 * a verification Build is refused as `verification` and every other
 * non-deployable trigger — i.e. a pull-request run — as `pullRequest`. The
 * branch comparison is the same clause and also answers `pullRequest`.
 */
export const DEPLOYABLE_VERDICT_CLAUSE_ORDER = [
    'notSucceeded',
    'verification',
    'pullRequest',
    'specInvalid',
    'staleInputs',
    'secretCheckFailed',
    'digestUnconfirmed',
    'unsigned',
    'criticalVulnerability',
] as const satisfies readonly AppBuildNotDeployableReason[];

/** One clause of §5.1's chain, in order. */
export type DeployableVerdictClause = (typeof DEPLOYABLE_VERDICT_CLAUSE_ORDER)[number];

/**
 * The `work_builds` columns §5.1 reads, and nothing else.
 *
 * Deliberately a structural subset of `WorkBuild` rather than the entity: the
 * verdict is a pure function of these nine terms, so a spec can state a case
 * without constructing a row, and adding a column to the table cannot silently
 * change the verdict.
 */
export interface AppBuildVerdictRow {
    readonly status: AppBuildStatus;
    readonly trigger: AppBuildTrigger;
    readonly branch: string;
    /** `getEffectiveSpec(workId, sha)`'s verdict at this commit; `null` counts as not valid. */
    readonly specValidAtCommit: boolean | null;
    /** `secretsSyncedAt`; `null` is `staleInputs` — see the module docstring. */
    readonly secretsSyncedAt: Date | number | null;
    /** `startedAt`; the sync must not be later than it (`plan.md:1261-1263`). */
    readonly startedAt: Date | number | null;
    /** `buildInputsHash`; `null` is `staleInputs` — see the module docstring. */
    readonly buildInputsHash: string | null;
    readonly secretCheck: AppBuildSecretCheckResult | null;
    readonly digestConfirmed: boolean;
}

/** The reader's input: the row, the Work's tracked branch, and today's fingerprints. */
export interface AppBuildVerdictInput {
    readonly build: AppBuildVerdictRow;
    /** The App Work's tracked branch — §5.1's `branch == trackedBranch` clause. */
    readonly trackedBranch: string;
    /**
     * The resolver's CURRENT `(name, fingerprint)` pairs — APW-07's
     * `resolveForBuild(workId, build.services)` fingerprints, or
     * `APP_ENV_RESOLVER_FINGERPRINTS.read(workId, 'build')`.
     *
     * `null` means "the resolver could not answer", which §5.1 treats exactly as a
     * mismatch: the recorded hash cannot be confirmed against a value nobody
     * could compute, so the Build is `staleInputs`.
     */
    readonly currentValues: readonly AppBuildValueFingerprint[] | null;
    /** The resolved build plugin's kind; only `apps-builder` has the last clause. */
    readonly buildKind: AppBuildKind;
    /** `work_builds.signatureState` — P3, `null` until the managed builder records one. */
    readonly signatureState?: AppBuildSignatureState | null;
    /** `work_builds.scanSummary` — P3; `null` counts as no fixable critical. */
    readonly scan?: AppBuildScanSummary | null;
    /** The tier's policy for blocking fixable criticals; defaults to "do not block". */
    readonly policy?: { readonly blockFixableCritical: boolean };
}

/** What the verdict answers — the two columns `finalize` writes. */
export interface AppBuildVerdict {
    readonly deployable: boolean;
    readonly notDeployableReason: AppBuildNotDeployableReason | null;
}

/**
 * `computeBuildInputsHash` over the resolver's current fingerprints.
 *
 * The SAME function `secret-sync.ts` uses when a preparation records the hash
 * (`plan.md:1259`), reached through this module so `finalize` has exactly one
 * import for both terms of the clause.
 */
export function computeCurrentInputsHash(values: readonly AppBuildValueFingerprint[]): string {
    return computeBuildInputsHash(values);
}

/**
 * The `(name, fingerprint)` pairs of a resolver map.
 *
 * `APP_ENV_RESOLVER_FINGERPRINTS.read` answers `Record<name, fingerprint> | null`
 * (`app-env.service.ts:317`); the hash takes pairs, and the ordering of a
 * `Record` is not a property worth relying on — `computeBuildInputsHash` sorts,
 * so this mapping is a pure shape change.
 */
export function fingerprintsToValues(
    fingerprints: Readonly<Record<string, string>>,
): AppBuildValueFingerprint[] {
    return Object.entries(fingerprints).map(([name, fingerprint]) => ({ name, fingerprint }));
}

/** `Date | number | null` → epoch milliseconds, or `null` for "never happened". */
function epochMs(value: Date | number | null): number | null {
    if (value === null) return null;
    return value instanceof Date ? value.getTime() : value;
}

/**
 * The deployable verdict of §5.1, clause by clause, first failing clause wins.
 *
 * See the module docstring: the clauses themselves are inherited from
 * `evaluateBuildDeployability`; this is the reader that builds its input
 * correctly, including the two NULL rules and the "cannot answer ⇒ `staleInputs`"
 * rule.
 */
export function evaluateBuildVerdict(input: AppBuildVerdictInput): AppBuildVerdict {
    const build = input.build;

    const deployabilityInput: AppBuildDeployabilityInput = {
        status: build.status,
        trigger: build.trigger,
        branch: build.branch,
        trackedBranch: input.trackedBranch,
        specValidAtCommit: build.specValidAtCommit,
        secretsSyncedAtEpochMs: epochMs(build.secretsSyncedAt),
        startedAtEpochMs: epochMs(build.startedAt),
        buildInputsHash: build.buildInputsHash,
        // A resolver that could not answer is a mismatch, never an empty list:
        // `computeBuildInputsHash([])` is a REAL hash (the zero-values case that
        // must pass), so hashing an unanswerable resolver would silently make a
        // Build deployable on no evidence.
        currentInputsHash:
            input.currentValues === null
                ? UNRESOLVED_INPUTS_HASH
                : computeCurrentInputsHash(input.currentValues),
        secretCheck: build.secretCheck,
        digestConfirmed: build.digestConfirmed,
        buildKind: input.buildKind,
        signatureState: input.signatureState ?? null,
        scan: input.scan ?? null,
        policy: input.policy ?? { blockFixableCritical: false },
    };

    return evaluateBuildDeployability(deployabilityInput);
}

/**
 * The stand-in `currentInputsHash` used when the resolver could not answer.
 *
 * It is deliberately NOT a hash of anything — it can never equal a recorded
 * `buildInputsHash` (which is 64 lower-case hex characters), so the comparison in
 * §5.1's `staleInputs` clause fails on its own, without this module having to
 * duplicate the clause.
 */
const UNRESOLVED_INPUTS_HASH = '\u0000unresolved';
