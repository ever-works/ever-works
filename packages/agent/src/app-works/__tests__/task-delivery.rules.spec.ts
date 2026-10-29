import {
    ancestryQuestions,
    containsMerge,
    decideDelivery,
    deploymentFailureOutcome,
    deploymentHasWarnings,
    type DeliveryBuildRow,
    type DeliveryDecisionInput,
    type DeliveryDeploymentRow,
} from '../task-delivery.rules';

/**
 * APW-08 T20 (ACC-08-42, 17, 18, 20, 21) — `decideDelivery` over plan §2.4's delivery input table.
 * One `describe` per table row; no case exists that the table does not name.
 */

const MERGE = '3f9c2ab000000000000000000000000000000001';
const LATER = 'b0b0b0b000000000000000000000000000000002';
const UNRELATED = 'c0ffee0000000000000000000000000000000003';

let clock = Date.parse('2026-10-29T10:00:00Z');
const next = () => new Date((clock += 60_000));

function build(overrides: Partial<DeliveryBuildRow> = {}): DeliveryBuildRow {
    return {
        id: overrides.id ?? `build-${clock}`,
        number: 1,
        status: 'succeeded',
        deployable: true,
        trigger: 'push',
        branch: 'production',
        commitSha: MERGE,
        createdAt: next(),
        ...overrides,
    };
}

function deployment(overrides: Partial<DeliveryDeploymentRow> = {}): DeliveryDeploymentRow {
    return {
        id: overrides.id ?? `dep-${clock}`,
        buildId: null,
        commitSha: MERGE,
        state: 'READY',
        createdAt: next(),
        smokeResult: { inCluster: [{ name: 'home', status: 'passed' }], public: [] },
        appRender: { warnings: [] },
        ...overrides,
    };
}

function input(overrides: Partial<DeliveryDecisionInput> = {}): DeliveryDecisionInput {
    return {
        currentState: 'merged',
        mergeCommitSha: MERGE,
        sourceBranch: 'production',
        builds: [],
        deployments: [],
        ancestry: {},
        target: 'your-cluster',
        autoDeploy: true,
        buildStrategy: 'dockerfile',
        liveWithWarningsCloses: true,
        ...overrides,
    };
}

function state(decision: ReturnType<typeof decideDelivery>) {
    return decision.kind === 'state' ? decision.state : 'unchanged';
}

