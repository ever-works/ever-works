// `WorkLifecycleService` imports the four generator services, which pull in the
// ESM-only slugger and the whole template tree. They are replaced with empty class
// shells exactly as `work-lifecycle.delete.spec.ts` does: the delete cases below hand
// the service plain doubles for all four, so the shells are never constructed.
jest.mock('@src/generators/data-generator/data-generator.service', () => ({
    DataGeneratorService: class DataGeneratorService {},
}));
jest.mock('@src/generators/markdown-generator/markdown-generator.service', () => ({
    MarkdownGeneratorService: class MarkdownGeneratorService {},
}));
jest.mock('@src/generators/website-generator/website-generator.service', () => ({
    WebsiteGeneratorService: class WebsiteGeneratorService {},
}));
jest.mock('@src/generators/website-generator/website-update.service', () => ({
    WebsiteUpdateService: class WebsiteUpdateService {},
}));

import { Logger } from '@nestjs/common';
import type { AppSourceInspectResponse } from '@ever-works/contracts';
import type { User } from '../../entities/user.entity';
import { Work } from '../../entities/work.entity';
import { WorkLifecycleService } from '../../services/work-lifecycle.service';
import { WorksConfigService } from '../../works-config/services/works-config.service';
import { AppSourceInspectorService } from '../app-source-inspector.service';
import { AppWorkCreateService } from '../app-work-create.service';
import { AppSourceInitializerService, serializeDocument } from '../app-source-initializer.service';
import {
    APP_WORKS_TELEMETRY_EVENTS,
    APP_WORKS_TELEMETRY_SINK,
    AppWorksTelemetryService,
    appWorkCreateOutcomeOf,
    type AppWorksTelemetrySink,
} from '../app-works-telemetry.service';

/**
 * APW-01 T36 — FR-53's five events (plan §9.1), emitted through ONE service over an
 * `@Optional()` sink token the API binds to PostHog.
 *
 * The task's Test line, clause by clause:
 *
 *   1. **each event fires once per outcome with a bound sink** — one `describe` per
 *      emitter, driving the REAL service (inspector, create, ready handler, delete) with
 *      fakes at its provider and repository boundaries, and counting what reaches a
 *      recording sink;
 *   2. **unbound ⇒ nothing thrown and nothing logged but a count** — the service with no
 *      sink, with the Nest logger spied on every level;
 *   3. **no payload carries a repository name, URL, owner, token or file content** —
 *      every event any case below emits is collected and scanned against the
 *      identifying strings the fixtures carry, and the scanner is proved on a
 *      known-bad control first so a scan that finds nothing is not vacuous.
 *
 * Every fixture identifier is deliberately distinctive (`octo-owner-7f3`,
 * `secret-widgets-91`, …) so the scan cannot pass by a coincidence of short words.
 */

const OWNER = 'octo-owner-7f3';
const ORG = 'acme-org-55';
const REPO = 'secret-widgets-91';
const UPSTREAM_OWNER = 'upstream-owner-19';
const UPSTREAM_URL = `https://github.com/${UPSTREAM_OWNER}/${REPO}`;
/** A write-only prompted value the member typed — the "token" of FR-53. */
const TOKEN = 'ghp_FAKEtoken0123456789abcdef';
/** Text that only ever lives inside a repository file or description. */
const FILE_MARKER = 'FILE-BODY-MARKER-4471';
const DESCRIPTION_MARKER = 'DESCRIPTION-MARKER-8812';

const USER_ID = 'user-telemetry-1';
const USER = { id: USER_ID, username: 'member-telemetry' } as unknown as User;

/** Everything a payload must never contain (FR-53, plan §9.1's last line). */
const IDENTIFYING = [
    OWNER,
    ORG,
    REPO,
    UPSTREAM_OWNER,
    'github.com',
    'https://',
    TOKEN,
    'ghp_',
    FILE_MARKER,
    DESCRIPTION_MARKER,
];

/** The identifying strings a payload carries, or `[]`. Case-insensitive. */
function leaks(payload: unknown): string[] {
    const text = JSON.stringify(payload ?? null).toLowerCase();
    return IDENTIFYING.filter((needle) => text.includes(needle.toLowerCase()));
}

interface Recorded {
    distinctId: string;
    event: string;
    properties: Record<string, unknown>;
}

/** Every event ANY case in this file sent to a sink, for the payload scan at the end. */
const everything: Recorded[] = [];

/** A sink that records what it was sent — the PostHog client's `track` shape. */
function recordingSink(): {
    sink: AppWorksTelemetrySink & { track: jest.Mock };
    events: Recorded[];
    named: (event: string) => Recorded[];
} {
    const events: Recorded[] = [];
    const sink = {
        track: jest.fn(
            (distinctId: string, event: string, properties?: Record<string, unknown>) => {
                const entry = { distinctId, event, properties: properties ?? {} };
                events.push(entry);
                everything.push(entry);
            },
        ),
        isAvailable: () => true,
    };
    return { sink, events, named: (event) => events.filter((entry) => entry.event === event) };
}

