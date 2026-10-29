import type { AppSpec } from '@ever-works/contracts';

import { AppChangeGuard } from '../app-change-guard';
import { AppChangeRequestService } from '../app-change-request.service';
import {
    APP_CHANGE_TELEMETRY_EVENTS,
    AppChangeTelemetry,
    appChangeGuardRefusedReason,
    appChangeSource,
} from '../app-change.telemetry';
import { AppWorkChangeGateService } from '../app-work-change-gate.service';
import { DEFAULT_SIZE_GUIDANCE } from '../app-work-rules.service';
import { APP_WORK_SWITCH_ENV } from '../app-work-switches';

/**
 * APW-08 (Gauzy Ever Works #37, 2026-10-29) — plan §8.1's evolve-loop telemetry.
 *
 * Each case asserts the event fires at its moment with its payload, that the change request
 * text, the repository and the refused paths never reach the sink, and that a sink which
 * throws never fails the request or changes the gate's verdict.
 */
describe('Evolve-loop telemetry (APW-08)', () => {
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

    const REQUEST = 'Add a dark mode toggle to the header and persist it in DATABASE_URL';
    const FORBIDDEN = [
        'dark mode',
        'DATABASE_URL',
        'me/helpdesk',
        'example-org',
        '.github/workflows',
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

    function requestService(target: { track: (...args: unknown[]) => void }) {
        const tasks = {
            create: jest.fn(async (_userId: string, input: Record<string, unknown>) => ({
                id: 't1',
                slug: 'T-1',
                ...input,
            })),
            runTask: jest.fn(async () => ({
                taskId: 't1',
                agentId: 'a1',
                runId: 'r1',
                dispatched: true,
                parked: false,
            })),
        };
        const service = new AppChangeRequestService(
            tasks as never,
            undefined,
            undefined,
            { resolve: jest.fn(async () => ({ agentId: 'a1', source: 'pinned' as const })) },
            undefined,
            undefined,
            undefined,
            undefined,
            new AppChangeTelemetry(target),
        );
        return { service, tasks };
    }

    describe('the pure mappings', () => {
        it('maps each guard code to plan §8.1 reason, and a provisioning code to none', () => {
            expect(appChangeGuardRefusedReason('protectedPath')).toBe('protected');
            expect(appChangeGuardRefusedReason('workflowPath')).toBe('protected');
            expect(appChangeGuardRefusedReason('diffTooLarge')).toBe('too_many_files');
            expect(appChangeGuardRefusedReason('tooManyLines')).toBe('too_large');
            expect(appChangeGuardRefusedReason('guardedSpecBlock')).toBe('spec_field');
            expect(appChangeGuardRefusedReason('provisioningPathNotWritable')).toBeNull();
            expect(appChangeGuardRefusedReason(null)).toBeNull();
        });

        it('narrows a channel to a closed source code', () => {
            expect(appChangeSource('chat')).toBe('chat');
            expect(appChangeSource('card')).toBe('card');
            expect(appChangeSource('a free-text channel')).toBe('other');
            expect(appChangeSource(undefined)).toBe('other');
        });

        it('counts and drops when unbound, never throws on a throwing sink', () => {
            const unbound = new AppChangeTelemetry(undefined);
            unbound.track(APP_CHANGE_TELEMETRY_EVENTS.merged, { workId: 'w1', taskId: 't1' });
            expect(unbound.stats()).toMatchObject({ emitted: 0, dropped: 1 });
            const throwing = new AppChangeTelemetry(throwingSink);
            expect(() =>
                throwing.track(APP_CHANGE_TELEMETRY_EVENTS.merged, { workId: 'w1', taskId: 't1' }),
            ).not.toThrow();
        });
    });

    describe('AppChangeRequestService', () => {
        const previous = process.env[APP_WORK_SWITCH_ENV.changes];
        afterEach(() => {
            if (previous === undefined) delete process.env[APP_WORK_SWITCH_ENV.changes];
            else process.env[APP_WORK_SWITCH_ENV.changes] = previous;
        });

        it('emits app.change.started when the Task is filed, never the request text', async () => {
            const target = sink();
            const { service } = requestService(target);

            const result = await service.request({
                work: appWork(),
                actorUserId: 'owner',
                request: REQUEST,
                channel: 'chat',
            });

            expect(result).toMatchObject({ status: 'accepted', taskId: 't1' });
            expect(target.sent).toEqual([
                {
                    distinctId: 'owner',
                    event: 'app.change.started',
                    properties: {
                        workId: 'w1',
                        taskId: 't1',
                        source: 'chat',
                        dispatched: true,
                        awaitingOwner: false,
                        agentSource: 'pinned',
                    },
                },
            ]);
            expectClean(target.sent);
        });

        it('emits app.change.blocked_by_switch when the change switch is off, and nothing is filed', async () => {
            process.env[APP_WORK_SWITCH_ENV.changes] = 'false';
            const target = sink();
            const { service, tasks } = requestService(target);

            const result = await service.request({
                work: appWork(),
                actorUserId: 'owner',
                request: REQUEST,
            });

            expect(result).toMatchObject({ status: 'refused', code: 'switchOff' });
            expect(tasks.create).not.toHaveBeenCalled();
            expect(target.sent).toEqual([
                {
                    distinctId: 'owner',
                    event: 'app.change.blocked_by_switch',
                    properties: { workId: 'w1', taskId: null, switch: 'evolve' },
                },
            ]);
        });

        it('emits nothing for any other refusal', async () => {
            const target = sink();
            const { service } = requestService(target);
            await service.request({ work: appWork(), actorUserId: 'owner', request: '' });
            await service.request({
                work: appWork({ kind: 'directory' }),
                actorUserId: 'owner',
                request: REQUEST,
            });
            expect(target.sent).toEqual([]);
        });

        it('a throwing sink never fails the request', async () => {
            const { service } = requestService(throwingSink);
            await expect(
                service.request({ work: appWork(), actorUserId: 'owner', request: REQUEST }),
            ).resolves.toMatchObject({ status: 'accepted' });
        });
    });

    describe('AppWorkChangeGateService — app.change.guard_refused', () => {
        function gateWith(
            target: { track: (...args: unknown[]) => void },
            changed: string,
        ): AppWorkChangeGateService {
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
                        files: [{ path: changed, status: 'modified', additions: 1, deletions: 0 }],
                        truncated: false,
                        totalFiles: 1,
                        totalAdditions: 1,
                        totalDeletions: 0,
                        patchBytes: 0,
                    })),
                    getFileContent: jest.fn(async () => null),
                } as never,
                new AppChangeTelemetry(target),
            );
        }

        const input = {
            work: { id: 'w1', kind: 'app', userId: 'owner' } as never,
            taskOrigin: null,
            taskId: 't1',
            owner: 'me',
            repo: 'helpdesk',
            gitOptions: { userId: 'owner', providerId: 'github', workId: 'w1' },
            baseRef: 'main',
            branch: 'ever-works/task/x',
        };

        it('reports a workflow-path refusal as reason protected, with the code and no path', async () => {
            const target = sink();
            const verdict = await gateWith(target, '.github/workflows/ci.yml').evaluate(input);

            expect(verdict.allowed).toBe(false);
            expect(target.sent).toEqual([
                {
                    distinctId: 'owner',
                    event: 'app.change.guard_refused',
                    properties: {
                        workId: 'w1',
                        taskId: 't1',
                        reason: 'protected',
                        code: 'workflowPath',
                    },
                },
            ]);
            expectClean(target.sent);
        });

        it('emits nothing for an allowed change', async () => {
            const target = sink();
            const verdict = await gateWith(target, 'src/app.ts').evaluate(input);
            expect(verdict.allowed).toBe(true);
            expect(target.sent).toEqual([]);
        });

        it('a throwing sink never changes the verdict', async () => {
            const verdict = await gateWith(throwingSink, '.github/workflows/ci.yml').evaluate(
                input,
            );
            expect(verdict.allowed).toBe(false);
        });
    });
});
