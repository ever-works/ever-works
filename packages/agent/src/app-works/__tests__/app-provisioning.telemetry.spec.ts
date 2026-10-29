import type { AppSpec } from '@ever-works/contracts';

import { AppChangeGuard } from '../app-change-guard';
import { AppProvisioningFeedbackService } from '../app-provisioning-feedback.service';
import { AppProvisioningService } from '../app-provisioning.service';
import {
    APP_PROVISION_TELEMETRY_EVENTS,
    AppProvisioningTelemetry,
    provisionAttemptsOf,
} from '../app-provisioning.telemetry';
import { AppWorkChangeGateService } from '../app-work-change-gate.service';
import { DEFAULT_SIZE_GUIDANCE } from '../app-work-rules.service';

/**
 * APW-04 T28 (Gauzy Ever Works #37, 2026-10-29) — plan §10.1's provisioning telemetry.
 *
 * Every case asserts the event fires at its moment with its payload, that nothing the
 * inputs carry beyond codes, counters, flags and ids reaches the sink (they DO carry a
 * repository, a Dockerfile, a branch, a pull request url, a refusal message), and that a
 * sink which throws never fails the start, the cancel, the feedback loop or the gate.
 */
describe('Provisioning telemetry (APW-04 T28)', () => {
    type Sent = { distinctId: string; event: string; properties: Record<string, unknown> };

    function sink(): { sent: Sent[]; track: (...args: unknown[]) => void } {
        const sent: Sent[] = [];
        return {
            sent,
            track: (distinctId: unknown, event: unknown, properties: unknown) =>
                sent.push({
                    distinctId: String(distinctId),
                    event: String(event),
                    properties: properties as Record<string, unknown>,
                }),
        };
    }

    const throwingSink = {
        track: () => {
            throw new Error('analytics down');
        },
    };

    const FORBIDDEN = [
        'example-org',
        'me/helpdesk',
        'Helpdesk',
        'FROM node',
        'works/provision',
        'https://',
        'src/app.ts',
        'feature/login',
    ];

    function expectClean(sent: readonly Sent[]): void {
        const text = JSON.stringify(sent.map((entry) => entry.properties));
        for (const value of FORBIDDEN) {
            expect(text).not.toContain(value);
        }
    }

    function appWork(over: Record<string, unknown> = {}) {
        return {
            id: 'w1',
            userId: 'owner',
            name: 'Helpdesk',
            slug: 'helpdesk',
            kind: 'app',
            tenantId: null,
            organizationId: null,
            gitProvider: 'github',
            sourceRepository: {
                type: 'app_fork',
                owner: 'me',
                repo: 'helpdesk',
                upstream: { owner: 'example-org', repo: 'helpdesk', defaultBranch: 'main' },
                relatedRepositories: { website: { owner: 'me', repo: 'helpdesk' } },
            },
            getRepoOwner: () => 'me',
            getDataRepo: () => 'helpdesk-data',
            getWebsiteRepo: () => 'helpdesk',
            ...over,
        } as never;
    }

    function tasksDouble() {
        return {
            create: jest.fn(async (_userId: string, input: Record<string, unknown>) => ({
                id: 't-new',
                slug: 'T-9',
                ...input,
            })),
            runTask: jest.fn(async () => ({ taskId: 't-new', agentId: 'a1', runId: 'r1' })),
            transition: jest.fn(async () => ({})),
            updateLabels: jest.fn(async () => ({})),
            update: jest.fn(async () => ({})),
        };
    }

    function git() {
        return {
            getRepository: jest.fn(async () => ({ defaultBranch: 'main' })),
            getWorkContents: jest.fn(async () => [
                { name: 'Dockerfile', type: 'file', path: 'Dockerfile' },
            ]),
            getFileContent: jest.fn(async (_o: string, _r: string, path: string) =>
                path === 'Dockerfile'
                    ? { content: 'FROM node:22\nEXPOSE 3000\n', encoding: 'utf-8' }
                    : null,
            ),
        };
    }

    function provisioning(
        target: { track: (...args: unknown[]) => void },
        open: unknown[] = [],
        tasks = tasksDouble(),
    ) {
        const repo = {
            findByUserIdFiltered: jest.fn(async (_u: string, filter: { status?: unknown }) =>
                filter.status ? { rows: open, total: open.length } : { rows: [], total: 0 },
            ),
        };
        const service = new AppProvisioningService(
            { findById: jest.fn(async () => appWork()) } as never,
            git() as never,
            tasks as never,
            repo as never,
            { resolve: jest.fn(async () => ({ agentId: 'a1', source: 'pinned' as const })) },
            { create: jest.fn(async () => undefined) } as never,
            undefined,
            undefined,
            undefined,
            new AppProvisioningTelemetry(target),
        );
        return { service, tasks, repo };
    }

    describe('AppProvisioningTelemetry', () => {
        it('counts and drops when unbound, never throws on a throwing sink', () => {
            const unbound = new AppProvisioningTelemetry(undefined);
            unbound.track(APP_PROVISION_TELEMETRY_EVENTS.suggested, { provisioningId: 't1' });
            expect(unbound.stats()).toMatchObject({ emitted: 0, dropped: 1 });

            const throwing = new AppProvisioningTelemetry(throwingSink);
            expect(() =>
                throwing.track(APP_PROVISION_TELEMETRY_EVENTS.suggested, { provisioningId: 't1' }),
            ).not.toThrow();
            expect(throwing.stats().failed).toBe(1);
        });

        it('reads the iteration count from the labels the feedback loop writes', () => {
            expect(provisionAttemptsOf(['app-provision', 'provision-attempt-2'])).toBe(2);
            expect(provisionAttemptsOf(['provision-attempt-1', 'provision-attempt-3'])).toBe(3);
            expect(provisionAttemptsOf(null)).toBe(0);
        });
    });

    describe('AppProvisioningService', () => {
        it('emits app.provision.started once the Task is filed, with codes and flags only', async () => {
            const target = sink();
            const { service } = provisioning(target);

            const result = await service.start({
                workId: 'w1',
                trigger: 'manual',
                userId: 'owner',
            });

            expect(result).toMatchObject({ started: true, taskId: 't-new' });
            expect(target.sent).toEqual([
                {
                    distinctId: 'owner',
                    event: 'app.provision.started',
                    properties: {
                        provisioningId: 't-new',
                        trigger: 'manual',
                        agentAssigned: true,
                        held: false,
                        draftValid: expect.any(Boolean),
                        detectionSource: 'detection',
                        pullRequestOpened: false,
                        buildStrategy: expect.any(String),
                    },
                },
            ]);
            expectClean(target.sent);
        });

        it('emits nothing for a start that filed nothing (already provisioning)', async () => {
            const target = sink();
            const { service } = provisioning(target, [{ id: 't-open', slug: 'T-1' }]);
            const result = await service.start({
                workId: 'w1',
                trigger: 'manual',
                userId: 'owner',
            });
            expect(result).toMatchObject({ started: false, reason: 'alreadyProvisioning' });
            expect(target.sent).toEqual([]);
        });

        it('emits app.provision.finished (cancelled) with the iteration count on a cancel', async () => {
            const target = sink();
            const { service } = provisioning(target, [
                { id: 't-open', slug: 'T-1', labels: ['app-provision', 'provision-attempt-2'] },
            ]);

            const result = await service.cancel({ workId: 'w1', userId: 'owner' });

            expect(result).toMatchObject({ status: 'cancelled', alreadyCancelled: false });
            expect(target.sent).toEqual([
                {
                    distinctId: 'owner',
                    event: 'app.provision.finished',
                    properties: {
                        provisioningId: 't-open',
                        status: 'cancelled',
                        failureReason: null,
                        attempts: 2,
                    },
                },
            ]);
        });

        it('a throwing sink never fails the start or the cancel', async () => {
            const started = provisioning(throwingSink);
            await expect(
                started.service.start({ workId: 'w1', trigger: 'manual', userId: 'owner' }),
            ).resolves.toMatchObject({ started: true });

            const cancelling = provisioning(throwingSink, [{ id: 't-open', slug: 'T-1' }]);
            await expect(
                cancelling.service.cancel({ workId: 'w1', userId: 'owner' }),
            ).resolves.toMatchObject({ status: 'cancelled' });
        });
    });

    describe('AppProvisioningFeedbackService', () => {
        function feedback(
            target: { track: (...args: unknown[]) => void },
            task: Record<string, unknown>,
        ) {
            const tasks = tasksDouble();
            const service = new AppProvisioningFeedbackService(
                { findById: jest.fn(async () => appWork()) } as never,
                {
                    findByUserIdFiltered: jest.fn(async () => ({ rows: [task], total: 1 })),
                } as never,
                tasks as never,
                { post: jest.fn(async () => ({})) } as never,
                undefined,
                new AppProvisioningTelemetry(target),
            );
            return { service, tasks };
        }

        const openTask = (labels: string[] = ['app-provision']) => ({
            id: 't-open',
            slug: 'T-1',
            status: 'in_progress',
            agentId: 'a1',
            branchRef: 'feature/login',
            labels,
            createdAt: new Date(),
            updatedAt: new Date(),
        });

        it('reports a failed build on the open Task as attempt n with the next decision', async () => {
            const target = sink();
            const { service } = feedback(target, openTask());

            const decision = await service.handle({
                workId: 'w1',
                outcome: 'failed',
                stage: 'build',
                branch: 'feature/login',
                summary: 'Build #3 failed on branch `feature/login` at https://example.test',
            });

            expect(decision).toBe('iterated');
            expect(target.sent).toEqual([
                {
                    distinctId: 'owner',
                    event: 'app.provision.attempt_finished',
                    properties: {
                        provisioningId: 't-open',
                        n: 1,
                        verdict: 'failed',
                        failedStep: 'build',
                        decision: 'iterated',
                    },
                },
            ]);
            expectClean(target.sent);
        });

        it('reports a passed smoke test with no failed step', async () => {
            const target = sink();
            const { service } = feedback(
                target,
                openTask(['app-provision', 'provision-attempt-1']),
            );

            await service.handle({
                workId: 'w1',
                outcome: 'succeeded',
                stage: 'smoke',
                branch: null,
                summary: 'The smoke tests passed.',
            });

            expect(target.sent.map((entry) => entry.properties)).toEqual([
                {
                    provisioningId: 't-open',
                    n: 2,
                    verdict: 'succeeded',
                    failedStep: null,
                    decision: 'posted',
                },
            ]);
        });

        it('reports an exhausted loop as attempt_finished then finished (failed, attempts_exhausted)', async () => {
            const target = sink();
            const { service } = feedback(
                target,
                openTask(['app-provision', 'provision-attempt-3']),
            );

            const decision = await service.handle({
                workId: 'w1',
                outcome: 'failed',
                stage: 'deploy',
                branch: null,
                summary: 'The deployment failed.',
            });

            expect(decision).toBe('exhausted');
            expect(target.sent.map((entry) => [entry.event, entry.properties])).toEqual([
                [
                    'app.provision.attempt_finished',
                    {
                        provisioningId: 't-open',
                        n: 4,
                        verdict: 'failed',
                        failedStep: 'deploy',
                        decision: 'exhausted',
                    },
                ],
                [
                    'app.provision.finished',
                    {
                        provisioningId: 't-open',
                        status: 'failed',
                        failureReason: 'attempts_exhausted',
                        attempts: 3,
                    },
                ],
            ]);
        });

        it('a throwing sink never fails the loop', async () => {
            const { service } = feedback(throwingSink, openTask());
            await expect(
                service.handle({
                    workId: 'w1',
                    outcome: 'failed',
                    stage: 'build',
                    branch: 'feature/login',
                    summary: 'Build failed.',
                }),
            ).resolves.toBe('iterated');
        });
    });

    describe('AppWorkChangeGateService — app.provision.guard_rejected', () => {
        function gateWith(target: { track: (...args: unknown[]) => void }) {
            return new AppWorkChangeGateService(
                {
                    resolve: jest.fn(async () =>
                        Object.freeze({
                            sourceBranch: 'main',
                            checks: [],
                            protectedPaths: [],
                            humanMergePaths: [],
                            instructionFiles: [],
                            sizeGuidance: DEFAULT_SIZE_GUIDANCE,
                        }),
                    ),
                } as never,
                new AppChangeGuard(),
                {
                    getEffectiveSpec: jest.fn(async () => ({
                        status: 'valid',
                        spec: {} as AppSpec,
                    })),
                    parseDraft: jest.fn(async () => ({ status: 'valid', spec: {} as AppSpec })),
                } as never,
                {
                    getLatestCommit: jest.fn(async () => ({ sha: 'a'.repeat(40) })),
                    getCompareDiff: jest.fn(async () => ({
                        files: [
                            { path: 'src/app.ts', status: 'modified', additions: 1, deletions: 0 },
                        ],
                        truncated: false,
                        totalFiles: 1,
                        totalAdditions: 1,
                        totalDeletions: 0,
                        patchBytes: 0,
                    })),
                    getFileContent: jest.fn(async () => null),
                } as never,
                undefined,
                new AppProvisioningTelemetry(target),
            );
        }

        const input = {
            work: { id: 'w1', kind: 'app', userId: 'owner' } as never,
            taskOrigin: 'app-provisioning',
            taskId: 't-open',
            owner: 'me',
            repo: 'helpdesk',
            gitOptions: { userId: 'owner', providerId: 'github', workId: 'w1' },
            baseRef: 'main',
            branch: 'works/provision',
        };

        it('reports the output guard refusal code for a provisioning Task, never the paths', async () => {
            const target = sink();
            const verdict = await gateWith(target).evaluate(input);

            expect(verdict.allowed).toBe(false);
            expect(target.sent).toEqual([
                {
                    distinctId: 'owner',
                    event: 'app.provision.guard_rejected',
                    properties: {
                        provisioningId: 't-open',
                        codes: ['provisioningPathNotWritable'],
                    },
                },
            ]);
            expectClean(target.sent);
        });

        it('a throwing sink never changes the verdict', async () => {
            const verdict = await gateWith(throwingSink).evaluate(input);
            expect(verdict.allowed).toBe(false);
        });

        it('the merge re-judgement (reportRefusal: false) refuses the same and reports nothing', async () => {
            const target = sink();
            const verdict = await gateWith(target).evaluate({ ...input, reportRefusal: false });
            expect(verdict.allowed).toBe(false);
            expect(target.sent).toEqual([]);
        });
    });
});