function boundTelemetry() {
    const recording = recordingSink();
    return { ...recording, telemetry: new AppWorksTelemetryService(recording.sink) };
}

/** Spy every Nest logger level, so "nothing logged but a count" is checkable. */
function spyLogger(): { lines: () => string[]; restore: () => void } {
    const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
        jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
    return {
        lines: () => spies.flatMap((spy) => spy.mock.calls.map((call) => String(call[0]))),
        restore: () => spies.forEach((spy) => spy.mockRestore()),
    };
}

const originalFlag = process.env.EVER_WORKS_APP_WORKS_ENABLED;
beforeEach(() => {
    process.env.EVER_WORKS_APP_WORKS_ENABLED = 'true';
});
afterAll(() => {
    if (originalFlag === undefined) {
        delete process.env.EVER_WORKS_APP_WORKS_ENABLED;
    } else {
        process.env.EVER_WORKS_APP_WORKS_ENABLED = originalFlag;
    }
});

/* ========================================================================== *
 * 0. The scanner, proved on a known-bad control first
 * ========================================================================== */

describe('the payload scanner (known-bad control)', () => {
    it('finds a repository URL, an owner, a name, a token and file content', () => {
        expect(
            leaks({
                url: UPSTREAM_URL,
                owner: OWNER,
                repo: REPO,
                token: TOKEN,
                body: FILE_MARKER,
            }),
        ).toEqual(
            expect.arrayContaining([
                OWNER,
                REPO,
                UPSTREAM_OWNER,
                'github.com',
                'https://',
                TOKEN,
                FILE_MARKER,
            ]),
        );
    });

    it('finds nothing in a payload of codes and counters', () => {
        expect(
            leaks({
                mode: 'fork',
                outcome: 'refused',
                reason: 'no_push_access',
                durationMs: 12,
                repositoryDeleted: true,
            }),
        ).toEqual([]);
    });
});

/* ========================================================================== *
 * 1. The service itself
 * ========================================================================== */

describe('AppWorksTelemetryService', () => {
    it('forwards an event to a bound sink with the user id as the distinct id', () => {
        const { telemetry, sink } = boundTelemetry();

        telemetry.track(
            APP_WORKS_TELEMETRY_EVENTS.deleted,
            { mode: 'fork', repositoryDeleted: true },
            USER_ID,
        );

        expect(sink.track).toHaveBeenCalledTimes(1);
        expect(sink.track).toHaveBeenCalledWith(USER_ID, 'app_work.deleted', {
            mode: 'fork',
            repositoryDeleted: true,
        });
        expect(telemetry.stats()).toEqual({ emitted: 1, dropped: 0, failed: 0, redacted: 0 });
    });

    it('names the five plan §9.1 events and nothing else', () => {
        expect(Object.values(APP_WORKS_TELEMETRY_EVENTS).sort()).toEqual([
            'app_source.inspected',
            'app_work.create_finished',
            'app_work.create_started',
            'app_work.deleted',
            'app_work.source_ready',
        ]);
        expect(typeof APP_WORKS_TELEMETRY_SINK).toBe('symbol');
        expect(APP_WORKS_TELEMETRY_SINK.description).toBe('APP_WORKS_TELEMETRY_SINK');
    });

    it('unbound: throws nothing, forwards nothing and logs nothing but a count', () => {
        const logger = spyLogger();
        try {
            const telemetry = new AppWorksTelemetryService(undefined);

            expect(() => {
                for (let index = 0; index < 3; index += 1) {
                    telemetry.track(
                        APP_WORKS_TELEMETRY_EVENTS.createStarted,
                        { mode: 'fork', deployTarget: 'none', adoptedExistingFork: false },
                        USER_ID,
                    );
                }
            }).not.toThrow();

            expect(telemetry.stats()).toEqual({ emitted: 0, dropped: 3, failed: 0, redacted: 0 });

            // Something is said — once, not once per event — and what is said is a count:
            // no event name, no property, no user id.
            const lines = logger.lines();
            expect(lines).toHaveLength(1);
            for (const line of lines) {
                expect(line).toMatch(
                    /^App Works telemetry: no sink is bound; \d+ event\(s\) counted and dropped\.$/,
                );
                expect(line).not.toContain(USER_ID);
                expect(line).not.toContain('fork');
            }
        } finally {
            logger.restore();
        }
    });

    it('treats a sink that reports itself unavailable as unbound', () => {
        const track = jest.fn();
        const telemetry = new AppWorksTelemetryService({ track, isAvailable: () => false });

        telemetry.track(
            APP_WORKS_TELEMETRY_EVENTS.deleted,
            { mode: 'link', repositoryDeleted: false },
            USER_ID,
        );

        expect(track).not.toHaveBeenCalled();
        expect(telemetry.stats()).toEqual({ emitted: 0, dropped: 1, failed: 0, redacted: 0 });
    });

    it('never throws when the sink does — the failure is counted, not rethrown', () => {
        const logger = spyLogger();
        try {
            const telemetry = new AppWorksTelemetryService({
                track: () => {
                    throw new Error(`posthog down for ${OWNER}`);
                },
            });

            expect(() =>
                telemetry.track(
                    APP_WORKS_TELEMETRY_EVENTS.deleted,
                    { mode: 'link', repositoryDeleted: false },
                    USER_ID,
                ),
            ).not.toThrow();
            expect(telemetry.stats()).toEqual({ emitted: 0, dropped: 0, failed: 1, redacted: 0 });
            // The warning names the event and the error class only — never the message,
            // which a sink could fill with anything.
            expect(logger.lines().join('\n')).not.toContain(OWNER);
        } finally {
            logger.restore();
        }
    });

    it('drops a property value that is not a code, a counter or a flag (URL control)', () => {
        const { telemetry, sink } = boundTelemetry();

        // A call site that got it wrong: the type system is bypassed on purpose.
        telemetry.track(
            APP_WORKS_TELEMETRY_EVENTS.createFinished,
            {
                mode: UPSTREAM_URL,
                outcome: 'refused',
                reason: `${OWNER}/${REPO}`,
                durationMs: 5,
            } as never,
            USER_ID,
        );

        const [, , properties] = sink.track.mock.calls[0];
        expect(properties).toEqual({ outcome: 'refused', durationMs: 5 });
        expect(leaks(properties)).toEqual([]);
        expect(telemetry.stats()).toEqual({ emitted: 1, dropped: 0, failed: 0, redacted: 2 });
    });
});

