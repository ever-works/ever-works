// The auth barrel pulls `better-auth`, an ESM package jest cannot parse, which is
// why every controller spec in this app stubs it. Unlike the others, `CurrentUser`
// is **rebuilt** here rather than stubbed to `() => undefined`: this suite drives
// the routes through a real router, so the parameter decorator has to read
// `request.user` the way `AuthSessionGuard` seeds it in production.
jest.mock('../auth', () => {
    const { createParamDecorator } = jest.requireActual('@nestjs/common');
    class AuthService {}
    class AuthSessionGuard {}
    return {
        AuthService,
        AuthSessionGuard,
        CurrentUser: createParamDecorator(
            (
                _data: unknown,
                ctx: { switchToHttp: () => { getRequest: () => { user?: unknown } } },
            ) => ctx.switchToHttp().getRequest().user,
        ),
    };
});

// 🛑 `@ever-works/agent/services` is a 200-module barrel: loading it pulls
// `work-query.service` → the data generator → `p-map`, an ESM-only package jest
// cannot parse, and the suite dies before its first test ("Unexpected token
// 'export'"). This spec needs ONE class from it — the real
// `WorkOwnershipService`, because ACC-03-41 is about who may read and who may
// re-check — so it is loaded from its own module and the barrel stays out of the
// graph. (`@ever-works/agent/facades` is a DI token here, never a behaviour: the
// route only ever hands the facade to `fileLinks`, and the facade itself is a
// double in this suite.)
jest.mock('@ever-works/agent/services', () => ({
    WorkOwnershipService: jest.requireActual(
        '../../../../packages/agent/src/services/work-ownership.service',
    ).WorkOwnershipService,
}));
jest.mock('@ever-works/agent/facades', () => ({
    GitFacadeService: class GitFacadeService {},
}));

import 'reflect-metadata';
import {
    GUARDS_METADATA,
    HTTP_CODE_METADATA,
    METHOD_METADATA,
    PATH_METADATA,
} from '@nestjs/common/constants';
import {
    type INestApplication,
    RequestMethod,
    UnauthorizedException,
    ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { THROTTLER_LIMIT, THROTTLER_TTL } from '@nestjs/throttler/dist/throttler.constants';
import { json } from 'express';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
    APP_SPEC_EVALUATE_COALESCE_MS,
    APP_SPEC_FILE_MAX_BYTES,
    APP_SPEC_LAZY_HEAD_CHECK_MS,
    APP_SOURCE_SPEC_FILE,
} from '@ever-works/contracts';
import { AppSpecService } from '@ever-works/agent/app-spec';
import {
    CacheEntry,
    Work,
    WorkAppSpecState,
    WorkMember,
    WorkMemberRole,
} from '@ever-works/agent/entities';
import {
    ENTITIES,
    WorkAppSpecStateRepository,
    WorkMemberRepository,
    WorkRepository,
} from '@ever-works/agent/database';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { WorkOwnershipService } from '@ever-works/agent/services';
import { GitFacadeService } from '@ever-works/agent/facades';
import { AuthSessionGuard } from '../auth';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import {
    APP_SPEC_BRANCH_VALIDATIONS_PER_MINUTE,
    APP_SPEC_CONTENT_VALIDATIONS_PER_MINUTE,
    APP_SPEC_VALIDATE_WINDOW_MS,
    AppSpecValidateThrottle,
    WorkAppSpecController,
} from './work-app-spec.controller';

/**
 * APW-03 T15 — `GET /api/works/:id/app-spec` and
 * `POST /api/works/:id/app-spec/validate` (plan §4.1, `plan.md:547-548`).
 *
 * ACC-03-08 (a `content` validation stores nothing, and the 31st request in a
 * minute is refused), ACC-03-13 (three Re-check presses in five seconds run one
 * evaluation; the 7th in a minute is refused), ACC-03-14 (a stale head schedules
 * at most one evaluation per minute), ACC-03-41 (viewer vs editor, and another
 * account's Work answers not found).
 *
 * ## Real HTTP, a real database, and the real service
 *
 * Every claim above is a property the task owns end to end, so nothing between
 * the route and the row is stubbed:
 *
 *   - the **routes** are driven through a real Nest HTTP stack with the
 *     platform's own `ValidationPipe` (`main.ts:199-205`), because the status
 *     codes, the pipe's refusals and the throttles only exist there;
 *   - the database is a real in-memory better-sqlite3 `DataSource` built from the
 *     platform's own `ENTITIES`, with the **real** `WorkAppSpecStateRepository`
 *     (T11) and the **real** `AppSpecService` (T12) behind the route. The
 *     coalescing arithmetic of ACC-03-13 and the 60-second lazy-check window of
 *     ACC-03-14 are database and service behaviour, and a hand-written double of
 *     either would assert the double rather than the platform;
 *   - `WorkOwnershipService`, `WorkRepository` and `WorkMemberRepository` are the
 *     production classes over real rows, so ACC-03-41's viewer, editor, creator
 *     and stranger are the real access decisions, not a mocked boolean;
 *   - the **validator** is the real one: a `content` validation of a document
 *     with a missing `source` answers that document's own error codes.
 *
 * The three collaborators this task does not own are doubles: the git facade
 * (a branch → sha → file-text model, the shape T12's own spec uses), the job
 * runtime (`APP_SPEC_EVALUATE_DISPATCHER`, which is what makes the enqueue
 * observable and the evaluation asynchronous exactly as production's is), and
 * the Activity log (which is how "stores nothing" is asserted).
 *
 * ## What is deliberately NOT imported
 *
 * The real `WorksController` is not imported for a route-shadowing assertion:
 * it drags the whole agent DI graph past what a controller spec may load, and
 * the question it would answer — "is `api/works/:id/app-spec` reachable?" — is
 * answered more strongly by the boot probe (`node dist/main.js`, an
 * unauthenticated request answering `401` rather than `404`) than by a static
 * table read.
 */

