import { AppBuildRepository } from '../../database/repositories/app-build.repository';
import { WorkBuild } from '../../entities/work-build.entity';
import { APP_BUILD_PLUGIN_RESOLVER, type AppBuildPluginResolver } from '../app-builds.service';
import {
    APP_BUILD_PLATFORM_SETTINGS_WRITER,
    APP_BUILD_PULL_TOKEN_CODES,
    AppBuildPullTokenService,
    pullTokenRefusalFor,
    pullTokenStatusCodeFor,
    type AppBuildPlatformManagedSettingsWriter,
} from '../app-build-pull-token.service';

/**
 * APW-05 T17 — `AppBuildPullTokenService` (plan §4.12, `APW05-G07`, ACC-05-21).
 *
 * The task's Done-when names this file (`… test -- deployable-verdict
 * app-builds.service app-build-pull-token.service`), and it owns the four G07
 * assertions: the three refusal codes, `pullTokenNoImageYet` with no Build, and
 * `pullTokenExpiresAt` written through `writePlatformManagedWorkSettings`.
 *
 * Everything here is a hand-built fake — no Nest container, no database — because
 * the properties under test are the ORDER of the five steps of §4.12 and the code
 * each `ImageAccessResult` maps to, not any provider call.
 */

const WORK_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

/** A Build row with an image digest — the only shape §4.12 step 2 can use. */
function buildWithDigest(overrides: Partial<WorkBuild> = {}): WorkBuild {
    return {
        id: '33333333-3333-4333-8333-333333333333',
        workId: WORK_ID,
        number: 7,
        buildPluginId: 'github-actions-build',
        status: 'succeeded',
        trigger: 'push',
        branch: 'main',
        commitSha: 'a'.repeat(40),
        imageRepository: 'ghcr.io/acme/shop/ever-works-app',
        imageDigest: `sha256:${'b'.repeat(64)}`,
        imageTags: [`sha-${'a'.repeat(40)}`],
        digestConfirmed: true,
        deployable: true,
        runAttempt: 1,
        syncOrigin: 'none',
        queuedAt: new Date('2026-09-17T10:00:00.000Z'),
        startedAt: new Date('2026-09-17T10:01:00.000Z'),
        completedAt: new Date('2026-09-17T10:05:00.000Z'),
        createdAt: new Date('2026-09-17T10:00:00.000Z'),
        updatedAt: new Date('2026-09-17T10:05:00.000Z'),
        ...overrides,
    } as WorkBuild;
}

interface Fakes {
    readonly service: AppBuildPullTokenService;
    readonly pageCalls: Array<{ workId: string; page: number; pageSize: number }>;
    readonly accessCalls: Array<{ imageRepository: string; tag: string; pullToken?: string }>;
    readonly writes: Array<{ pluginId: string; workId: string; values: Record<string, unknown> }>;
}

function makeService(options: {
    readonly rows?: WorkBuild[];
    readonly resolve?: AppBuildPluginResolver['resolve'];
    readonly checkImageAccess?: NonNullable<
        NonNullable<ReturnType<AppBuildPluginResolver['resolve']>> extends Promise<infer R>
            ? R extends { checkImageAccess?: infer C }
                ? C
                : never
            : never
    >;
    readonly writer?: AppBuildPlatformManagedSettingsWriter | null;
}): Fakes {
    const pageCalls: Fakes['pageCalls'] = [];
    const accessCalls: Fakes['accessCalls'] = [];
    const writes: Fakes['writes'] = [];

    const builds = {
        findPage: async (workId: string, _filters: unknown, page: number, pageSize: number) => {
            pageCalls.push({ workId, page, pageSize });
            const rows = options.rows ?? [];
            return { rows, total: rows.length, page, pageSize, hasMore: false };
        },
    } as unknown as AppBuildRepository;

    const resolver: AppBuildPluginResolver = {
        resolve: async (workId, userId) => {
            if (options.resolve) return options.resolve(workId, userId);
            return {
                pluginId: 'github-actions-build',
                buildKind: 'github-actions',
                imageRepository: 'ghcr.io/acme/shop/ever-works-app',
                checkImageAccess:
                    options.checkImageAccess ??
                    (async (input) => {
                        accessCalls.push({ ...input });
                        return {
                            visibility: 'private' as const,
                            readable: true,
                            tokenScopesOk: true,
                            tokenExpiresAt: '2027-01-01T00:00:00.000Z',
                            digest: `sha256:${'c'.repeat(64)}`,
                        };
                    }),
            };
        },
    };

    const writer: AppBuildPlatformManagedSettingsWriter | null =
        options.writer === undefined
            ? {
                  writePlatformManagedWorkSettings: async (pluginId, workId, values) => {
                      writes.push({ pluginId, workId, values });
                      return { ok: true };
                  },
              }
            : options.writer;

    const service = new AppBuildPullTokenService(builds, resolver, writer ?? undefined);

    return { service, pageCalls, accessCalls, writes };
}