/* ========================================================================== *
 * 2. app_source.inspected — AppSourceInspectorService.inspect
 * ========================================================================== */

function inspectorHarness(input: { repository?: unknown | null } = {}) {
    const bound = boundTelemetry();
    const gitFacade = {
        getRepository: jest.fn().mockResolvedValue(
            input.repository === undefined
                ? {
                      owner: UPSTREAM_OWNER,
                      name: REPO,
                      fullName: `${UPSTREAM_OWNER}/${REPO}`,
                      defaultBranch: 'main',
                      isPrivate: false,
                      url: UPSTREAM_URL,
                      description: DESCRIPTION_MARKER,
                      visibility: 'public',
                      stars: 3,
                      sizeKb: 1_024,
                      allowForking: true,
                      archived: false,
                      empty: false,
                      isFork: false,
                      licenseSpdx: 'MIT',
                      permissions: { admin: false, push: false, pull: true },
                  }
                : input.repository,
        ),
        getLatestCommit: jest.fn().mockResolvedValue({ sha: 'a'.repeat(40) }),
        getUser: jest.fn().mockResolvedValue({ id: '1', login: OWNER }),
        getOrganizations: jest.fn().mockResolvedValue([{ id: '2', login: ORG }]),
        getFileContent: jest.fn().mockResolvedValue(null),
        findExistingFork: jest.fn().mockResolvedValue(null),
    };
    const workRepository = {
        findWorksUsingRepository: jest.fn().mockResolvedValue([]),
        findAppWorksByDataRepository: jest.fn().mockResolvedValue([]),
    };
    const catalog = {
        matchBlueprint: jest.fn().mockResolvedValue(null),
        classifyLicense: jest.fn().mockResolvedValue('green'),
    };
    const service = new AppSourceInspectorService(
        gitFacade as never,
        workRepository as never,
        catalog as never,
        undefined,
        undefined,
        undefined,
        bound.telemetry,
    );
    const providerCalls = () =>
        Object.values(gitFacade).reduce((sum, spy) => sum + spy.mock.calls.length, 0);
    return { ...bound, service, providerCalls };
}