/* -------------------------------------------------------------------------- *
 * Identities, Work ids and fixtures
 * -------------------------------------------------------------------------- */

/** The App Work's creator — always `owner`. */
const OWNER_ID = '11111111-1111-4111-8111-111111111111';

/** A member with the `viewer` role: read yes, Re-check no. */
const VIEWER_ID = '22222222-2222-4222-8222-222222222222';

/** A member with the `editor` role: Re-check yes. */
const EDITOR_ID = '33333333-3333-4333-8333-333333333333';

/** Somebody else entirely. */
const STRANGER_ID = '44444444-4444-4444-8444-444444444444';

/** The App Work under test. */
const WORK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** A visible Work of another kind, for `422 notAnAppWork`. */
const WEBSITE_WORK = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** A Work id that exists nowhere. */
const MISSING_WORK = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

const URL = '/api/works/:id/app-spec';
const VALIDATE_URL = '/api/works/:id/app-spec/validate';

/**
 * The platform's own body-parser ceiling — `main.ts:117-118`, the 1 MB default
 * (`BODY_LIMIT` may raise it, up to a 10 MB hard cap).
 *
 * It matters to this suite: without it Express would apply its own 100 KB
 * default, and a 256 KiB `content` would be refused by the PARSER with
 * `413 { statusCode: 413, message: "request entity too large" }` — the parser's
 * body, never §4.2's — instead of reaching the route's own check. The suite
 * installs the platform's limit so the `file_too_large` assertion measures the
 * route rather than the middleware in front of it, and asserts below that the
 * two do not collide.
 */
const BODY_LIMIT = '1mb';
const BODY_LIMIT_BYTES = 1024 * 1024;

/** A whole `.works/works.yml` whose spec block validates with zero errors. */
const VALID_SPEC_YAML = [
    'version: 2',
    'kind: app',
    'name: Demo app',
    'spec:',
    '    source: { relation: fork, upstream: { repo: calcom/cal.diy, defaultBranch: main }, branch: main }',
    '    build: { strategy: dockerfile, dockerfile: Dockerfile }',
    '    components: [ { name: web, role: web, port: 3000 } ]',
    '',
].join('\n');

/** A document the validator reports errors for — no `source`, no `components`. */
const INVALID_SPEC_YAML = [
    'version: 2',
    'kind: app',
    'spec:',
    '    build: { strategy: dockerfile, dockerfile: Dockerfile }',
    '',
].join('\n');

/** The two repository coordinates the Work's `sourceRepository` records. */
const REPO_OWNER = 'octo';
const REPO_NAME = 'widgets';

/* -------------------------------------------------------------------------- *
 * The session stand-in (models `AuthSessionGuard`)
 * -------------------------------------------------------------------------- */

/**
 * The signed-in person of the current request, or `null` for "no session".
 *
 * Mutable per test because ACC-03-41 is entirely about *who* is asking; a guard
 * that hard-coded one user could not express it.
 */
let sessionUserId: string | null = OWNER_ID;

const sessionGuard = {
    canActivate(context: {
        switchToHttp: () => { getRequest: () => { user?: unknown } };
    }): boolean {
        if (!sessionUserId) {
            throw new UnauthorizedException();
        }
        context.switchToHttp().getRequest().user = { userId: sessionUserId };
        return true;
    },
};

/* -------------------------------------------------------------------------- *
 * The git facade double — a branch → sha → file-text model
 * -------------------------------------------------------------------------- */

interface GitDouble {
    getLatestCommit: jest.Mock;
    getFileContent: jest.Mock;
    getWebUrl?: jest.Mock;
    getFileWebUrl?: jest.Mock;
}

/** The three methods the real facade answers with today. */
function fakeGit(
    input: { heads?: Record<string, string>; files?: Record<string, string | null> } = {},
): GitDouble {
    const heads = input.heads ?? { main: SHA_A };
    const files = input.files ?? { [SHA_A]: VALID_SPEC_YAML };

    return {
        getLatestCommit: jest.fn(async (_owner: string, _repo: string, branch: string) =>
            heads[branch] ? { sha: heads[branch], message: 'x', author: 'x' } : null,
        ),
        getFileContent: jest.fn(
            async (
                _owner: string,
                _repo: string,
                _path: string,
                _options: unknown,
                ref?: string,
            ) => {
                const text = files[ref as string];
                return text === undefined || text === null
                    ? null
                    : { content: text, encoding: 'utf-8' };
            },
        ),
        getWebUrl: jest.fn(
            (_providerId: string, owner: string, repo: string) =>
                `https://github.com/${owner}/${repo}`,
        ),
    };
}

