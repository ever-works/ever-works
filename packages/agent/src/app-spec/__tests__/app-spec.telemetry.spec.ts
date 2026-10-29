import { WorkAppSpecStateRepository } from '../../database/repositories/work-app-spec-state.repository';
import { AppLicenseService } from '../../app-license/app-license.service';
import {
    APP_BLUEPRINT_ACTIVITY_EVENTS,
    AppBlueprintApplyService,
} from '../../apps-catalog/app-blueprint-apply.service';
import { AppBlueprintResolverService } from '../../apps-catalog/app-blueprint-resolver.service';
import { AppBlueprintUpgradeService } from '../../apps-catalog/app-blueprint-upgrade.service';
import { AppSpecService } from '../app-spec.service';
import {
    APP_SPEC_TELEMETRY_EVENTS,
    AppSpecTelemetry,
    appSpecDraftBytes,
} from '../app-spec-telemetry.port';

/**
 * APW-03 T49 / T53 (Gauzy Ever Works #37, 2026-10-29) — plan §9.1's App spec, Blueprint and
 * licence telemetry, and the `app.blueprint.matched` Activity row.
 *
 * Every case asserts three things: the event fires at its moment with its payload, nothing
 * but codes, counters, flags and ids reaches the sink (the inputs below DO carry env names,
 * repository names, SPDX expressions and spec text), and a sink that throws never fails the
 * operation it observes.
 */