describe('decideDelivery — plan §2.4 delivery input table (APW-08 T20)', () => {
    describe('No Build and no Deployment started yet → merged', () => {
        it('is merged', () => {
            const decision = decideDelivery(input());
            expect(state(decision)).toBe('merged');
            expect(decision).toMatchObject({ close: false, buildId: null, deploymentId: null });
        });
    });

    describe('Build queued or running → building', () => {
        it.each(['queued', 'running'])('a %s containing Build is building', (status) => {
            const b = build({ status, deployable: false });
            expect(decideDelivery(input({ builds: [b] }))).toMatchObject({
                kind: 'state',
                state: 'building',
                buildId: b.id,
            });
        });
    });

    describe('Build succeeded + deployable, target None → built, Task Done (S21)', () => {
        it.each(['none', null])('target %s closes the Task on a green Build', (target) => {
            expect(decideDelivery(input({ target, builds: [build()] }))).toMatchObject({
                state: 'built',
                close: true,
            });
        });
    });

    describe('Build succeeded + deployable, auto-deploy off → built (S20)', () => {
        it('waits for a person, the Task stays open', () => {
            expect(decideDelivery(input({ autoDeploy: false, builds: [build()] }))).toMatchObject({
                state: 'built',
                close: false,
            });
        });
    });

    describe('Build succeeded + deployable, auto-deploy on, Deployment not started → built', () => {
        it('is built until the next tick sees the Deployment', () => {
            expect(decideDelivery(input({ builds: [build()] }))).toMatchObject({
                state: 'built',
                close: false,
            });
        });
    });

    describe('Build succeeded with deployable: false → build_failed', () => {
        it('a not-deployable Build is a terminal failure', () => {
            expect(decideDelivery(input({ builds: [build({ deployable: false })] }))).toMatchObject({
                state: 'build_failed',
                failurePhase: 'build',
            });
        });
    });

    describe('Build failed → build_failed', () => {
        it('is build_failed', () => {
            expect(
                decideDelivery(input({ builds: [build({ status: 'failed', deployable: false })] })),
            ).toMatchObject({ state: 'build_failed', failurePhase: 'build' });
        });
    });

    describe('Build blocked (incl. strategyNotSupported for build.strategy: auto) → build_failed', () => {
        it('a blocked strategy is a failure to build, not a wait (FR-32)', () => {
            expect(
                decideDelivery(
                    input({
                        buildStrategy: 'auto',
                        builds: [build({ status: 'blocked', deployable: false })],
                    }),
                ),
            ).toMatchObject({ state: 'build_failed' });
        });
    });

    describe('Build cancelled → unchanged', () => {
        it('a person stopped it; a newer containing Build decides (FR-34)', () => {
            expect(
                decideDelivery(
                    input({
                        currentState: 'building',
                        builds: [build({ status: 'cancelled', deployable: false })],
                    }),
                ).kind,
            ).toBe('unchanged');
        });

        it('a newer containing Build than the cancelled one decides', () => {
            const cancelled = build({ status: 'cancelled', deployable: false });
            const newer = build({ status: 'running', deployable: false, commitSha: LATER });
            expect(
                state(
                    decideDelivery(
                        input({ builds: [cancelled, newer], ancestry: { [LATER]: true } }),
                    ),
                ),
            ).toBe('building');
        });
    });

    describe('build.strategy image or none, no Build, Deployment queued/DEPLOYING/VERIFYING → deploying', () => {
        it.each([
            ['image', 'QUEUED'],
            ['image', 'DEPLOYING'],
            ['none', 'VERIFYING'],
        ])('strategy %s with a %s Deployment is deploying — never building/built', (strategy, s) => {
            const d = deployment({ state: s });
            expect(
                decideDelivery(input({ buildStrategy: strategy, deployments: [d] })),
            ).toMatchObject({ state: 'deploying', deploymentId: d.id, buildId: null });
        });
    });

    describe('build.strategy none, no Build, no Deployment → built, Task Done', () => {
        it('closes at merge (FR-32)', () => {
            expect(decideDelivery(input({ buildStrategy: 'none' }))).toMatchObject({
                state: 'built',
                close: true,
            });
        });
    });

    describe('Deployment READY, every in-cluster smoke check passed → live, Task Done', () => {
        it('is live and closes', () => {
            const b = build();
            const d = deployment({ buildId: b.id });
            expect(decideDelivery(input({ builds: [b], deployments: [d] }))).toMatchObject({
                state: 'live',
                close: true,
                liveWithWarnings: false,
                deploymentId: d.id,
                buildId: b.id,
                carried: false,
            });
        });
    });

    describe('Deployment READY with appRender.warnings, or a failed public smoke check → live with warnings', () => {
        it('render warnings are Live ✓ (with warnings), never a failure', () => {
            const d = deployment({ appRender: { warnings: [{ code: 'hpa_missing' }] } });
            expect(decideDelivery(input({ deployments: [d] }))).toMatchObject({
                state: 'live',
                liveWithWarnings: true,
                close: true,
                outcome: null,
            });
        });

        it('a failed PUBLIC smoke check is live with warnings', () => {
            const d = deployment({
                smokeResult: {
                    inCluster: [{ name: 'home', status: 'passed' }],
                    public: [{ name: 'public-home', status: 'failed' }],
                },
            });
            expect(decideDelivery(input({ deployments: [d] }))).toMatchObject({
                state: 'live',
                liveWithWarnings: true,
            });
        });

        it('APW08-G25 CL-08-1 off: the owner alternative treats it as a failed delivery', () => {
            const d = deployment({ appRender: { warnings: [{ code: 'x' }] } });
            expect(
                decideDelivery(input({ liveWithWarningsCloses: false, deployments: [d] })),
            ).toMatchObject({
                state: 'deploy_failed',
                outcome: 'live_with_warnings',
                failurePhase: 'deploy',
                close: false,
            });
        });
    });

    describe('Deployment ERROR → deploy_failed (failed)', () => {
        it('is deploy_failed with the plain failure outcome', () => {
            expect(
                decideDelivery(input({ deployments: [deployment({ state: 'ERROR' })] })),
            ).toMatchObject({ state: 'deploy_failed', outcome: 'failed', failurePhase: 'deploy' });
        });
    });

    describe('Deployment ROLLED_BACK → deploy_failed (rolled back), never a plain failure (S7)', () => {
        it('is rolled_back', () => {
            expect(
                decideDelivery(input({ deployments: [deployment({ state: 'ROLLED_BACK' })] })),
            ).toMatchObject({ state: 'deploy_failed', outcome: 'rolled_back' });
        });
    });

    describe('Deployment whose rollback itself failed → deploy_failed (rollback failed)', () => {
        it('reads APW-06 ERROR + failure code rollback_failed', () => {
            const d = deployment({
                state: 'ERROR',
                appRender: { warnings: [], failure: { code: 'rollback_failed', phase: 'rollback' } },
            });
            expect(decideDelivery(input({ deployments: [d] }))).toMatchObject({
                state: 'deploy_failed',
                outcome: 'rollback_failed',
            });
        });
    });

    describe('Deployment CANCELED → built (FR-34)', () => {
        it('a cancelled Deployment returns the state to built', () => {
            const b = build();
            const d = deployment({ state: 'CANCELED', buildId: b.id });
            expect(
                decideDelivery(input({ currentState: 'deploying', builds: [b], deployments: [d] })),
            ).toMatchObject({ state: 'built', close: false, deploymentId: d.id });
        });
    });

    describe('Deployment SUPERSEDED, or a newer queued Deployment exists → the newer row decides', () => {
        it('a superseded Deployment never decides', () => {
            const b = build();
            const superseded = deployment({ state: 'SUPERSEDED', buildId: b.id });
            const decision = decideDelivery(
                input({ currentState: 'built', builds: [b], deployments: [superseded] }),
            );
            // Only the Build is left to decide; the superseded row changed nothing.
            expect(decision).toMatchObject({ state: 'built', deploymentId: null });
        });

        it('a newer queued Deployment decides over an older failed one', () => {
            const failed = deployment({ state: 'ERROR' });
            const queued = deployment({ state: 'QUEUED', commitSha: LATER });
            expect(
                decideDelivery(input({ deployments: [failed, queued], ancestry: { [LATER]: true } })),
            ).toMatchObject({ state: 'deploying', deploymentId: queued.id, carried: true });
        });
    });

    describe('Provider lacks isAncestorCommit, no exact-sha containing Build → merged (held)', () => {
        it.each([null, undefined])('a later commit with ancestry %s is not proof', (answer) => {
            const later = build({ commitSha: LATER });
            const live = deployment({ commitSha: LATER, buildId: later.id });
            expect(
                state(
                    decideDelivery(
                        input({ builds: [later], deployments: [live], ancestry: { [LATER]: answer } }),
                    ),
                ),
            ).toBe('merged');
        });
    });

    describe('Task already live, closed_without_deploy → unchanged', () => {
        it.each(['live', 'closed_without_deploy'])('%s is terminal', (current) => {
            expect(
                decideDelivery(input({ currentState: current, builds: [build({ status: 'failed' })] })),
            ).toEqual({ kind: 'unchanged', reason: 'terminal' });
        });
    });
});