/* -------------------------------------------------------------------------- *
 * The harness
 * -------------------------------------------------------------------------- */

interface Harness {
    dataSource: DataSource;
    appSpec: AppSpecService;
    dispatchAppSpecEvaluate: jest.Mock;
    activityLog: jest.Mock;
    emitted: unknown[];
    git: GitDouble;
    /**
     * Build a second Nest application over the SAME database and session, with a
     * different git facade — how the two `links.file` cases are asserted without
     * a mutable global.
     */
    appWith: (git: GitDouble) => Promise<INestApplication>;
}

describe('WorkAppSpecController — the two App-spec routes (APW-03 T15)', () => {
    let dataSource: DataSource;
    let states: WorkAppSpecStateRepository;
    let app: INestApplication;
    let h: Harness;

    /** The stored state row, re-read from the database, never from a returned object. */
    async function storedState(workId = WORK): Promise<WorkAppSpecState | null> {
        return dataSource.getRepository(WorkAppSpecState).findOne({ where: { workId } });
    }

    /** A snapshot of the row as the database holds it — what "stores nothing" compares. */
    async function rowFingerprint(workId = WORK): Promise<string> {
        const row = await storedState(workId);
        return JSON.stringify(row ?? null);
    }

    /** The owning Work row, plus its second repository the schema requires. */
    async function seedWork(input: {
        id: string;
        userId: string;
        kind: string;
        slug: string;
        withRepositories?: boolean;
    }): Promise<void> {
        const sourceRepository = input.withRepositories
            ? `'{"relatedRepositories":{"website":{"owner":"${REPO_OWNER}","repo":"${REPO_NAME}"}}}'`
            : 'NULL';
        await dataSource.query(
            `INSERT INTO "works" ("id", "name", "slug", "userId", "description", "kind", "owner", "gitProvider", "sourceRepository") ` +
                `VALUES ('${input.id}', 'Work ${input.id.slice(0, 4)}', '${input.slug}', '${input.userId}', '', '${input.kind}', '${REPO_OWNER}', 'github', ${sourceRepository})`,
        );
    }

    async function seedMember(workId: string, userId: string, role: WorkMemberRole): Promise<void> {
        await dataSource.getRepository(WorkMember).save({ workId, userId, role });
    }

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        // The fixture writes rows for people who exist in the real product but not
        // in this database; FK enforcement would refuse them, and it is not what
        // this spec is about (T11's and T12's harnesses do the same).
        await dataSource.query('PRAGMA foreign_keys = OFF');

        states = new WorkAppSpecStateRepository(dataSource.getRepository(WorkAppSpecState));
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        sessionUserId = OWNER_ID;

        await dataSource.getRepository(WorkAppSpecState).clear();
        await dataSource.getRepository(WorkMember).clear();
        await dataSource.query('DELETE FROM "works"');
        await dataSource.query('DELETE FROM "cache_entries"');

        await seedWork({
            id: WORK,
            userId: OWNER_ID,
            kind: 'app',
            slug: 'demo-app',
            withRepositories: true,
        });
        await seedWork({ id: WEBSITE_WORK, userId: OWNER_ID, kind: 'website', slug: 'demo-site' });

        // APW-01 initializes one state row per App Work; nothing here fabricates
        // one, so "no state row" stays a reachable state for the 404 case.
        await states.initialize(WORK, 'main', { organizationId: null });

        h = await buildHarness(fakeGit());
        app = await h.appWith(h.git);
    });

    afterEach(async () => {
        await app?.close();
    });

    /**
     * The whole graph: the real service over the real repositories, with the
     * three doubles this task does not own.
     */
    async function buildHarness(git: GitDouble): Promise<Harness> {
        const dispatchAppSpecEvaluate = jest.fn(async () => 'run-1');
        const activityLog = jest.fn(async (entry: Record<string, unknown>) => ({
            id: 'row',
            ...entry,
        }));
        const emitted: unknown[] = [];
        const events = new EventEmitter2();
        events.on('app.spec.applied', (event: unknown) => emitted.push(event));

        const appSpec = new AppSpecService(
            states,
            git as unknown as GitFacadeService,
            new DistributedTaskLockService(dataSource.getRepository(CacheEntry)),
            new WorkRepository(dataSource.getRepository(Work)),
            { log: activityLog } as never,
            events,
            { dispatchAppSpecEvaluate } as never,
        );

        const ownership = new WorkOwnershipService(
            new WorkRepository(dataSource.getRepository(Work)),
            new WorkMemberRepository(dataSource.getRepository(WorkMember)),
        );

        const harness: Harness = {
            dataSource,
            appSpec,
            dispatchAppSpecEvaluate,
            activityLog,
            emitted,
            git,
            appWith: async (facade: GitDouble) => {
                const moduleRef = await Test.createTestingModule({
                    controllers: [WorkAppSpecController],
                    providers: [
                        { provide: WorkOwnershipService, useValue: ownership },
                        { provide: AppSpecService, useValue: appSpec },
                        { provide: GitFacadeService, useValue: facade },
                    ],
                })
                    .overrideGuard(AuthSessionGuard)
                    .useValue(sessionGuard)
                    .compile();

                const application = moduleRef.createNestApplication();
                // `main.ts:144` — the same parser limit the platform installs,
                // before the pipe, so `413 file_too_large` is the route's answer.
                application.use(json({ limit: BODY_LIMIT }));
                // The platform's own pipe (`apps/api/src/main.ts:199-205`).
                application.useGlobalPipes(
                    new ValidationPipe({
                        whitelist: true,
                        transform: true,
                        forbidNonWhitelisted: true,
                    }),
                );
                await application.init();
                return application;
            },
        };

        return harness;
    }

    const get = (workId = WORK, as: string | null = OWNER_ID) => {
        sessionUserId = as;
        return request(app.getHttpServer()).get(URL.replace(':id', workId));
    };

    const validate = (body: unknown, workId = WORK, as: string | null = OWNER_ID) => {
        sessionUserId = as;
        return request(app.getHttpServer())
            .post(VALIDATE_URL.replace(':id', workId))
            .send(body as object);
    };

    // -----------------------------------------------------------------------
    // The routes themselves — plan §4.1, §4.2's error codes in OpenAPI
    // -----------------------------------------------------------------------

    describe('the routes', () => {
        it('declares GET api/works/:id/app-spec and POST api/works/:id/app-spec/validate', () => {
            expect(Reflect.getMetadata(PATH_METADATA, WorkAppSpecController)).toBe('api/works');

            const read = WorkAppSpecController.prototype.getAppSpec;
            expect(Reflect.getMetadata(PATH_METADATA, read)).toBe(':id/app-spec');
            expect(Reflect.getMetadata(METHOD_METADATA, read)).toBe(RequestMethod.GET);
            // A read answers 200 without an explicit @HttpCode.
            expect(Reflect.getMetadata(HTTP_CODE_METADATA, read)).toBeUndefined();

            const check = WorkAppSpecController.prototype.validateAppSpec;
            expect(Reflect.getMetadata(PATH_METADATA, check)).toBe(':id/app-spec/validate');
            expect(Reflect.getMetadata(METHOD_METADATA, check)).toBe(RequestMethod.POST);
            // Two statuses (202 for `branch`, 200 for `content`), so no
            // `@HttpCode`: the handler sets the status it answers with.
            expect(Reflect.getMetadata(HTTP_CODE_METADATA, check)).toBeUndefined();
        });

        it('is JWT-guarded on both routes and is not @Public()', () => {
            expect(Reflect.getMetadata(GUARDS_METADATA, WorkAppSpecController)).toContain(
                AuthSessionGuard,
            );
            expect(Reflect.getMetadata(IS_PUBLIC_KEY, WorkAppSpecController)).toBeUndefined();
        });

        it('documents both operations, their 200/202 bodies and §4.2’s error codes', () => {
            const read = WorkAppSpecController.prototype.getAppSpec as unknown as object;
            const check = WorkAppSpecController.prototype.validateAppSpec as unknown as object;

            const readOperation = Reflect.getMetadata('swagger/apiOperation', read) as {
                summary?: string;
                description?: string;
            };
            const checkOperation = Reflect.getMetadata('swagger/apiOperation', check) as {
                summary?: string;
                description?: string;
            };

            expect(readOperation?.summary).toBeTruthy();
            expect(readOperation?.description).toContain('404 not_found');
            expect(checkOperation?.summary).toBeTruthy();
            expect(checkOperation?.description).toContain('file_too_large');

            // The complete response tables of the two routes, as the document
            // carries them.
            expect(
                Object.keys(
                    Reflect.getMetadata('swagger/apiResponse', read) as Record<string, unknown>,
                ).sort(),
            ).toEqual(['200', '401', '404', '422']);
            expect(
                Object.keys(
                    Reflect.getMetadata('swagger/apiResponse', check) as Record<string, unknown>,
                ).sort(),
            ).toEqual(['200', '202', '401', '404', '413', '422', '429']);
        });

        it('carries the 30-per-minute per-member backstop the plan’s content limit shares', () => {
            const check = WorkAppSpecController.prototype.validateAppSpec as unknown as object;

            expect(Reflect.getMetadata(`${THROTTLER_LIMIT}long`, check)).toBe(
                APP_SPEC_CONTENT_VALIDATIONS_PER_MINUTE,
            );
            expect(Reflect.getMetadata(`${THROTTLER_TTL}long`, check)).toBe(
                APP_SPEC_VALIDATE_WINDOW_MS,
            );
            expect(APP_SPEC_CONTENT_VALIDATIONS_PER_MINUTE).toBe(30);
        });

        it('answers 401 without a session', async () => {
            const response = await get(WORK, null);

            expect(response.status).toBe(401);
        });
    });

    // -----------------------------------------------------------------------
    // GET — the state, its link, and the lazy head check
    // -----------------------------------------------------------------------

    describe('GET app-spec (plan §4.1:547)', () => {
        it('answers 200 with the whole state and none of the internal sequence columns', async () => {
            const response = await get();

            expect(response.status).toBe(200);
            expect(response.body).toMatchObject({
                workId: WORK,
                trackedBranch: 'main',
                validationStatus: 'missing',
                headCommitSha: null,
                headSpecHash: null,
                effectiveCommitSha: null,
                effectiveSpec: null,
                issues: null,
                errorCount: 0,
                warningCount: 0,
                licenseMixed: false,
                // The read ran FR-19(d)'s head check, the head moved and one
                // evaluation was requested — which is exactly what the page
                // polls on.
                evaluationPending: true,
                links: {
                    file: {
                        base: `https://github.com/${REPO_OWNER}/${REPO_NAME}`,
                        // The lazy check this read ran is what read the head, so
                        // the link points at it before the evaluation lands.
                        commitSha: SHA_A,
                        path: APP_SOURCE_SPEC_FILE,
                    },
                    lineAnchor: null,
                },
            });
            expect(response.body.id).toBeTruthy();
            expect(response.body.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
            expect(response.body.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

            // `work-app-spec.dto.ts:18-25` — the five sequence columns mean
            // nothing outside the repository that owns them.
            for (const column of [
                'requestedSeq',
                'startedSeq',
                'evaluatedSeq',
                'licenseRequestedSeq',
                'licenseEvaluatedSeq',
            ]) {
                expect([column, response.body[column]]).toEqual([column, undefined]);
            }
        });

        it('links to the file through the provider when the facade answers for one (plan §4.3:578)', async () => {
            const git = fakeGit();
            // T22's `getFileWebUrl` (plan §7:720) — the seam the controller
            // prefers the moment the bound facade has it.
            const withFile = {
                ...git,
                getFileWebUrl: jest.fn(
                    async (owner: string, repo: string, ref: string, path: string) => ({
                        url: `https://github.com/${owner}/${repo}/blob/${ref}/${path}`,
                        lineAnchor: '#L{line}',
                    }),
                ),
            };
            const second = await h.appWith(withFile);

            try {
                sessionUserId = OWNER_ID;
                const response = await request(second.getHttpServer()).get(
                    URL.replace(':id', WORK),
                );

                expect(response.status).toBe(200);
                expect(withFile.getFileWebUrl).toHaveBeenCalledWith(
                    REPO_OWNER,
                    REPO_NAME,
                    SHA_A,
                    APP_SOURCE_SPEC_FILE,
                );
                expect(response.body.links).toEqual({
                    file: {
                        base: `https://github.com/${REPO_OWNER}/${REPO_NAME}/blob/${SHA_A}/${APP_SOURCE_SPEC_FILE}`,
                        commitSha: SHA_A,
                        path: APP_SOURCE_SPEC_FILE,
                    },
                    lineAnchor: '#L{line}',
                });
            } finally {
                await second.close();
            }
        });

        it('schedules exactly one evaluation for three reads inside the minute (ACC-03-14)', async () => {
            const first = await get();

            expect(first.status).toBe(200);
            // The head moved (the row has never been evaluated), so the read
            // requested one evaluation and said so.
            expect(first.body.evaluationPending).toBe(true);
            expect(first.body.links.file.commitSha).toBe(SHA_A);
            expect(h.git.getLatestCommit).toHaveBeenCalledTimes(1);
            expect(h.dispatchAppSpecEvaluate).toHaveBeenCalledTimes(1);

            const second = await get();
            const third = await get();

            expect(second.status).toBe(200);
            expect(third.status).toBe(200);
            // 🛑 The window is the claim: two more reads inside the 60 s change
            // nothing — no second head read, no second evaluation.
            expect(h.git.getLatestCommit).toHaveBeenCalledTimes(1);
            expect(h.dispatchAppSpecEvaluate).toHaveBeenCalledTimes(1);
            expect(Number((await storedState())?.requestedSeq)).toBe(1);
        });

        it('schedules nothing when the tracked branch has not moved', async () => {
            // A row evaluated two minutes ago, whose stored head IS the live
            // head: FR-19(d)'s window is open, the check runs, and it finds
            // nothing to do — so no evaluation is requested.
            await dataSource.query(
                `UPDATE "work_app_spec_states" SET "headCommitSha" = '${SHA_A}', ` +
                    `"validationStatus" = 'valid', "lastEvaluatedAt" = '2026-01-01 00:00:00.000' ` +
                    `WHERE "workId" = '${WORK}'`,
            );

            const response = await get();

            expect(response.status).toBe(200);
            expect(h.git.getLatestCommit).toHaveBeenCalledTimes(1);
            expect(h.dispatchAppSpecEvaluate).not.toHaveBeenCalled();
            expect(response.body.evaluationPending).toBe(false);
            expect(response.body.links.file.commitSha).toBe(SHA_A);
        });

        it('answers 404 for another account’s Work and for a Work that does not exist — the same body (ACC-03-41)', async () => {
            const stranger = await get(WORK, STRANGER_ID);
            const missing = await get(MISSING_WORK);

            expect(stranger.status).toBe(404);
            expect(missing.status).toBe(404);
            // No existence leak: the two bodies differ only in the id the caller
            // already knows, and both carry §4.2's message.
            expect(stranger.body).toEqual({
                status: 'error',
                code: 'not_found',
                message: `Work ${WORK} not found.`,
            });
            expect(missing.body).toEqual({
                status: 'error',
                code: 'not_found',
                message: `Work ${MISSING_WORK} not found.`,
            });
        });

        it('answers 404 for a visible App Work with no state row, never a synthesized state', async () => {
            await dataSource.query(`DELETE FROM "work_app_spec_states" WHERE "workId" = '${WORK}'`);

            const response = await get();

            expect(response.status).toBe(404);
            expect(response.body).toEqual({
                status: 'error',
                code: 'not_found',
                message: `Work ${WORK} has no App spec state yet.`,
            });
        });

        it('answers 422 notAnAppWork for a visible Work of another kind', async () => {
            const response = await get(WEBSITE_WORK);

            expect(response.status).toBe(422);
            expect(response.body).toMatchObject({ status: 'error', code: 'notAnAppWork' });
        });
    });

    // -----------------------------------------------------------------------
    // POST validate { source: 'content' } — ACC-03-08
    // -----------------------------------------------------------------------

    describe('POST app-spec/validate — source: content (ACC-03-08)', () => {
        it('answers 200 with the validator’s verdict and stores nothing', async () => {
            const before = await rowFingerprint();

            const response = await validate({ source: 'content', content: INVALID_SPEC_YAML });

            expect(response.status).toBe(200);
            expect(response.body.workId).toBe(WORK);
            expect(response.body.status).toBe('invalid');
            expect(response.body.errorCount).toBeGreaterThan(0);
            expect(Array.isArray(response.body.issues)).toBe(true);
            // The validator's own codes — this is the real validator, not a stub.
            expect(
                (response.body.issues as Array<{ code: string }>).map((issue) => issue.code),
            ).toContain('required');
            expect(typeof response.body.truncated).toBe('boolean');

            // 🛑 "stores nothing": the row is byte-identical, no Activity row was
            // written, no evaluation was requested and no provider call was made.
            expect(await rowFingerprint()).toBe(before);
            expect(h.activityLog).not.toHaveBeenCalled();
            expect(h.dispatchAppSpecEvaluate).not.toHaveBeenCalled();
            expect(h.git.getLatestCommit).not.toHaveBeenCalled();
            expect(h.git.getFileContent).not.toHaveBeenCalled();
        });

        it('accepts a valid draft against drafts that have never been evaluated', async () => {
            const response = await validate({ source: 'content', content: VALID_SPEC_YAML });

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('valid');
            expect(response.body.errorCount).toBe(0);
            expect(response.body.issues).toEqual([]);
        });

        it('refuses content larger than 256 KiB with 413 file_too_large, validating nothing', async () => {
            const before = await rowFingerprint();

            const response = await validate({
                source: 'content',
                content: 'x'.repeat(APP_SPEC_FILE_MAX_BYTES + 1),
            });

            expect(response.status).toBe(413);
            expect(response.body).toMatchObject({ status: 'error', code: 'file_too_large' });
            // Refused before the validator: no verdict, no issues, no write.
            expect(response.body.issues).toBeUndefined();
            expect(await rowFingerprint()).toBe(before);
            expect(h.activityLog).not.toHaveBeenCalled();
        });

        it('admits a document exactly at the 256 KiB ceiling (the boundary is `>`)', async () => {
            // The ceiling is measured on bytes; a comment pads the valid document
            // to exactly the limit, so the refusal above is a `>` and not a `>=`.
            const padding = `# ${'y'.repeat(APP_SPEC_FILE_MAX_BYTES - VALID_SPEC_YAML.length - 3)}\n`;
            const exact = `${VALID_SPEC_YAML}${padding}`;
            expect(Buffer.byteLength(exact, 'utf8')).toBe(APP_SPEC_FILE_MAX_BYTES);

            const response = await validate({ source: 'content', content: exact });

            expect(response.status).toBe(200);
        });

        it('refuses the 31st content request in a minute (ACC-03-08)', async () => {
            const statuses: number[] = [];
            for (let i = 0; i < APP_SPEC_CONTENT_VALIDATIONS_PER_MINUTE; i += 1) {
                statuses.push(
                    (await validate({ source: 'content', content: VALID_SPEC_YAML })).status,
                );
            }
            const refused = await validate({ source: 'content', content: VALID_SPEC_YAML });

            expect(statuses.every((status) => status === 200)).toBe(true);
            expect(refused.status).toBe(429);
            // Nest's own throttler body — the same one the platform's guard
            // produces, so a client cannot tell the two apart.
            expect(refused.body).toEqual({
                statusCode: 429,
                message: 'ThrottlerException: Too Many Requests',
            });
        });

        it('counts the content limit per member, so a second member is unaffected', async () => {
            await seedMember(WORK, EDITOR_ID, WorkMemberRole.EDITOR);

            for (let i = 0; i < APP_SPEC_CONTENT_VALIDATIONS_PER_MINUTE; i += 1) {
                await validate({ source: 'content', content: VALID_SPEC_YAML });
            }

            expect((await validate({ source: 'content', content: VALID_SPEC_YAML })).status).toBe(
                429,
            );
            expect(
                (await validate({ source: 'content', content: VALID_SPEC_YAML }, WORK, EDITOR_ID))
                    .status,
            ).toBe(200);
        });

        it('requires content when the source is content', async () => {
            const response = await validate({ source: 'content' });

            expect(response.status).toBe(400);
            expect(JSON.stringify(response.body.message)).toContain('content');
        });

        it('refuses an unknown source and an unknown field', async () => {
            expect((await validate({ source: 'file' })).status).toBe(400);
            expect((await validate({ source: 'branch', branch: 'main' })).status).toBe(400);
        });
    });

    // -----------------------------------------------------------------------
    // POST validate { source: 'branch' } — ACC-03-13
    // -----------------------------------------------------------------------

    describe('POST app-spec/validate — source: branch (ACC-03-13)', () => {
        it('answers 202 evaluationPending without awaiting the job', async () => {
            const response = await validate({ source: 'branch' });

            expect(response.status).toBe(202);
            expect(response.body).toEqual({ evaluationPending: true });
            // The route records the request and hands it to the runtime: it never
            // evaluates inline, and the answer says the evaluation is pending.
            expect(h.dispatchAppSpecEvaluate).toHaveBeenCalledTimes(1);
            const row = await storedState();
            expect(row?.validationStatus).toBe('missing');
            expect(Number(row?.requestedSeq)).toBe(1);
            expect(Number(row?.evaluatedSeq)).toBe(0);
        });

        it('three presses inside five seconds are one dispatch, and one evaluation settles all three', async () => {
            const first = await validate({ source: 'branch' });
            const second = await validate({ source: 'branch' });
            const third = await validate({ source: 'branch' });

            expect([first.status, second.status, third.status]).toEqual([202, 202, 202]);
            // 🛑 Three presses, ONE job: the second and third coalesced into the
            // dispatch the first one raised (FR-22's five-second window).
            expect(h.dispatchAppSpecEvaluate).toHaveBeenCalledTimes(1);
            expect(h.dispatchAppSpecEvaluate).toHaveBeenCalledWith(
                expect.objectContaining({ workId: WORK, trigger: 'manual' }),
            );

            const pending = await storedState();
            expect(Number(pending?.requestedSeq)).toBe(3);
            expect(Number(pending?.evaluatedSeq)).toBe(0);

            // The queued job, run once, claims the newest sequence and settles all
            // three requests.
            await h.appSpec.evaluate(WORK);

            const settled = await storedState();
            expect(Number(settled?.requestedSeq)).toBe(3);
            expect(Number(settled?.evaluatedSeq)).toBe(3);
            expect(settled?.validationStatus).toBe('valid');
            expect(settled?.headCommitSha).toBe(SHA_A);
            expect(h.emitted).toHaveLength(1);

            const read = await get();
            expect(read.status).toBe(200);
            expect(read.body.evaluationPending).toBe(false);
            expect(read.body.validationStatus).toBe('valid');
            expect(read.body.effectiveSpecHash).toBeTruthy();
            expect(read.body.effectiveSpec).toMatchObject({ build: { strategy: 'dockerfile' } });
        });

        it('refuses the 7th branch press in a minute (ACC-03-13)', async () => {
            const statuses: number[] = [];
            for (let i = 0; i < APP_SPEC_BRANCH_VALIDATIONS_PER_MINUTE; i += 1) {
                statuses.push((await validate({ source: 'branch' })).status);
            }
            const refused = await validate({ source: 'branch' });

            expect(APP_SPEC_BRANCH_VALIDATIONS_PER_MINUTE).toBe(6);
            expect(statuses).toEqual([202, 202, 202, 202, 202, 202]);
            expect(refused.status).toBe(429);
            expect(refused.body.message).toBe('ThrottlerException: Too Many Requests');
        });

        it('counts the branch limit per Work, so a second Work has its own window', async () => {
            const secondWork = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
            await seedWork({
                id: secondWork,
                userId: OWNER_ID,
                kind: 'app',
                slug: 'second-app',
                withRepositories: true,
            });
            await states.initialize(secondWork, 'main');

            for (let i = 0; i < APP_SPEC_BRANCH_VALIDATIONS_PER_MINUTE; i += 1) {
                await validate({ source: 'branch' });
            }

            expect((await validate({ source: 'branch' })).status).toBe(429);
            expect((await validate({ source: 'branch' }, secondWork)).status).toBe(202);
        });

        it('a viewer may read but not re-check; an editor may (ACC-03-41)', async () => {
            await seedMember(WORK, VIEWER_ID, WorkMemberRole.VIEWER);
            await seedMember(WORK, EDITOR_ID, WorkMemberRole.EDITOR);

            const viewerRead = await get(WORK, VIEWER_ID);
            const viewerCheck = await validate({ source: 'branch' }, WORK, VIEWER_ID);
            const editorCheck = await validate({ source: 'branch' }, WORK, EDITOR_ID);

            expect(viewerRead.status).toBe(200);
            // `ensureCanEdit` refuses a viewer, and §4.2 answers 404 — never 403,
            // which would confirm the Work exists and that the caller is merely
            // not allowed to re-check it.
            expect(viewerCheck.status).toBe(404);
            expect(viewerCheck.body).toEqual({
                status: 'error',
                code: 'not_found',
                message: `Work ${WORK} not found.`,
            });
            expect(editorCheck.status).toBe(202);
        });

        it('a viewer may still validate content', async () => {
            await seedMember(WORK, VIEWER_ID, WorkMemberRole.VIEWER);

            const response = await validate(
                { source: 'content', content: VALID_SPEC_YAML },
                WORK,
                VIEWER_ID,
            );

            expect(response.status).toBe(200);
        });

        it('answers 404 for a stranger and 422 for another kind, on this route too', async () => {
            const stranger = await validate({ source: 'branch' }, WORK, STRANGER_ID);
            const otherKind = await validate({ source: 'branch' }, WEBSITE_WORK);

            expect(stranger.status).toBe(404);
            expect(otherKind.status).toBe(422);
            expect(otherKind.body.code).toBe('notAnAppWork');
        });

        it('never answers 202 for a request that was not recorded', async () => {
            // A visible App Work whose state row is gone: there is nothing to
            // record the request against, so `202 { evaluationPending: true }`
            // would be a claim about an evaluation nothing holds. The read
            // answers 404 for the same condition, and so does this route.
            await dataSource.query(`DELETE FROM "work_app_spec_states" WHERE "workId" = '${WORK}'`);

            const response = await validate({ source: 'branch' });

            expect(response.status).toBe(404);
            expect(response.body).toEqual({
                status: 'error',
                code: 'not_found',
                message: `Work ${WORK} has no App spec state yet.`,
            });
            expect(h.dispatchAppSpecEvaluate).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // The two windows, driven exactly — no wall clock, no flakiness
    // -----------------------------------------------------------------------

    describe('AppSpecValidateThrottle', () => {
        let nowMs: number;
        let throttle: AppSpecValidateThrottle;

        beforeEach(() => {
            nowMs = Date.parse('2026-03-01T06:00:00.000Z');
            throttle = new AppSpecValidateThrottle(() => nowMs);
        });

        it('admits the limit, refuses the next, and opens a fresh window after it', () => {
            for (let i = 0; i < APP_SPEC_BRANCH_VALIDATIONS_PER_MINUTE; i += 1) {
                expect([i + 1, throttle.take(`branch:${WORK}`, 6)]).toEqual([i + 1, true]);
            }
            expect(throttle.take(`branch:${WORK}`, 6)).toBe(false);

            // One millisecond short of the window: still refused.
            nowMs += APP_SPEC_VALIDATE_WINDOW_MS - 1;
            expect(throttle.take(`branch:${WORK}`, 6)).toBe(false);

            // The window is a minute, and it starts at the first request.
            nowMs += 1;
            expect(throttle.take(`branch:${WORK}`, 6)).toBe(true);
        });

        it('keeps one window per key', () => {
            for (let i = 0; i < 6; i += 1) {
                throttle.take(`branch:${WORK}`, 6);
            }

            expect(throttle.take(`branch:${WORK}`, 6)).toBe(false);
            expect(throttle.take(`branch:${WEBSITE_WORK}`, 6)).toBe(true);
            expect(throttle.take(`content:${OWNER_ID}`, 30)).toBe(true);
        });
    });

    // -----------------------------------------------------------------------
    // The constants themselves — plan §4.1's numbers and §6.6's window
    // -----------------------------------------------------------------------

    describe('the limits the task fixes', () => {
        it('uses the plan’s numbers, not copies of them', () => {
            expect(APP_SPEC_BRANCH_VALIDATIONS_PER_MINUTE).toBe(6);
            expect(APP_SPEC_CONTENT_VALIDATIONS_PER_MINUTE).toBe(30);
            expect(APP_SPEC_VALIDATE_WINDOW_MS).toBe(60_000);
            // The lazy-check window ACC-03-14 is measured against, and the
            // coalescing window ACC-03-13's three presses fall inside.
            expect(APP_SPEC_LAZY_HEAD_CHECK_MS).toBe(60_000);
            expect(APP_SPEC_EVALUATE_COALESCE_MS).toBe(5_000);
            expect(APP_SPEC_FILE_MAX_BYTES).toBe(256 * 1024);
            // The platform's parser ceiling must sit above the spec ceiling, or
            // §4.2's 413 could never be the answer: the parser would refuse the
            // body first, with its own body and its own code.
            expect(BODY_LIMIT_BYTES).toBeGreaterThan(APP_SPEC_FILE_MAX_BYTES);
        });
    });
});