describe('app_source.inspected', () => {
    it('fires once per inspection, with the modes, reasons, Blueprint, licence, time and calls', async () => {
        const { service, named, providerCalls } = inspectorHarness();

        await service.inspect(UPSTREAM_URL, USER, { fresh: true });

        const events = named(APP_WORKS_TELEMETRY_EVENTS.sourceInspected);
        expect(events).toHaveLength(1);
        expect(events[0].distinctId).toBe(USER_ID);
        expect(events[0].properties).toEqual({
            defaultMode: 'fork',
            modesAvailable: ['fork', 'private-copy'],
            reasons: ['no_push_access'],
            blueprint: 'none',
            licenseClass: 'green',
            durationMs: expect.any(Number),
            providerCalls: providerCalls(),
        });
        expect(events[0].properties.providerCalls).toBeGreaterThan(0);
    });

    it('fires once for a provider-side refusal, which is an answer and not an error', async () => {
        const { service, named } = inspectorHarness({ repository: null });

        await service.inspect(UPSTREAM_URL, USER, { fresh: true });

        const events = named(APP_WORKS_TELEMETRY_EVENTS.sourceInspected);
        expect(events).toHaveLength(1);
        expect(events[0].properties).toMatchObject({
            defaultMode: null,
            modesAvailable: [],
            reasons: ['not_found'],
            blueprint: 'unavailable',
            licenseClass: 'unknown',
            providerCalls: 1,
        });
    });

    it('fires for a cached answer too, reporting zero provider calls', async () => {
        const { service, named } = inspectorHarness();

        await service.inspect(UPSTREAM_URL, USER);
        await service.inspect(UPSTREAM_URL, USER);

        const events = named(APP_WORKS_TELEMETRY_EVENTS.sourceInspected);
        expect(events).toHaveLength(2);
        expect(events[0].properties.providerCalls).toBeGreaterThan(0);
        expect(events[1].properties.providerCalls).toBe(0);
    });

    it('fires nothing for OUR validation refusal (an unparseable URL throws before any read)', async () => {
        const { service, events } = inspectorHarness();

        await expect(service.inspect('not a url', USER)).rejects.toBeDefined();

        expect(events).toHaveLength(0);
    });
});

/* ========================================================================== *
 * 3. app_work.create_started / app_work.create_finished — AppWorkCreateService
 * ========================================================================== */

function inspection(overrides: Record<string, unknown> = {}): AppSourceInspectResponse {
    return {
        repository: {
            owner: UPSTREAM_OWNER,
            repo: REPO,
            fullName: `${UPSTREAM_OWNER}/${REPO}`,
            url: UPSTREAM_URL,
            description: DESCRIPTION_MARKER,
            defaultBranch: 'main',
            stars: 5,
            sizeKb: 100,
            visibility: 'public',
            archived: false,
            empty: false,
            isFork: false,
            allowForking: true,
            usesLfs: false,
        },
        access: { canPush: true, canAdmin: false },
        modes: {
            link: { available: true },
            fork: { available: true },
            'private-copy': { available: true },
        },
        defaultMode: 'link',
        targetOwners: [
            { login: OWNER, type: 'user', available: true, existingForkChecked: true },
            { login: ORG, type: 'organization', available: true, existingForkChecked: true },
        ],
        blueprint: { status: 'none' },
        license: { spdx: 'MIT', class: 'green', source: 'detected' },
        deployTargets: {
            none: { available: true },
            'your-cluster': { available: false, reason: 'cluster_target_unavailable' },
            'ever-works-apps': { available: false, reason: 'managed_hosting_unavailable' },
        },
        scanIncomplete: false,
        ...overrides,
    } as unknown as AppSourceInspectResponse;
}

function createDto(overrides: Record<string, unknown> = {}) {
    return {
        slug: REPO,
        name: 'Widgets',
        organization: false,
        gitProvider: 'github',
        repositoryUrl: UPSTREAM_URL,
        kind: 'app',
        repositoryMode: 'fork',
        targetOwner: OWNER,
        appEnv: { API_KEY: TOKEN },
        ...overrides,
    } as never;
}

function createHarness(
    input: {
        inspect?: AppSourceInspectResponse;
        lockAcquired?: boolean;
        slugTaken?: boolean;
        ownAppWorks?: unknown[];
        transactionError?: unknown;
    } = {},
) {
    const bound = boundTelemetry();
    const createdWork = {
        id: 'work-telemetry-1',
        slug: REPO,
        name: 'Widgets',
        owner: OWNER,
        userId: USER_ID,
        kind: 'app',
        createdAt: new Date(),
        sourceRepository: {
            url: `https://github.com/${OWNER}/${REPO}`,
            owner: OWNER,
            repo: REPO,
            type: 'app_fork',
            relatedRepositories: { website: { owner: OWNER, repo: REPO } },
        },
    };
    const inspector = {
        inspect: jest.fn().mockResolvedValue(input.inspect ?? inspection()),
    };
    const locks = {
        runExclusive: jest.fn(async (_key: string, fn: () => Promise<unknown>) =>
            input.lockAcquired === false
                ? { acquired: false }
                : { acquired: true, result: await fn() },
        ),
    };
    const gitFacade = {
        forkRepository: jest.fn().mockResolvedValue({
            owner: OWNER,
            name: REPO,
            fullName: `${OWNER}/${REPO}`,
            defaultBranch: 'main',
            url: `https://github.com/${OWNER}/${REPO}`,
        }),
        findExistingFork: jest.fn().mockResolvedValue(null),
        getRepository: jest.fn().mockResolvedValue(null),
        createRepository: jest.fn(),
    };
    const deployFacade = { getAvailableProvidersForUser: jest.fn().mockResolvedValue([]) };
    const workRepository = {
        existsByUserAndSlug: jest.fn().mockResolvedValue(input.slugTaken === true),
        findByOwnerAndSlug: jest.fn().mockResolvedValue(null),
        findAppWorksByDataRepository: jest.fn().mockResolvedValue(input.ownAppWorks ?? []),
        withTransaction: jest.fn(async (fn: (manager: unknown) => Promise<unknown>) => {
            if (input.transactionError) {
                throw input.transactionError;
            }
            return fn({});
        }),
        create: jest.fn().mockResolvedValue(createdWork),
    };
    const workUpstreamStates = {
        create: jest.fn().mockResolvedValue({ id: 'state-1' }),
        update: jest.fn().mockResolvedValue(true),
        findByWorkId: jest.fn().mockResolvedValue({ readinessState: 'preparing' }),
    };
    const service = new AppWorkCreateService(
        inspector as never,
        locks as never,
        gitFacade as never,
        deployFacade as never,
        workRepository as never,
        workUpstreamStates as never,
        { emitAsync: jest.fn().mockResolvedValue(undefined) } as never,
        { dispatch: jest.fn().mockResolvedValue('run-1') } as never,
        {
            matchBlueprint: jest.fn().mockResolvedValue(null),
            classifyLicense: jest.fn().mockResolvedValue('green'),
        } as never,
        undefined,
        { storePrompted: jest.fn().mockResolvedValue(undefined) } as never,
        undefined,
        bound.telemetry,
    );
    return { ...bound, service, createdWork };
}

