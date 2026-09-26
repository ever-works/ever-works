import {
    APP_BUILD_NOT_DEPLOYABLE_REASONS,
    appBuildEventNameForStatus,
    computeBuildInputsHash,
    type AppBuildValueFingerprint,
} from '@ever-works/contracts';
import {
    DEPLOYABLE_VERDICT_CLAUSE_ORDER,
    computeCurrentInputsHash,
    evaluateBuildVerdict,
    fingerprintsToValues,
    type AppBuildVerdictInput,
    type AppBuildVerdictRow,
} from '../deployable-verdict';

/**
 * APW-05 T17 — the deployable verdict of plan §5.1 (`plan.md:1243-1265`),
 * `APW05-G03`, FR-31.
 *
 * ## Why every case is a PAIR
 *
 * "The first failing clause, in that order, becomes `notDeployableReason`"
 * (`plan.md:1255`). A single-clause case cannot tell an ordered chain from a set
 * of independent checks — the answer is the same either way. So each clause below
 * is asserted twice: once alone, and once **together with a later clause that also
 * fails**, where the expected answer is the EARLIER one. A reordering mutation
 * turns the second assertion red and leaves the first green, which is exactly the
 * property §5.1 is about.
 */

const SYNCED_AT = new Date('2026-09-17T10:00:00.000Z');
const STARTED_AT = new Date('2026-09-17T10:05:00.000Z');

/** One value list whose hash is a real, recorded answer. */
const VALUES: readonly AppBuildValueFingerprint[] = [
    { name: 'DATABASE_URL', fingerprint: 'v3' },
    { name: 'APP_SECRET', fingerprint: 'v7' },
];

const RECORDED_HASH = computeBuildInputsHash(VALUES);

/** Every clause of §5.1 satisfied; a case overrides only what it is about. */
function row(overrides: Partial<AppBuildVerdictRow> = {}): AppBuildVerdictRow {
    return {
        status: 'succeeded',
        trigger: 'push',
        branch: 'main',
        specValidAtCommit: true,
        secretsSyncedAt: SYNCED_AT,
        startedAt: STARTED_AT,
        buildInputsHash: RECORDED_HASH,
        secretCheck: 'passed',
        digestConfirmed: true,
        ...overrides,
    };
}

function input(overrides: Partial<AppBuildVerdictInput> = {}): AppBuildVerdictInput {
    return {
        build: row(),
        trackedBranch: 'main',
        currentValues: VALUES,
        buildKind: 'github-actions',
        ...overrides,
    };
}