describe('AppBuildPullTokenService (plan §4.12, APW05-G07)', () => {
    describe('the refusal mapping', () => {
        it('maps a public image to `pullTokenPublicImage`', () => {
            expect(
                pullTokenRefusalFor({ visibility: 'public', readable: true, tokenScopesOk: true }),
            ).toBe('pullTokenPublicImage');
        });

        it('maps wrong scopes to `pullTokenTooBroad`', () => {
            expect(
                pullTokenRefusalFor({
                    visibility: 'private',
                    readable: true,
                    tokenScopesOk: false,
                }),
            ).toBe('pullTokenTooBroad');
        });

        it('maps an ABSENT scope header to `pullTokenFineGrained`', () => {
            expect(pullTokenRefusalFor({ visibility: 'private', readable: false })).toBe(
                'pullTokenFineGrained',
            );
        });

        it('maps a readable private image with correct scopes to no refusal', () => {
            expect(
                pullTokenRefusalFor({ visibility: 'private', readable: true, tokenScopesOk: true }),
            ).toBeNull();
        });

        it('maps anything else unreadable to `pullTokenCannotRead`', () => {
            expect(
                pullTokenRefusalFor({
                    visibility: 'private',
                    readable: false,
                    tokenScopesOk: true,
                }),
            ).toBe('pullTokenCannotRead');
            expect(
                pullTokenRefusalFor({
                    visibility: 'unknown',
                    readable: false,
                    tokenScopesOk: true,
                }),
            ).toBe('pullTokenCannotRead');
        });

        it('gives each code the status the route table fixes', () => {
            expect(pullTokenStatusCodeFor('pullTokenNoImageYet')).toBe(409);
            expect(pullTokenStatusCodeFor('pullTokenUnavailable')).toBe(503);
            for (const code of [
                'pullTokenTooBroad',
                'pullTokenFineGrained',
                'pullTokenCannotRead',
            ] as const) {
                expect(pullTokenStatusCodeFor(code)).toBe(422);
                expect(APP_BUILD_PULL_TOKEN_CODES).toContain(code);
            }
        });
    });

    describe('save', () => {
        it('answers `pullTokenNoImageYet` and no Build when nothing has an image digest', async () => {
            const { service, accessCalls, writes } = makeService({
                rows: [buildWithDigest({ imageDigest: null, digestConfirmed: false })],
            });

            const result = await service.save(WORK_ID, USER_ID, 'ghp_readpackages');

            expect(result).toEqual({
                ok: false,
                status: 409,
                code: 'pullTokenNoImageYet',
            });
            // §4.12 step 2 returns before step 3: the token is never sent anywhere.
            expect(accessCalls).toHaveLength(0);
            expect(writes).toHaveLength(0);
        });

        it('checks the manifest tag of the newest Build that HAS a digest', async () => {
            const older = buildWithDigest({
                id: 'older',
                commitSha: 'c'.repeat(40),
                createdAt: new Date('2026-09-16T10:00:00.000Z'),
            });
            const newest = buildWithDigest({ id: 'newest', commitSha: 'd'.repeat(40) });
            const { service, accessCalls } = makeService({ rows: [newest, older] });

            const result = await service.save(WORK_ID, USER_ID, 'ghp_readpackages');

            expect(result.ok).toBe(true);
            expect(accessCalls).toEqual([
                {
                    imageRepository: 'ghcr.io/acme/shop/ever-works-app',
                    tag: `sha-${'d'.repeat(40)}`,
                    pullToken: 'ghp_readpackages',
                },
            ]);
        });

        it('returns `pullTokenTooBroad` with 422 and stores nothing', async () => {
            const { service, writes } = makeService({
                rows: [buildWithDigest()],
                checkImageAccess: async () => ({
                    visibility: 'private',
                    readable: true,
                    tokenScopesOk: false,
                }),
            });

            const result = await service.save(WORK_ID, USER_ID, 'ghp_too_broad');

            expect(result).toEqual({ ok: false, status: 422, code: 'pullTokenTooBroad' });
            expect(writes).toHaveLength(0);
        });

        it('returns `pullTokenFineGrained` with 422 when the scope header is absent', async () => {
            const { service, writes } = makeService({
                rows: [buildWithDigest()],
                checkImageAccess: async () => ({ visibility: 'private', readable: false }),
            });

            const result = await service.save(WORK_ID, USER_ID, 'github_pat_x');

            expect(result).toEqual({ ok: false, status: 422, code: 'pullTokenFineGrained' });
            expect(writes).toHaveLength(0);
        });

        it('returns `pullTokenCannotRead` with 422 when the manifest is still unreadable', async () => {
            const { service, writes } = makeService({
                rows: [buildWithDigest()],
                checkImageAccess: async () => ({
                    visibility: 'private',
                    readable: false,
                    tokenScopesOk: true,
                }),
            });

            const result = await service.save(WORK_ID, USER_ID, 'ghp_wrong_repo');

            expect(result).toEqual({ ok: false, status: 422, code: 'pullTokenCannotRead' });
            expect(writes).toHaveLength(0);
        });

        it('writes `pullToken` and `pullTokenExpiresAt` through writePlatformManagedWorkSettings', async () => {
            const { service, writes } = makeService({ rows: [buildWithDigest()] });

            const result = await service.save(WORK_ID, USER_ID, 'ghp_readpackages');

            expect(writes).toEqual([
                {
                    pluginId: 'github-actions-build',
                    workId: WORK_ID,
                    values: {
                        pullToken: 'ghp_readpackages',
                        pullTokenExpiresAt: '2027-01-01T00:00:00.000Z',
                    },
                },
            ]);
            expect(result).toMatchObject({
                ok: true,
                buildId: '33333333-3333-4333-8333-333333333333',
                pullAccess: {
                    visibility: 'private',
                    tokenSet: true,
                    tokenExpiresAt: '2027-01-01T00:00:00.000Z',
                },
            });
        });

        it('writes a NULL expiry for a token that never expires', async () => {
            const { service, writes } = makeService({
                rows: [buildWithDigest()],
                checkImageAccess: async () => ({
                    visibility: 'private',
                    readable: true,
                    tokenScopesOk: true,
                    tokenExpiresAt: null,
                }),
            });

            const result = await service.save(WORK_ID, USER_ID, 'ghp_forever');

            expect(writes[0].values).toEqual({
                pullToken: 'ghp_forever',
                pullTokenExpiresAt: null,
            });
            expect(result).toMatchObject({
                ok: true,
                expiresInDays: null,
                pullAccess: { tokenExpiresAt: null },
            });
        });

        it('never returns the token in its answer', async () => {
            const { service } = makeService({ rows: [buildWithDigest()] });

            const result = await service.save(WORK_ID, USER_ID, 'ghp_super_secret_value');

            expect(JSON.stringify(result)).not.toContain('ghp_super_secret_value');
        });

        it('answers `pullTokenUnavailable` when the App Work has no build plugin', async () => {
            const { service } = makeService({
                rows: [buildWithDigest()],
                resolve: async () => null,
            });

            expect(await service.save(WORK_ID, USER_ID, 'ghp_x')).toEqual({
                ok: false,
                status: 503,
                code: 'pullTokenUnavailable',
            });
        });

        it('answers `pullTokenUnavailable` when the plugin cannot check registry access', async () => {
            const { service } = makeService({
                rows: [buildWithDigest()],
                resolve: async () => ({
                    pluginId: 'apps-builder',
                    buildKind: 'apps-builder',
                    imageRepository: null,
                }),
            });

            expect(await service.save(WORK_ID, USER_ID, 'ghp_x')).toEqual({
                ok: false,
                status: 503,
                code: 'pullTokenUnavailable',
            });
        });

        it('answers `pullTokenUnavailable` when the settings writer throws', async () => {
            const { service } = makeService({
                rows: [buildWithDigest()],
                writer: {
                    writePlatformManagedWorkSettings: async () => {
                        throw new Error('sealed store offline');
                    },
                },
            });

            expect(await service.save(WORK_ID, USER_ID, 'ghp_x')).toEqual({
                ok: false,
                status: 503,
                code: 'pullTokenUnavailable',
            });
        });

        it('answers `pullTokenUnavailable` before any registry call when no settings writer is bound', async () => {
            // `APP_BUILD_PLATFORM_SETTINGS_WRITER` is optional and bound nowhere yet
            // (app-builds.module.ts). Without it the token cannot be stored, so an
            // `ok: true, tokenSet: true` answer would claim a save that never happened,
            // and the token would still have been sent to the registry for nothing.
            const { service, accessCalls, pageCalls } = makeService({
                rows: [buildWithDigest()],
                writer: null,
            });

            expect(await service.save(WORK_ID, USER_ID, 'ghp_x')).toEqual({
                ok: false,
                status: 503,
                code: 'pullTokenUnavailable',
            });
            expect(accessCalls).toHaveLength(0);
            expect(pageCalls).toHaveLength(0);
        });
    });

    describe('the expiry warning (FR-51)', () => {
        it('reports days only inside the warning window', () => {
            const { service } = makeService({ rows: [buildWithDigest()] });
            // An hour of headroom keeps the floor deterministic: `daysUntil` measures
            // whole days from the moment it is called.
            const soon = new Date(Date.now() + 3 * 86_400_000 + 3_600_000).toISOString();
            const far = new Date(Date.now() + 400 * 86_400_000).toISOString();

            expect(service.warningDaysUntilExpiry(soon)).toBe(3);
            expect(service.warningDaysUntilExpiry(far)).toBeNull();
            expect(service.warningDaysUntilExpiry(null)).toBeNull();
        });
    });
});