describe('app_work.create_started and app_work.create_finished', () => {
    it('created: started once with the mode, target and adoption, finished once as created', async () => {
        const { service, named } = createHarness();

        await service.create(createDto(), USER);

        const started = named(APP_WORKS_TELEMETRY_EVENTS.createStarted);
        const finished = named(APP_WORKS_TELEMETRY_EVENTS.createFinished);
        expect(started).toHaveLength(1);
        expect(started[0].properties).toEqual({
            mode: 'fork',
            deployTarget: 'none',
            adoptedExistingFork: false,
        });
        expect(finished).toHaveLength(1);
        expect(finished[0].properties).toEqual({
            mode: 'fork',
            outcome: 'created',
            durationMs: expect.any(Number),
        });
        expect(finished[0].distinctId).toBe(USER_ID);
    });

    it('reports an existing fork the inspection found in the chosen owner as adopted', async () => {
        const { service, named } = createHarness({
            inspect: inspection({
                targetOwners: [
                    {
                        login: OWNER,
                        type: 'user',
                        available: true,
                        existingForkChecked: true,
                        existingFork: {
                            owner: OWNER,
                            repo: REPO,
                            fullName: `${OWNER}/${REPO}`,
                            url: `https://github.com/${OWNER}/${REPO}`,
                            inUseByAnotherAccount: false,
                        },
                    },
                ],
            }),
        });

        await service.create(createDto(), USER);

        expect(named(APP_WORKS_TELEMETRY_EVENTS.createStarted)[0].properties).toEqual({
            mode: 'fork',
            deployTarget: 'none',
            adoptedExistingFork: true,
        });
        expect(named(APP_WORKS_TELEMETRY_EVENTS.createFinished)[0].properties.outcome).toBe(
            'created',
        );
    });

    it('already_existed: FR-23’s idempotent answer finishes as already_existed', async () => {
        const { service, named, createdWork } = createHarness({
            ownAppWorks: [
                {
                    id: 'work-telemetry-1',
                    slug: REPO,
                    name: 'Widgets',
                    owner: UPSTREAM_OWNER,
                    userId: USER_ID,
                    kind: 'app',
                    createdAt: new Date(),
                    sourceRepository: {
                        type: 'app_link',
                        relatedRepositories: { website: { owner: UPSTREAM_OWNER, repo: REPO } },
                    },
                },
            ],
        });

        const result = await service.create(
            createDto({ repositoryMode: 'link', targetOwner: undefined }),
            USER,
        );

        expect(result.alreadyExisted).toBe(true);
        expect(createdWork).toBeDefined();
        expect(named(APP_WORKS_TELEMETRY_EVENTS.createStarted)).toHaveLength(1);
        const finished = named(APP_WORKS_TELEMETRY_EVENTS.createFinished);
        expect(finished).toHaveLength(1);
        expect(finished[0].properties).toEqual({
            mode: 'link',
            outcome: 'already_existed',
            durationMs: expect.any(Number),
        });
    });

    it('refused before the create acted: finished once with the reason code, never started', async () => {
        const { service, named } = createHarness();
        delete process.env.EVER_WORKS_APP_WORKS_ENABLED;

        await expect(service.create(createDto(), USER)).rejects.toBeDefined();

        expect(named(APP_WORKS_TELEMETRY_EVENTS.createStarted)).toHaveLength(0);
        const finished = named(APP_WORKS_TELEMETRY_EVENTS.createFinished);
        expect(finished).toHaveLength(1);
        expect(finished[0].properties).toEqual({
            mode: 'fork',
            outcome: 'refused',
            reason: 'app_works_disabled',
            durationMs: expect.any(Number),
        });
    });

    it('refused after it started (the create lock is held): started once, finished once', async () => {
        const { service, named } = createHarness({ lockAcquired: false });

        await expect(service.create(createDto(), USER)).rejects.toBeDefined();

        expect(named(APP_WORKS_TELEMETRY_EVENTS.createStarted)).toHaveLength(1);
        const finished = named(APP_WORKS_TELEMETRY_EVENTS.createFinished);
        expect(finished).toHaveLength(1);
        expect(finished[0].properties).toMatchObject({
            outcome: 'refused',
            reason: 'create_in_progress',
        });
    });

    it('a refusal with no reason code (the per-user slug 409) is reported by status', async () => {
        const { service, named } = createHarness({ slugTaken: true });

        await expect(service.create(createDto(), USER)).rejects.toBeDefined();

        expect(named(APP_WORKS_TELEMETRY_EVENTS.createFinished)[0].properties).toMatchObject({
            outcome: 'refused',
            reason: 'http_409',
        });
    });

    it('an unexpected fault (the transaction threw) finishes as failed, never as refused', async () => {
        const { service, named } = createHarness({
            transactionError: new Error(`relation for ${OWNER}/${REPO} does not exist`),
        });

        await expect(service.create(createDto(), USER)).rejects.toBeDefined();

        expect(named(APP_WORKS_TELEMETRY_EVENTS.createStarted)).toHaveLength(1);
        const finished = named(APP_WORKS_TELEMETRY_EVENTS.createFinished);
        expect(finished).toHaveLength(1);
        expect(finished[0].properties).toEqual({
            mode: 'fork',
            outcome: 'failed',
            reason: 'unexpected',
            durationMs: expect.any(Number),
        });
    });

    it('classifies outcomes from the closed reason-code set only', () => {
        expect(appWorkCreateOutcomeOf(new Error('boom'))).toEqual({
            outcome: 'failed',
            reason: 'unexpected',
        });
    });
});