describe('the deployable verdict (plan §5.1, APW05-G03)', () => {
    it('declares the clause order §5.1 states, and every reason is a contracts member', () => {
        expect(DEPLOYABLE_VERDICT_CLAUSE_ORDER).toEqual([
            'notSucceeded',
            'verification',
            'pullRequest',
            'specInvalid',
            'staleInputs',
            'secretCheckFailed',
            'digestUnconfirmed',
            'unsigned',
            'criticalVulnerability',
        ]);
        for (const clause of DEPLOYABLE_VERDICT_CLAUSE_ORDER) {
            expect(APP_BUILD_NOT_DEPLOYABLE_REASONS).toContain(clause);
        }
    });

    it('passes a succeeded push Build of the tracked branch with confirmed inputs', () => {
        expect(evaluateBuildVerdict(input())).toEqual({
            deployable: true,
            notDeployableReason: null,
        });
    });

    /* ---------------------------------------------------------------------- *
     * Clause 1 — status == succeeded
     * ---------------------------------------------------------------------- */

    describe('clause 1 — status', () => {
        it.each(['queued', 'running', 'failed', 'cancelled', 'blocked'] as const)(
            'a %s Build is notSucceeded',
            (status) => {
                expect(evaluateBuildVerdict(input({ build: row({ status }) }))).toEqual({
                    deployable: false,
                    notDeployableReason: 'notSucceeded',
                });
            },
        );

        it('wins over every later clause (order, not membership)', () => {
            // Also a pull request, also spec-invalid, also stale: still clause 1.
            expect(
                evaluateBuildVerdict(
                    input({
                        build: row({
                            status: 'failed',
                            trigger: 'pull_request',
                            specValidAtCommit: false,
                            buildInputsHash: 'stale',
                            secretCheck: 'failed',
                            digestConfirmed: false,
                        }),
                    }),
                ),
            ).toEqual({ deployable: false, notDeployableReason: 'notSucceeded' });
        });
    });

    /* ---------------------------------------------------------------------- *
     * Clause 2 — trigger in (push, manual), split by FR-54
     * ---------------------------------------------------------------------- */

    describe('clause 2 — trigger and branch', () => {
        it('a verification Build is `verification` (ACC-05-23)', () => {
            expect(
                evaluateBuildVerdict(input({ build: row({ trigger: 'verification' }) })),
            ).toEqual({ deployable: false, notDeployableReason: 'verification' });
        });

        it('a pull-request Build is `pullRequest`', () => {
            expect(
                evaluateBuildVerdict(input({ build: row({ trigger: 'pull_request' }) })),
            ).toEqual({ deployable: false, notDeployableReason: 'pullRequest' });
        });

        it('a manual Build of the tracked branch is deployable', () => {
            expect(evaluateBuildVerdict(input({ build: row({ trigger: 'manual' }) }))).toEqual({
                deployable: true,
                notDeployableReason: null,
            });
        });

        it('a Build of another branch is `pullRequest` even when its trigger is push', () => {
            expect(evaluateBuildVerdict(input({ build: row({ branch: 'feature/x' }) }))).toEqual({
                deployable: false,
                notDeployableReason: 'pullRequest',
            });
        });

        it('`verification` beats `pullRequest`-shaped later failures', () => {
            expect(
                evaluateBuildVerdict(
                    input({
                        build: row({
                            trigger: 'verification',
                            specValidAtCommit: false,
                            digestConfirmed: false,
                        }),
                    }),
                ),
            ).toEqual({ deployable: false, notDeployableReason: 'verification' });
        });

        it('the branch clause beats specInvalid, staleInputs and the rest', () => {
            expect(
                evaluateBuildVerdict(
                    input({
                        build: row({
                            branch: 'other',
                            specValidAtCommit: false,
                            buildInputsHash: null,
                            secretCheck: 'failed',
                            digestConfirmed: false,
                        }),
                    }),
                ),
            ).toEqual({ deployable: false, notDeployableReason: 'pullRequest' });
        });
    });

    /* ---------------------------------------------------------------------- *
     * Clause 3 — specValidAtCommit
     * ---------------------------------------------------------------------- */

    describe('clause 3 — specValidAtCommit', () => {
        it('specValidAtCommit: false is `specInvalid`', () => {
            expect(
                evaluateBuildVerdict(input({ build: row({ specValidAtCommit: false }) })),
            ).toEqual({ deployable: false, notDeployableReason: 'specInvalid' });
        });

        it('a NULL specValidAtCommit counts as not valid', () => {
            expect(
                evaluateBuildVerdict(input({ build: row({ specValidAtCommit: null }) })),
            ).toEqual({ deployable: false, notDeployableReason: 'specInvalid' });
        });

        it('beats staleInputs, secretCheckFailed and digestUnconfirmed', () => {
            expect(
                evaluateBuildVerdict(
                    input({
                        build: row({
                            specValidAtCommit: false,
                            secretsSyncedAt: null,
                            secretCheck: 'failed',
                            digestConfirmed: false,
                        }),
                    }),
                ),
            ).toEqual({ deployable: false, notDeployableReason: 'specInvalid' });
        });
    });

    /* ---------------------------------------------------------------------- *
     * Clause 4 — secretsSyncedAt <= startedAt && buildInputsHash == currentInputsHash
     * ---------------------------------------------------------------------- */

    describe('clause 4 — staleInputs', () => {
        it('a rotated value (the recorded hash differs from today’s) is `staleInputs` (ACC-05-16)', () => {
            const rotated: readonly AppBuildValueFingerprint[] = [
                { name: 'DATABASE_URL', fingerprint: 'v3' },
                { name: 'APP_SECRET', fingerprint: 'v8' },
            ];
            expect(evaluateBuildVerdict(input({ currentValues: rotated }))).toEqual({
                deployable: false,
                notDeployableReason: 'staleInputs',
            });
        });

        it('a NULL buildInputsHash is `staleInputs`', () => {
            expect(evaluateBuildVerdict(input({ build: row({ buildInputsHash: null }) }))).toEqual({
                deployable: false,
                notDeployableReason: 'staleInputs',
            });
        });

        it('a NULL secretsSyncedAt is `staleInputs`', () => {
            expect(evaluateBuildVerdict(input({ build: row({ secretsSyncedAt: null }) }))).toEqual({
                deployable: false,
                notDeployableReason: 'staleInputs',
            });
        });

        it('a sync that finished AFTER the run started is `staleInputs` (S24)', () => {
            const later = new Date(STARTED_AT.getTime() + 1_000);
            expect(evaluateBuildVerdict(input({ build: row({ secretsSyncedAt: later }) }))).toEqual(
                { deployable: false, notDeployableReason: 'staleInputs' },
            );
        });

        it('a sync at exactly startedAt passes the clause', () => {
            expect(
                evaluateBuildVerdict(input({ build: row({ secretsSyncedAt: STARTED_AT }) })),
            ).toEqual({ deployable: true, notDeployableReason: null });
        });

        it('a preparation that synced ZERO values passes the clause', () => {
            // "A preparation that synced zero values still records secretsSyncedAt
            // and the hash of the empty list, so a push Build of an App Work with no
            // build values passes this clause rather than failing it"
            // — plan §5.1:1263-1265.
            const empty = computeBuildInputsHash([]);
            expect(empty).toBe(computeCurrentInputsHash([]));
            expect(
                evaluateBuildVerdict(
                    input({
                        build: row({ buildInputsHash: empty }),
                        currentValues: [],
                    }),
                ),
            ).toEqual({ deployable: true, notDeployableReason: null });
        });

        it('a resolver that cannot answer is `staleInputs`, not "no values"', () => {
            // The empty list is a REAL answer that must pass (the case above);
            // `null` is "nobody could compute it", and hashing it as empty would make
            // a Build deployable on no evidence.
            const empty = computeBuildInputsHash([]);
            expect(
                evaluateBuildVerdict(
                    input({ build: row({ buildInputsHash: empty }), currentValues: null }),
                ),
            ).toEqual({ deployable: false, notDeployableReason: 'staleInputs' });
        });

        it('a NULL startedAt is `staleInputs` — the freshness clock has no anchor', () => {
            expect(evaluateBuildVerdict(input({ build: row({ startedAt: null }) }))).toEqual({
                deployable: false,
                notDeployableReason: 'staleInputs',
            });
        });

        it('beats secretCheckFailed and digestUnconfirmed', () => {
            expect(
                evaluateBuildVerdict(
                    input({
                        build: row({
                            buildInputsHash: null,
                            secretCheck: 'failed',
                            digestConfirmed: false,
                        }),
                    }),
                ),
            ).toEqual({ deployable: false, notDeployableReason: 'staleInputs' });
        });
    });

    /* ---------------------------------------------------------------------- *
     * Clause 5 — secretCheck in (passed, not_needed)
     * ---------------------------------------------------------------------- */

    describe('clause 5 — secretCheckFailed', () => {
        it('secretCheck failed is `secretCheckFailed`', () => {
            expect(evaluateBuildVerdict(input({ build: row({ secretCheck: 'failed' }) }))).toEqual({
                deployable: false,
                notDeployableReason: 'secretCheckFailed',
            });
        });

        it('a NULL secretCheck (the check never ran) is also `secretCheckFailed`', () => {
            expect(evaluateBuildVerdict(input({ build: row({ secretCheck: null }) }))).toEqual({
                deployable: false,
                notDeployableReason: 'secretCheckFailed',
            });
        });

        it('not_needed passes — an App Work with no secret build values', () => {
            expect(
                evaluateBuildVerdict(input({ build: row({ secretCheck: 'not_needed' }) })),
            ).toEqual({ deployable: true, notDeployableReason: null });
        });

        it('beats digestUnconfirmed', () => {
            expect(
                evaluateBuildVerdict(
                    input({ build: row({ secretCheck: 'failed', digestConfirmed: false }) }),
                ),
            ).toEqual({ deployable: false, notDeployableReason: 'secretCheckFailed' });
        });
    });

    /* ---------------------------------------------------------------------- *
     * Clause 6 — digestConfirmed
     * ---------------------------------------------------------------------- */

    describe('clause 6 — digestUnconfirmed', () => {
        it('an unconfirmed digest is `digestUnconfirmed`', () => {
            expect(evaluateBuildVerdict(input({ build: row({ digestConfirmed: false }) }))).toEqual(
                { deployable: false, notDeployableReason: 'digestUnconfirmed' },
            );
        });

        it('is the LAST clause for a github-actions Build — nothing after it can fire', () => {
            // `apps-builder`-only clauses (`unsigned`, `criticalVulnerability`) must
            // not apply to the GitHub plugin even when the row carries their fields.
            expect(
                evaluateBuildVerdict(
                    input({
                        build: row({ digestConfirmed: false }),
                        buildKind: 'github-actions',
                        signatureState: 'unsigned',
                        scan: { critical: 9, high: 0, medium: 0, low: 0, fixableCritical: 9 },
                        policy: { blockFixableCritical: true },
                    }),
                ),
            ).toEqual({ deployable: false, notDeployableReason: 'digestUnconfirmed' });
        });
    });

    /* ---------------------------------------------------------------------- *
     * Clause 7 — the apps-builder tail (P3), inert for github-actions
     * ---------------------------------------------------------------------- */

    describe('clause 7 — the managed builder’s signature and scan', () => {
        it('an unsigned apps-builder Build is `unsigned`', () => {
            expect(
                evaluateBuildVerdict(
                    input({ buildKind: 'apps-builder', signatureState: 'unsigned' }),
                ),
            ).toEqual({ deployable: false, notDeployableReason: 'unsigned' });
        });

        it('a fixable critical blocks only when the tier policy says so', () => {
            const scan = { critical: 3, high: 0, medium: 0, low: 0, fixableCritical: 3 };
            expect(
                evaluateBuildVerdict(
                    input({
                        buildKind: 'apps-builder',
                        signatureState: 'signed',
                        scan,
                        policy: { blockFixableCritical: true },
                    }),
                ),
            ).toEqual({ deployable: false, notDeployableReason: 'criticalVulnerability' });
            expect(
                evaluateBuildVerdict(
                    input({
                        buildKind: 'apps-builder',
                        signatureState: 'signed',
                        scan,
                        policy: { blockFixableCritical: false },
                    }),
                ),
            ).toEqual({ deployable: true, notDeployableReason: null });
        });

        it('`unsigned` is evaluated before `criticalVulnerability`', () => {
            expect(
                evaluateBuildVerdict(
                    input({
                        buildKind: 'apps-builder',
                        signatureState: null,
                        scan: { critical: 1, high: 0, medium: 0, low: 0, fixableCritical: 1 },
                        policy: { blockFixableCritical: true },
                    }),
                ),
            ).toEqual({ deployable: false, notDeployableReason: 'unsigned' });
        });

        it('a signed, clean apps-builder Build is deployable', () => {
            expect(
                evaluateBuildVerdict(
                    input({
                        buildKind: 'apps-builder',
                        signatureState: 'signed',
                        scan: { critical: 0, high: 4, medium: 9, low: 20, fixableCritical: 0 },
                        policy: { blockFixableCritical: true },
                    }),
                ),
            ).toEqual({ deployable: true, notDeployableReason: null });
        });
    });

    /* ---------------------------------------------------------------------- *
     * The terms §5.1 shares with secret-sync.ts
     * ---------------------------------------------------------------------- */

    describe('the inputs hash', () => {
        it('is the contracts function, so secret-sync.ts and this verdict cannot drift', () => {
            expect(computeCurrentInputsHash(VALUES)).toBe(computeBuildInputsHash(VALUES));
        });

        it('does not depend on the order the resolver reported its names in', () => {
            const reversed = [...VALUES].reverse();
            expect(computeCurrentInputsHash(reversed)).toBe(computeCurrentInputsHash(VALUES));
        });

        it('maps a fingerprint Record onto pairs', () => {
            expect(fingerprintsToValues({ b: 'v2', a: 'v1' })).toEqual([
                { name: 'b', fingerprint: 'v2' },
                { name: 'a', fingerprint: 'v1' },
            ]);
            expect(computeCurrentInputsHash(fingerprintsToValues({ a: 'v1', b: 'v2' }))).toBe(
                computeBuildInputsHash([
                    { name: 'a', fingerprint: 'v1' },
                    { name: 'b', fingerprint: 'v2' },
                ]),
            );
        });
    });

    it('reads the verdict’s status off the row it was given, so `succeeded` maps to one event', () => {
        expect(appBuildEventNameForStatus(row().status)).toBe('app.build.succeeded');
    });
});