describe('decideDelivery — carry-along and containment (FR-31, S23, S24, ACC-08-17/18/20/21)', () => {
    it('S23 — a later change containing this one goes live: this one is live, carried', () => {
        const later = build({ commitSha: LATER });
        const live = deployment({ commitSha: LATER, buildId: later.id });
        expect(
            decideDelivery(input({ builds: [later], deployments: [live], ancestry: { [LATER]: true } })),
        ).toMatchObject({ state: 'live', close: true, carried: true });
    });

    it('S24 — a failed change is carried to live by a later Deployment', () => {
        const failed = deployment({ state: 'ROLLED_BACK' });
        const later = deployment({ commitSha: LATER });
        expect(
            decideDelivery(
                input({
                    currentState: 'deploy_failed',
                    deployments: [failed, later],
                    ancestry: { [LATER]: true },
                }),
            ),
        ).toMatchObject({ state: 'live', carried: true });
    });

    it('a newer containing Build in flight moves a failed change back to building', () => {
        const old = build({ status: 'failed', deployable: false });
        const newer = build({ status: 'running', deployable: false, commitSha: LATER });
        expect(
            decideDelivery(
                input({
                    currentState: 'build_failed',
                    builds: [old, newer],
                    ancestry: { [LATER]: true },
                }),
            ),
        ).toMatchObject({ state: 'building', buildId: newer.id });
    });

    it('rows that do not contain the merge are ignored (an older or unrelated commit)', () => {
        const unrelated = build({ status: 'failed', commitSha: UNRELATED });
        const decision = decideDelivery(
            input({ builds: [unrelated], ancestry: { [UNRELATED]: false } }),
        );
        expect(state(decision)).toBe('merged');
    });

    it('only push/manual Builds of the source branch are candidates', () => {
        const pr = build({ trigger: 'pull_request', status: 'failed' });
        const verification = build({ trigger: 'verification', status: 'failed' });
        const otherBranch = build({ branch: 'staging', status: 'failed' });
        expect(
            state(decideDelivery(input({ builds: [pr, verification, otherBranch] }))),
        ).toBe('merged');
        expect(state(decideDelivery(input({ builds: [build({ trigger: 'manual' })] })))).toBe(
            'built',
        );
    });

    it('a Deployment linked to a containing Build contains the change even without a commit', () => {
        const b = build();
        const d = deployment({ commitSha: null, buildId: b.id });
        expect(decideDelivery(input({ builds: [b], deployments: [d] }))).toMatchObject({
            state: 'live',
            deploymentId: d.id,
        });
    });
});