/* ========================================================================== *
 * 4. app_work.source_ready — AppSourceInitializerService
 * ========================================================================== */

const WORK_ID = '00000000-0000-4000-8000-0000000000a5';

function initializerHarness(
    input: {
        relation?: 'fork' | 'link';
        current?: string;
        blueprintId?: string;
        appSpec?: boolean;
        readinessStartedAt?: Date | null;
    } = {},
) {
    const bound = boundTelemetry();
    const relation = input.relation ?? 'fork';
    const head: Record<string, string> = { main: 'sha-head-1' };
    const files: Record<string, string> = {};
    if (input.current !== undefined) {
        files[`sha-head-1::.works/works.yml`] = input.current;
    }
    let seq = 0;
    const git = {
        getLatestCommit: jest.fn(async (_o: string, _r: string, branch: string) =>
            head[branch] ? { sha: head[branch] } : null,
        ),
        getFileContent: jest.fn(
            async (_o: string, _r: string, path: string, _opts: unknown, ref?: string) => {
                const content = files[`${ref}::${path}`];
                return content === undefined ? null : { content, encoding: 'utf-8' };
            },
        ),
        commitFiles: jest.fn(
            async (
                _o: string,
                _r: string,
                commit: { branch: string; files: Array<{ path: string; content: string }> },
            ) => {
                seq += 1;
                const sha = `sha-commit-${seq}`;
                head[commit.branch] = sha;
                for (const file of commit.files) {
                    files[`${sha}::${file.path}`] = file.content;
                }
                return { commitSha: sha };
            },
        ),
        createBranchFromSha: jest.fn(async (_o: string, _r: string, name: string, sha: string) => {
            head[name] = sha;
            return { name, commit: sha, isDefault: false };
        }),
        listPullRequests: jest.fn(async () => []),
        createPullRequest: jest.fn(async (options: { head: string }) => ({
            number: 7,
            state: 'open',
            head: options.head,
            url: `https://github.com/${OWNER}/${REPO}/pull/7`,
        })),
    };
    const work = {
        id: WORK_ID,
        userId: USER_ID,
        slug: REPO,
        owner: OWNER,
        gitProvider: 'github',
        tenantId: null,
        organizationId: null,
        sourceRepository: {
            url: `https://github.com/${OWNER}/${REPO}`,
            owner: OWNER,
            repo: REPO,
            type: relation === 'link' ? 'app_link' : 'app_fork',
            relatedRepositories: { website: { owner: OWNER, repo: REPO } },
            ...(relation === 'link'
                ? {}
                : { upstream: { owner: UPSTREAM_OWNER, repo: REPO, defaultBranch: 'main' } }),
            createdByThisWork: relation !== 'link',
            ...(input.blueprintId ? { blueprintId: input.blueprintId } : {}),
        },
    };
    const readinessStartedAt =
        input.readinessStartedAt === undefined
            ? new Date(Date.now() - 5_000)
            : input.readinessStartedAt;
    const states = {
        findByWorkId: jest.fn(async () => ({ dataDefaultBranch: 'main', readinessStartedAt })),
    };
    const appSpec = {
        initialize: jest.fn(async () => ({ workId: WORK_ID })),
        hasValidAppSpec: jest.fn(async () => true),
    };
    const service = new AppSourceInitializerService(
        { findById: jest.fn(async () => work) } as never,
        states as never,
        git as never,
        (input.appSpec === false ? undefined : appSpec) as never,
        new WorksConfigService({} as never),
        { log: jest.fn(async () => ({ id: 'activity-1' })) } as never,
        { request: jest.fn(async () => ({ status: 'dispatched', runId: 'run-1' })) } as never,
        { request: jest.fn(async () => undefined) } as never,
        { start: jest.fn(async () => ({ started: true })) } as never,
        bound.telemetry,
    );
    return { ...bound, service, run: () => service.onDataRepositoryReady({ workId: WORK_ID }) };
}