describe('App spec telemetry (APW-03 T49) and app.blueprint.matched (T53)', () => {
    type Sent = { distinctId: string; event: string; properties: Record<string, unknown> };

    const WORK_ID = '11111111-1111-4111-8111-111111111111';
    const OWNER = 'owner-1';

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

    /** Everything a leak would look like; none of it may appear in any payload. */
    const FORBIDDEN = [
        'DATABASE_URL',
        'calcom/cal.diy',
        'member/cal',
        'AGPL-3.0-only',
        'Demo app',
        'ever-works/cal-template',
        'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
        'https://',
    ];

    function expectClean(sent: readonly Sent[]): void {
        const text = JSON.stringify(sent.map((entry) => entry.properties));
        for (const value of FORBIDDEN) {
            expect(text).not.toContain(value);
        }
    }

    /** A valid App spec whose env name and upstream repository must never travel. */
    const SPEC_TEXT = [
        'version: 2',
        'kind: app',
        'name: Demo app',
        'spec:',
        '    source: { relation: fork, upstream: { repo: calcom/cal.diy, defaultBranch: main }, branch: main }',
        '    build: { strategy: dockerfile, dockerfile: Dockerfile }',
        '    components: [{ name: web, role: web, port: 3000 }]',
        "    dependencies: { postgres: { version: '16' } }",
        '    env: [{ name: DATABASE_URL, secret: true, from: deps.postgres.url }]',
        '',
    ].join('\n');

    describe('AppSpecTelemetry', () => {
        it('sends the payload with the owner as the distinct id', () => {
            const target = sink();
            new AppSpecTelemetry(target).track(
                APP_SPEC_TELEMETRY_EVENTS.licenseAttested,
                { class: 'amber' },
                OWNER,
            );
            expect(target.sent).toEqual([
                {
                    distinctId: OWNER,
                    event: 'app.license.attested',
                    properties: { class: 'amber' },
                },
            ]);
        });

        it('drops a value that is not a code (the sanitizer backstop)', () => {
            const target = sink();
            const telemetry = new AppSpecTelemetry(target);
            telemetry.track(APP_SPEC_TELEMETRY_EVENTS.blueprintApplyFinished, {
                mode: 'apply',
                path: null,
                outcome: 'failed',
                reason: 'calcom/cal.diy: push rejected' as never,
            });
            expect(target.sent[0].properties).toEqual({
                mode: 'apply',
                path: null,
                outcome: 'failed',
            });
            expect(telemetry.stats().redacted).toBe(1);
        });

        it('counts and drops when unbound, and never throws on a throwing sink', () => {
            const unbound = new AppSpecTelemetry(undefined);
            unbound.track(APP_SPEC_TELEMETRY_EVENTS.licenseAttested, { class: 'red' });
            expect(unbound.stats()).toMatchObject({ emitted: 0, dropped: 1 });

            const throwing = new AppSpecTelemetry(throwingSink);
            expect(() =>
                throwing.track(APP_SPEC_TELEMETRY_EVENTS.licenseAttested, { class: 'red' }),
            ).not.toThrow();
            expect(throwing.stats().failed).toBe(1);
        });

        it('measures a draft in UTF-8 bytes', () => {
            expect(appSpecDraftBytes('abc')).toBe(3);
            expect(appSpecDraftBytes('é')).toBe(2);
            expect(appSpecDraftBytes(undefined)).toBe(0);
        });
    });

    describe('AppSpecService — app.spec.evaluated and app.spec.draft_validated', () => {
        /** A state-row double whose guarded write always wins and settles the request. */
        function statesDouble() {
            const row: Record<string, unknown> = {
                workId: WORK_ID,
                requestedSeq: 1,
                evaluatedSeq: 0,
                trackedBranch: 'main',
                lastEvaluationTrigger: 'push',
                headSpecHash: null,
                validationStatus: null,
                effectiveSpecHash: null,
                effectiveSpec: null,
                effectiveCommitSha: null,
            };
            return {
                row,
                markStarted: jest.fn(async () => 1),
                findByWorkId: jest.fn(async () => ({ ...row })),
                requestEvaluation: jest.fn(async () => 1),
                writeEvaluation: jest.fn(async (_w: string, seq: number) => {
                    row.evaluatedSeq = seq;
                    return true;
                }),
            };
        }

        const work = {
            id: WORK_ID,
            userId: OWNER,
            gitProvider: 'github',
            tenantId: null,
            organizationId: null,
            sourceRepository: { type: 'fork', owner: 'member', repo: 'cal' },
            getRepoOwner: () => 'member',
            getWebsiteRepo: () => 'cal',
        };

        function serviceWith(
            target: { track: (...args: unknown[]) => void },
            states = statesDouble(),
            opts: { work?: unknown; locks?: unknown } = {},
        ) {
            const git = {
                getLatestCommit: jest.fn(async () => ({ sha: 'a'.repeat(40) })),
                getFileContent: jest.fn(async () => ({ content: SPEC_TEXT })),
            };
            const service = new AppSpecService(
                states as never,
                git as never,
                opts.locks as never,
                { findById: jest.fn(async () => ('work' in opts ? opts.work : work)) } as never,
                undefined,
                undefined,
                undefined,
                new AppSpecTelemetry(target),
            );
            return { service, states, git };
        }

        it('emits ONE app.spec.evaluated per evaluate call, with the trigger and the counts', async () => {
            const target = sink();
            const { service } = serviceWith(target);

            const outcome = await service.evaluate(WORK_ID);

            expect(outcome.status).toBe('evaluated');
            expect(outcome.trigger).toBe('push');
            expect(target.sent).toHaveLength(1);
            expect(target.sent[0].event).toBe('app.spec.evaluated');
            expect(target.sent[0].properties).toEqual({
                workId: WORK_ID,
                trigger: 'push',
                status: outcome.validationStatus,
                errorCount: outcome.errorCount,
                warningCount: outcome.warningCount,
                durationMs: expect.any(Number),
                coalesced: false,
                superseded: false,
            });
            expect(String(target.sent[0].properties.status)).toMatch(/^valid/);
            expectClean(target.sent);
        });

        it('reports a run that is not an evaluation by its own status (work_missing, locked)', async () => {
            const target = sink();
            const { service } = serviceWith(target, statesDouble(), { work: null });
            await service.evaluate(WORK_ID);
            expect(target.sent[0].properties).toMatchObject({
                status: 'work_missing',
                trigger: 'push',
                errorCount: 0,
            });

            const lockedTarget = sink();
            const locked = serviceWith(lockedTarget, statesDouble(), {
                locks: { runExclusive: async () => ({ acquired: false }) },
            });
            await locked.service.evaluate(WORK_ID);
            expect(lockedTarget.sent.map((entry) => entry.properties.status)).toEqual(['locked']);
        });

        it('a throwing sink never fails the evaluation', async () => {
            const { service } = serviceWith(throwingSink);
            await expect(service.evaluate(WORK_ID)).resolves.toMatchObject({
                status: 'evaluated',
                written: true,
            });
        });

        it('emits app.spec.draft_validated with the status, the error count and the SIZE only', async () => {
            const target = sink();
            const { service } = serviceWith(target);

            const verdict = await service.validateDraft(WORK_ID, SPEC_TEXT);

            expect(target.sent).toEqual([
                {
                    distinctId: 'app-works',
                    event: 'app.spec.draft_validated',
                    properties: {
                        workId: WORK_ID,
                        status: verdict.status,
                        errorCount: verdict.errorCount,
                        bytes: Buffer.byteLength(SPEC_TEXT, 'utf8'),
                    },
                },
            ]);
            expectClean(target.sent);
        });

        it('parseDraft (the change guard path) emits nothing', async () => {
            const target = sink();
            const { service } = serviceWith(target);
            await service.parseDraft(WORK_ID, SPEC_TEXT);
            expect(target.sent).toEqual([]);
        });
    });

    describe('AppLicenseService — app.license.evaluated and app.license.attested', () => {
        function licenseWith(
            target: { track: (...args: unknown[]) => void },
            state: Record<string, unknown>,
        ) {
            const states = {
                findByWorkId: jest.fn(async () => ({ ...state })),
                nextLicenseSeq: jest.fn(async () => 1),
                writeLicense: jest.fn(async () => true),
                writeAttestation: jest.fn(async () => true),
            };
            const moduleRef = {
                get: (token: unknown) => {
                    if (token === WorkAppSpecStateRepository) return states;
                    throw new Error('unknown');
                },
            };
            const service = new AppLicenseService(
                {
                    findById: jest.fn(async () => ({
                        id: WORK_ID,
                        userId: OWNER,
                        slug: 'cal',
                        owner: 'member',
                        gitProvider: 'github',
                        sourceRepository: { type: 'fork', owner: 'member', repo: 'cal' },
                    })),
                } as never,
                undefined,
                undefined,
                moduleRef as never,
                undefined,
                new AppSpecTelemetry(target),
            );
            return { service, states };
        }

        it('emits the class, the scan flags and the counters — never the SPDX expression', async () => {
            const target = sink();
            const { service } = licenseWith(target, {
                workId: WORK_ID,
                effectiveSpec: { license: { spdx: 'AGPL-3.0-only' } },
                licenseClass: null,
                licenseSpdx: null,
                attestation: null,
            });

            const evaluation = await service.evaluate(WORK_ID, 'initial');

            expect(evaluation?.spdx).toBe('AGPL-3.0-only');
            expect(target.sent).toEqual([
                {
                    distinctId: OWNER,
                    event: 'app.license.evaluated',
                    properties: {
                        class: evaluation?.licenseClass,
                        mixed: false,
                        // No git facade in this graph: the scan could not run.
                        scanIncomplete: true,
                        registrySource: 'snapshot',
                        fileReads: 0,
                        durationMs: expect.any(Number),
                    },
                },
            ]);
            expectClean(target.sent);
        });

        it('emits app.license.attested with the class once the attestation is written', async () => {
            const target = sink();
            const { service, states } = licenseWith(target, {
                workId: WORK_ID,
                licenseClass: 'amber',
                licenseSpdx: 'AGPL-3.0-only',
                licenseCommitSha: 'c'.repeat(40),
                attestation: null,
            });

            await service.attest(WORK_ID, OWNER);

            expect(states.writeAttestation).toHaveBeenCalledTimes(1);
            expect(target.sent).toEqual([
                {
                    distinctId: OWNER,
                    event: 'app.license.attested',
                    properties: { class: 'amber' },
                },
            ]);
            expectClean(target.sent);
        });

        it('a throwing sink never fails the evaluation or the attestation', async () => {
            const evaluating = licenseWith(throwingSink, {
                workId: WORK_ID,
                effectiveSpec: { license: { spdx: 'MIT' } },
                licenseClass: null,
                attestation: null,
            });
            await expect(evaluating.service.evaluate(WORK_ID)).resolves.toMatchObject({
                spdx: 'MIT',
            });

            const attesting = licenseWith(throwingSink, {
                workId: WORK_ID,
                licenseClass: 'red',
                licenseSpdx: 'SSPL-1.0',
                attestation: null,
            });
            await expect(attesting.service.attest(WORK_ID, OWNER)).resolves.toMatchObject({
                class: 'red',
            });
        });
    });

    describe('AppBlueprintResolverService — app.blueprint.resolved', () => {
        const hit = {
            status: 'hit' as const,
            source: 'probe' as const,
            repo: 'ever-works/cal-template',
            id: 'cal',
            version: '0.1.0',
            name: 'Cal',
            prompts: [],
        };

        it('reports a cache answer with zero provider reads, and names no repository', async () => {
            const target = sink();
            const resolver = new AppBlueprintResolverService(
                undefined,
                new AppSpecTelemetry(target),
            );
            (resolver as unknown as { writeCache(key: string, value: unknown): void }).writeCache(
                'calcom/cal.diy',
                hit,
            );

            const result = await resolver.resolve({ owner: 'calcom', repo: 'cal.diy' });

            expect(result).toEqual(hit);
            expect(target.sent.map((entry) => [entry.event, entry.properties])).toEqual([
                [
                    'app.blueprint.resolved',
                    {
                        source: 'cache',
                        outcome: 'hit',
                        refMismatch: false,
                        durationMs: expect.any(Number),
                        providerReads: 0,
                    },
                ],
            ]);
            expectClean(target.sent);
        });

        it('reports a malformed explicit id as blueprintNotFound with no read', async () => {
            const target = sink();
            const resolver = new AppBlueprintResolverService(
                undefined,
                new AppSpecTelemetry(target),
            );

            await resolver.resolve({ owner: 'calcom', repo: 'cal.diy', blueprintId: 'Not An Id' });

            expect(target.sent[0].properties).toMatchObject({
                source: 'explicit',
                outcome: 'blueprintNotFound',
                providerReads: 0,
            });
        });

        it('emits nothing when no credential can read the catalog (a throw, not a resolution)', async () => {
            const target = sink();
            const resolver = new AppBlueprintResolverService(
                undefined,
                new AppSpecTelemetry(target),
            );
            await expect(resolver.resolve({ owner: 'calcom', repo: 'cal.diy' })).rejects.toThrow();
            expect(target.sent).toEqual([]);
        });
    });

    describe('AppBlueprintApplyService — app.blueprint.matched and app.blueprint.apply_finished', () => {
        const BLUEPRINT_YAML = [
            'version: 2',
            'kind: app',
            'name: Cal',
            'spec:',
            '    build: { strategy: dockerfile, dockerfile: Dockerfile }',
            '',
        ].join('\n');

        function build(target: { track: (...args: unknown[]) => void } = sink()) {
            const row: Record<string, unknown> = { workId: WORK_ID };
            const matched = new Set<string>();
            const states = {
                row,
                findByWorkId: jest.fn(async () => ({ ...row })),
                // FR-82's once-only guard: `true` only the first time per id + version.
                markBlueprintMatched: jest.fn(async (_w: string, id: string, version: string) => {
                    const key = `${id}@${version}`;
                    row.blueprintId = id;
                    row.blueprintVersion = version;
                    if (matched.has(key)) return false;
                    matched.add(key);
                    return true;
                }),
                patchBlueprint: jest.fn(async (_w: string, patch: Record<string, unknown>) => {
                    Object.assign(row, patch);
                    return true;
                }),
            };
            const resolver = {
                readBlueprintDocument: jest.fn(async (id: string) => ({
                    hit: {
                        status: 'hit',
                        source: 'explicit',
                        repo: 'ever-works/cal-template',
                        id,
                        version: '0.1.0',
                        name: 'Cal',
                        prompts: [],
                    },
                    text: BLUEPRINT_YAML,
                    defaultBranch: 'main',
                })),
            };
            const activity = { log: jest.fn(async (_entry: unknown) => ({ id: 'a' })) };
            const works = { findById: jest.fn(async () => ({ id: WORK_ID, userId: OWNER })) };
            const apply = new AppBlueprintApplyService(
                resolver as never,
                works as never,
                activity as never,
                {
                    get: (token: unknown) => {
                        if (token === WorkAppSpecStateRepository) return states;
                        throw new Error('unknown');
                    },
                } as never,
                new AppSpecTelemetry(target),
            );
            const compose = () =>
                apply.compose({
                    workId: WORK_ID,
                    blueprintId: 'cal',
                    relation: 'fork',
                    matchSource: 'manifest',
                    userId: OWNER,
                    sourceOwner: 'calcom',
                });
            return { apply, states, activity, compose };
        }

        const actionsOf = (activity: { log: jest.Mock }) =>
            activity.log.mock.calls.map((call) => (call[0] as { action: string }).action);

        it('records app.blueprint.matched exactly once per Work + version, with id, version and source only', async () => {
            const h = build();

            await h.compose();
            await h.compose(); // a re-invoked ready handler / retried request

            const matchedRows = h.activity.log.mock.calls
                .map((call) => call[0] as Record<string, unknown>)
                .filter((entry) => entry.action === APP_BLUEPRINT_ACTIVITY_EVENTS.matched);
            expect(matchedRows).toHaveLength(1);
            expect(matchedRows[0]).toMatchObject({
                userId: OWNER,
                workId: WORK_ID,
                actionType: 'app_blueprint',
                action: 'app.blueprint.matched',
                details: { blueprintId: 'cal', version: '0.1.0', matchSource: 'manifest' },
            });
            expect(Object.keys(matchedRows[0].details as object).sort()).toEqual([
                'blueprintId',
                'matchSource',
                'version',
            ]);
        });

        it('records matched BEFORE applied, and emits apply_finished once per landing', async () => {
            const target = sink();
            const h = build(target);

            await h.compose();
            await h.apply.recordOutcome(
                WORK_ID,
                { kind: 'commit', sha: 'f'.repeat(40), url: 'https://github.com/member/cal' },
                OWNER,
            );
            // A repeated commit report records nothing new.
            await h.apply.recordOutcome(WORK_ID, { kind: 'commit', sha: 'f'.repeat(40) }, OWNER);

            expect(actionsOf(h.activity)).toEqual([
                APP_BLUEPRINT_ACTIVITY_EVENTS.matched,
                APP_BLUEPRINT_ACTIVITY_EVENTS.applied,
            ]);
            expect(target.sent).toEqual([
                {
                    distinctId: OWNER,
                    event: 'app.blueprint.apply_finished',
                    properties: { mode: 'apply', path: 'commit', outcome: 'applied' },
                },
            ]);
            expectClean(target.sent);
        });

        it('reports a setup pull request as proposed and a failure with its code', async () => {
            const target = sink();
            const h = build(target);

            await h.apply.recordOutcome(
                WORK_ID,
                { kind: 'pull_request', number: 11, url: 'https://github.com/member/cal/pull/11' },
                OWNER,
            );
            await h.apply.recordOutcome(
                WORK_ID,
                { kind: 'failed', reason: 'push_rejected' },
                OWNER,
            );

            expect(target.sent.map((entry) => entry.properties)).toEqual([
                { mode: 'apply', path: 'pull_request', outcome: 'proposed' },
                { mode: 'apply', path: null, outcome: 'failed', reason: 'push_rejected' },
            ]);
            expectClean(target.sent);
        });

        it('a failing Activity write or a throwing sink never fails the compose or the landing', async () => {
            const h = build(throwingSink);
            h.activity.log.mockRejectedValue(new Error('db down'));

            await expect(h.compose()).resolves.toMatchObject({ status: 'composed' });
            await expect(
                h.apply.recordOutcome(WORK_ID, { kind: 'commit', sha: 'f'.repeat(40) }, OWNER),
            ).resolves.toBeUndefined();
            expect(h.states.row.blueprintApplyStatus).toBe('applied');
        });
    });

    describe('AppBlueprintUpgradeService — app.blueprint.apply_finished for a run', () => {
        it('reports a failed run with its code, and an invalid payload not at all', async () => {
            const target = sink();
            // No state repository, works or git in this graph: the run fails with a code.
            const upgrade = new AppBlueprintUpgradeService(
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                new AppSpecTelemetry(target),
            );

            const failed = await upgrade.run({
                workId: WORK_ID,
                mode: 'upgrade',
                blueprintId: 'cal',
                version: '0.2.0',
                userId: OWNER,
            } as never);
            await upgrade.run({ workId: 'not-a-uuid', mode: 'upgrade' } as never);

            expect(failed.status).toBe('failed');
            expect(target.sent).toEqual([
                {
                    distinctId: OWNER,
                    event: 'app.blueprint.apply_finished',
                    properties: {
                        mode: 'upgrade',
                        path: null,
                        outcome: 'failed',
                        reason: failed.reason,
                    },
                },
            ]);
        });

        it('reports a merged proposal as applied over a pull request', async () => {
            const target = sink();
            const states = {
                findByWorkId: jest.fn(async () => ({
                    workId: WORK_ID,
                    blueprintId: 'cal',
                    blueprintUpgradeStatus: 'proposed',
                    blueprintUpgradePr: {
                        number: 12,
                        url: 'https://github.com/member/cal/pull/12',
                        version: '0.2.0',
                        mode: 'upgrade',
                        fromVersion: '0.1.0',
                    },
                    effectiveSpec: { blueprint: { id: 'cal', version: '0.2.0' } },
                })),
                patchBlueprintRun: jest.fn(async () => true),
            };
            const upgrade = new AppBlueprintUpgradeService(
                undefined,
                { findById: jest.fn(async () => ({ id: WORK_ID, userId: OWNER })) } as never,
                undefined,
                undefined,
                undefined,
                undefined,
                {
                    get: (token: unknown) => {
                        if (token === WorkAppSpecStateRepository) return states;
                        throw new Error('unknown');
                    },
                } as never,
                new AppSpecTelemetry(target),
            );

            await expect(upgrade.reconcile(WORK_ID)).resolves.toBe(true);

            expect(target.sent).toEqual([
                {
                    distinctId: OWNER,
                    event: 'app.blueprint.apply_finished',
                    properties: { mode: 'upgrade', path: 'pull_request', outcome: 'applied' },
                },
            ]);
            expectClean(target.sent);
        });
    });
});