describe('the helpers', () => {
    it('containsMerge: exact sha, or a provider "true" only', () => {
        expect(containsMerge(MERGE, MERGE, {})).toBe(true);
        expect(containsMerge(LATER, MERGE, { [LATER]: true })).toBe(true);
        expect(containsMerge(LATER, MERGE, { [LATER]: false })).toBe(false);
        expect(containsMerge(LATER, MERGE, { [LATER]: null })).toBe(false);
        expect(containsMerge(null, MERGE, {})).toBe(false);
    });

    it('ancestryQuestions asks only about non-exact candidate shas, once each', () => {
        expect(
            ancestryQuestions({
                mergeCommitSha: MERGE,
                sourceBranch: 'production',
                builds: [
                    build({ commitSha: LATER }),
                    build({ commitSha: MERGE }),
                    build({ commitSha: UNRELATED, trigger: 'pull_request' }),
                ],
                deployments: [deployment({ commitSha: LATER }), deployment({ commitSha: null })],
            }),
        ).toEqual([LATER]);
    });

    it('deploymentFailureOutcome tells the three failures apart', () => {
        expect(deploymentFailureOutcome({ state: 'ERROR', appRender: {} })).toBe('failed');
        expect(deploymentFailureOutcome({ state: 'TIMEOUT', appRender: null })).toBe('failed');
        expect(deploymentFailureOutcome({ state: 'ROLLED_BACK', appRender: null })).toBe(
            'rolled_back',
        );
        expect(
            deploymentFailureOutcome({ state: 'ERROR', appRender: { failure: { code: 'rollback_failed' } } }),
        ).toBe('rollback_failed');
        expect(deploymentFailureOutcome({ state: 'READY', appRender: null })).toBeNull();
    });

    it('deploymentHasWarnings reads render warnings and public smoke failures only', () => {
        expect(deploymentHasWarnings(deployment())).toBe(false);
        expect(
            deploymentHasWarnings(
                deployment({ smokeResult: { inCluster: [], public: [{ name: 'p', status: 'skipped' }] } }),
            ),
        ).toBe(false);
    });
});