describe('app_work.source_ready', () => {
    it('a created fork initialised by one commit: once, no setup pull request, the preparing time', async () => {
        const { run, named } = initializerHarness({ relation: 'fork' });

        await expect(run()).resolves.toEqual({ result: 'initialized' });

        const events = named(APP_WORKS_TELEMETRY_EVENTS.sourceReady);
        expect(events).toHaveLength(1);
        expect(events[0].distinctId).toBe(USER_ID);
        expect(events[0].properties).toEqual({
            mode: 'fork',
            preparingMs: expect.any(Number),
            setupPullRequest: false,
        });
        expect(events[0].properties.preparingMs).toBeGreaterThanOrEqual(5_000);
        expect(events[0].properties.preparingMs).toBeLessThan(60_000);
    });

    it('a link waiting on its setup pull request: once, setupPullRequest true', async () => {
        const { run, named } = initializerHarness({ relation: 'link' });

        await expect(run()).resolves.toMatchObject({ result: 'waiting_for_setup_pr' });

        const events = named(APP_WORKS_TELEMETRY_EVENTS.sourceReady);
        expect(events).toHaveLength(1);
        expect(events[0].properties).toMatchObject({ mode: 'link', setupPullRequest: true });
    });

    it('the source already on the branch (the post-merge re-invocation): once, unchanged', async () => {
        const { run, named } = initializerHarness({
            relation: 'link',
            current: serializeDocument({}, { relation: 'link', branch: 'main' }),
        });

        await expect(run()).resolves.toEqual({ result: 'unchanged' });

        const events = named(APP_WORKS_TELEMETRY_EVENTS.sourceReady);
        expect(events).toHaveLength(1);
        expect(events[0].properties).toMatchObject({ mode: 'link', setupPullRequest: false });
    });

    it('reports preparingMs as null when the state row carries no start time', async () => {
        const { run, named } = initializerHarness({ readinessStartedAt: null });

        await run();

        expect(named(APP_WORKS_TELEMETRY_EVENTS.sourceReady)[0].properties.preparingMs).toBeNull();
    });

    it('fires nothing for a failed hand-off or for the Blueprint path (the source is not ready)', async () => {
        const failed = initializerHarness({ appSpec: false });
        await expect(failed.run()).resolves.toMatchObject({ result: 'failed' });
        expect(failed.events).toHaveLength(0);

        const blueprint = initializerHarness({ blueprintId: 'bp-telemetry' });
        await expect(blueprint.run()).resolves.toEqual({ result: 'blueprint_requested' });
        expect(blueprint.events).toHaveLength(0);
    });
});

/* ========================================================================== *
 * 5. app_work.deleted — WorkLifecycleService.deleteWork (App path)
 * ========================================================================== */

function appWorkRow(mode: 'fork' | 'link'): Work {
    return Object.assign(new Work(), {
        id: 'w-app-telemetry',
        kind: 'app',
        name: REPO,
        slug: REPO,
        owner: OWNER,
        userId: USER_ID,
        gitProvider: 'github',
        deployProvider: null,
        sourceRepository: {
            url: `https://github.com/${OWNER}/${REPO}`,
            owner: OWNER,
            repo: REPO,
            type: mode === 'link' ? 'app_link' : 'app_fork',
            relatedRepositories: { website: { owner: OWNER, repo: REPO } },
            ...(mode === 'link'
                ? {}
                : { upstream: { owner: UPSTREAM_OWNER, repo: REPO, defaultBranch: 'main' } }),
            createdByThisWork: mode === 'fork',
        },
    });
}

function lifecycleHarness(
    work: Work | Record<string, unknown>,
    options: { port?: 'pending'; websiteRemovalFails?: boolean } = {},
) {
    const bound = boundTelemetry();
    const generator = () => ({
        removeRepository: jest.fn().mockResolvedValue(undefined),
        cleanup: jest.fn().mockResolvedValue(undefined),
    });
    const websiteGenerator = generator();
    if (options.websiteRemovalFails) {
        websiteGenerator.removeRepository.mockRejectedValue(new Error('provider down'));
    }
    const port =
        options.port === 'pending'
            ? {
                  requestDeletion: jest.fn(async () => ({
                      status: 'pending',
                      target: 'your-cluster',
                  })),
              }
            : undefined;
    const service = new WorkLifecycleService(
        { delete: jest.fn().mockResolvedValue(true) } as never,
        {} as never,
        generator() as never,
        generator() as never,
        websiteGenerator as never,
        {} as never,
        { ensureIsOwner: jest.fn().mockResolvedValue({ work }) } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        { removeWorkSubdomain: jest.fn().mockResolvedValue(undefined) } as never,
        {} as never,
        { emit: jest.fn(), emitAsync: jest.fn() } as never,
        {} as never,
        {} as never,
        // activityLog, appWorkCreate, the App deletion port — then T36's telemetry, LAST.
        undefined,
        undefined,
        port as never,
        bound.telemetry,
    );
    return { ...bound, service };
}

describe('app_work.deleted', () => {
    it('a created fork deleted with its repository: once, repositoryDeleted true', async () => {
        const { service, named } = lifecycleHarness(appWorkRow('fork'));

        const result = await service.deleteWork(
            'w-app-telemetry',
            { delete_data_repository: true },
            USER,
        );

        expect(result.status).toBe('success');
        const events = named(APP_WORKS_TELEMETRY_EVENTS.deleted);
        expect(events).toHaveLength(1);
        expect(events[0].distinctId).toBe(USER_ID);
        expect(events[0].properties).toEqual({ mode: 'fork', repositoryDeleted: true });
    });

    it('a link (never deletable) and a failed removal both report repositoryDeleted false', async () => {
        const link = lifecycleHarness(appWorkRow('link'));
        await link.service.deleteWork('w-app-telemetry', {}, USER);
        expect(link.named(APP_WORKS_TELEMETRY_EVENTS.deleted).map((e) => e.properties)).toEqual([
            { mode: 'link', repositoryDeleted: false },
        ]);

        const failing = lifecycleHarness(appWorkRow('fork'), { websiteRemovalFails: true });
        await failing.service.deleteWork('w-app-telemetry', { delete_data_repository: true }, USER);
        expect(failing.named(APP_WORKS_TELEMETRY_EVENTS.deleted).map((e) => e.properties)).toEqual([
            { mode: 'fork', repositoryDeleted: false },
        ]);
    });

    it('a deletion the App runtime holds pending fires once as well', async () => {
        const { service, named } = lifecycleHarness(appWorkRow('fork'), { port: 'pending' });

        const result = await service.deleteWork('w-app-telemetry', {}, USER);

        expect(result.status).toBe('pending');
        expect(named(APP_WORKS_TELEMETRY_EVENTS.deleted)).toHaveLength(1);
    });

    it('fires nothing for a refused App delete or for any other kind of Work', async () => {
        const refused = lifecycleHarness(appWorkRow('link'));
        await expect(
            refused.service.deleteWork('w-app-telemetry', { delete_data_repository: true }, USER),
        ).rejects.toBeDefined();
        expect(refused.events).toHaveLength(0);

        const directory = lifecycleHarness({
            id: 'w-dir',
            kind: 'directory',
            name: 'Best Tools',
            slug: 'best-tools',
            owner: ORG,
            userId: USER_ID,
            gitProvider: 'github',
            deployProvider: null,
            getRepoOwner: () => ORG,
            getDataRepo: () => 'best-tools-data',
            getMainRepo: () => 'best-tools',
            getWebsiteRepo: () => 'best-tools-website',
        });
        await directory.service.deleteWork('w-dir', {}, USER);
        expect(directory.events).toHaveLength(0);
    });
});

/* ========================================================================== *
 * 6. FR-53 over everything above
 * ========================================================================== */

describe('no payload carries a repository name, URL, owner, token or file content (FR-53)', () => {
    it('scans every event every case in this file emitted', () => {
        // Vacuity guard: all five events were produced above, so the scan below covers
        // each emitter at least once.
        expect(new Set(everything.map((entry) => entry.event))).toEqual(
            new Set(Object.values(APP_WORKS_TELEMETRY_EVENTS)),
        );

        const offenders = everything
            .map((entry) => ({ event: entry.event, leaked: leaks(entry.properties) }))
            .filter((entry) => entry.leaked.length > 0);
        expect(offenders).toEqual([]);
    });
});
