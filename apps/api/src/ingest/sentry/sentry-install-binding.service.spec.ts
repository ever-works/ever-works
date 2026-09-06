import { ConflictException } from '@nestjs/common';

jest.mock('@ever-works/agent/ingest', () => ({
    IngestInstallBindingRepository: class {},
}));

import {
    SENTRY_BINDING_PROVIDER,
    SENTRY_PLUGIN_ID,
    SentryInstallBindingService,
    normalizeSentryInstallationUuid,
    sentryInstallationKey,
} from './sentry-install-binding.service';

const UUID = '5f6e4d3c-2b1a-4c9d-8e7f-0a1b2c3d4e5f';
const KEY = `installation:${UUID}`;

function build() {
    const rows = new Map<string, { userId: string; externalWorkspaceName: string | null }>();
    const repo = {
        findByWorkspace: jest.fn(async (provider: string, key: string) => {
            const row = rows.get(`${provider}|${key}`);
            return row
                ? {
                      provider,
                      externalWorkspaceId: key,
                      userId: row.userId,
                      externalWorkspaceName: row.externalWorkspaceName,
                      createdAt: new Date('2026-09-01T00:00:00.000Z'),
                  }
                : null;
        }),
        record: jest.fn(
            async (data: {
                provider: string;
                externalWorkspaceId: string;
                userId: string;
                externalWorkspaceName?: string | null;
            }) => {
                const id = `${data.provider}|${data.externalWorkspaceId}`;
                const existing = rows.get(id);
                if (!existing) {
                    rows.set(id, {
                        userId: data.userId,
                        externalWorkspaceName: data.externalWorkspaceName ?? null,
                    });
                } else {
                    existing.userId = data.userId;
                    if (data.externalWorkspaceName) {
                        existing.externalWorkspaceName = data.externalWorkspaceName;
                    }
                }
                const row = rows.get(id)!;
                return {
                    ...data,
                    externalWorkspaceName: row.externalWorkspaceName,
                    createdAt: new Date('2026-09-01T00:00:00.000Z'),
                };
            },
        ),
        /**
         * Insert-only twin of `record` (see the repository doc): it NEVER
         * re-points an existing row, it hands the current holder back. The
         * distinction is the whole first-claim-wins guarantee, so the fake
         * has to model it exactly.
         */
        recordIfAbsent: jest.fn(
            async (data: {
                provider: string;
                externalWorkspaceId: string;
                userId: string;
                externalWorkspaceName?: string | null;
            }) => {
                const id = `${data.provider}|${data.externalWorkspaceId}`;
                const existing = rows.get(id);
                if (existing) {
                    return {
                        ...data,
                        userId: existing.userId,
                        externalWorkspaceName: existing.externalWorkspaceName,
                        createdAt: new Date('2026-09-01T00:00:00.000Z'),
                    };
                }
                rows.set(id, {
                    userId: data.userId,
                    externalWorkspaceName: data.externalWorkspaceName ?? null,
                });
                return {
                    ...data,
                    externalWorkspaceName: data.externalWorkspaceName ?? null,
                    createdAt: new Date('2026-09-01T00:00:00.000Z'),
                };
            },
        ),
        findByUser: jest.fn(async (userId: string) =>
            [...rows.entries()]
                .filter(([, row]) => row.userId === userId)
                .map(([id, row]) => {
                    const [provider, externalWorkspaceId] = id.split('|');
                    return {
                        provider,
                        externalWorkspaceId,
                        userId,
                        externalWorkspaceName: row.externalWorkspaceName,
                        createdAt: new Date('2026-09-01T00:00:00.000Z'),
                    };
                }),
        ),
        remove: jest.fn(async (provider: string, key: string) => rows.delete(`${provider}|${key}`)),
    };
    const service = new SentryInstallBindingService(repo as never);
    return { service, repo, rows };
}

describe('SentryInstallBindingService', () => {
    describe('normalizeSentryInstallationUuid / sentryInstallationKey', () => {
        it('lower-cases a well-formed uuid and rejects anything else', () => {
            expect(normalizeSentryInstallationUuid(UUID.toUpperCase())).toBe(UUID);
            expect(normalizeSentryInstallationUuid(` ${UUID} `)).toBe(UUID);
            expect(normalizeSentryInstallationUuid('not-a-uuid')).toBeUndefined();
            expect(normalizeSentryInstallationUuid('')).toBeUndefined();
            expect(normalizeSentryInstallationUuid(42)).toBeUndefined();
            expect(normalizeSentryInstallationUuid(undefined)).toBeUndefined();
            expect(sentryInstallationKey(UUID)).toBe(KEY);
        });
    });

    describe('resolveOwner', () => {
        it('returns the claiming user for a bound installation', async () => {
            const { service, rows } = build();
            rows.set(`sentry|${KEY}`, { userId: 'user-a', externalWorkspaceName: null });
            await expect(service.resolveOwner(UUID)).resolves.toEqual({
                userId: 'user-a',
                installationUuid: UUID,
            });
            await expect(service.resolveOwner(UUID.toUpperCase())).resolves.toEqual({
                userId: 'user-a',
                installationUuid: UUID,
            });
        });

        it('returns null for an unclaimed installation and never guesses', async () => {
            const { service } = build();
            await expect(service.resolveOwner(UUID)).resolves.toBeNull();
        });

        it('returns null for a malformed uuid without touching the repository', async () => {
            const { service, repo } = build();
            await expect(service.resolveOwner('installation:evil')).resolves.toBeNull();
            await expect(service.resolveOwner(undefined)).resolves.toBeNull();
            expect(repo.findByWorkspace).not.toHaveBeenCalled();
        });
    });

    describe('claim (first claim wins)', () => {
        it('records the binding under the sentry provider for the caller', async () => {
            const { service, repo } = build();
            const view = await service.claim('user-a', UUID, 'ever-co');
            // A FIRST claim must never take the re-pointing write — see
            // the race test below.
            expect(repo.recordIfAbsent).toHaveBeenCalledWith({
                provider: SENTRY_BINDING_PROVIDER,
                externalWorkspaceId: KEY,
                userId: 'user-a',
                pluginId: SENTRY_PLUGIN_ID,
                externalWorkspaceName: 'ever-co',
            });
            expect(repo.record).not.toHaveBeenCalled();
            expect(view).toEqual({
                installationUuid: UUID,
                label: 'ever-co',
                createdAt: new Date('2026-09-01T00:00:00.000Z'),
            });
        });

        it('⭐ refuses (409) an installation already claimed by another account — and never re-points it', async () => {
            const { service, repo, rows } = build();
            rows.set(`sentry|${KEY}`, { userId: 'user-a', externalWorkspaceName: null });

            await expect(service.claim('user-b', UUID)).rejects.toBeInstanceOf(ConflictException);
            expect(repo.record).not.toHaveBeenCalled();
            expect(repo.recordIfAbsent).not.toHaveBeenCalled();
            expect(rows.get(`sentry|${KEY}`)?.userId).toBe('user-a');
        });

        /**
         * The theft the first-claim rule exists to stop. Both callers see
         * an unclaimed uuid, then their writes interleave. A re-pointing
         * write would hand the stream to whoever wrote LAST; the
         * insert-only write hands the loser the winner's row, which the
         * service turns into a 409.
         */
        it('⭐ a claim that races another first claim loses it — never steals the winner’s row', async () => {
            const { service, repo, rows } = build();
            // user-b's claim lands between user-a's existence check and
            // user-a's write.
            repo.findByWorkspace.mockImplementationOnce(async () => {
                rows.set(`sentry|${KEY}`, { userId: 'user-b', externalWorkspaceName: 'globex' });
                return null;
            });

            await expect(service.claim('user-a', UUID, 'ever-co')).rejects.toBeInstanceOf(
                ConflictException,
            );
            expect(rows.get(`sentry|${KEY}`)?.userId).toBe('user-b');
            expect(rows.get(`sentry|${KEY}`)?.externalWorkspaceName).toBe('globex');
        });

        it('is idempotent for the same account (label refresh only)', async () => {
            const { service, rows } = build();
            await service.claim('user-a', UUID);
            const view = await service.claim('user-a', UUID, 'renamed');
            expect(view.label).toBe('renamed');
            expect(rows.get(`sentry|${KEY}`)?.userId).toBe('user-a');
        });

        it('refuses when a concurrent first claim won the UNIQUE race', async () => {
            const { service, repo } = build();
            // The repository adopts the race winner: the row that comes back
            // belongs to somebody else.
            repo.recordIfAbsent.mockResolvedValueOnce({
                provider: 'sentry',
                externalWorkspaceId: KEY,
                userId: 'user-a',
                externalWorkspaceName: null,
                createdAt: new Date(),
            });
            await expect(service.claim('user-b', UUID)).rejects.toBeInstanceOf(ConflictException);
        });

        it('refuses a malformed uuid at the service floor', async () => {
            const { service, repo } = build();
            await expect(service.claim('user-a', 'nope')).rejects.toBeInstanceOf(ConflictException);
            expect(repo.record).not.toHaveBeenCalled();
            expect(repo.recordIfAbsent).not.toHaveBeenCalled();
        });
    });

    describe('listForUser', () => {
        it('lists only the caller’s sentry bindings', async () => {
            const { service, rows } = build();
            rows.set(`sentry|${KEY}`, { userId: 'user-a', externalWorkspaceName: 'ever-co' });
            rows.set('github|installation:99', { userId: 'user-a', externalWorkspaceName: 'octo' });
            rows.set('sentry|installation:other', {
                userId: 'user-b',
                externalWorkspaceName: null,
            });

            await expect(service.listForUser('user-a')).resolves.toEqual([
                {
                    installationUuid: UUID,
                    label: 'ever-co',
                    createdAt: new Date('2026-09-01T00:00:00.000Z'),
                },
            ]);
        });
    });

    describe('unbind', () => {
        it('releases the caller’s own binding', async () => {
            const { service, repo, rows } = build();
            rows.set(`sentry|${KEY}`, { userId: 'user-a', externalWorkspaceName: null });
            await expect(service.unbind('user-a', UUID)).resolves.toBe(true);
            expect(repo.remove).toHaveBeenCalledWith('sentry', KEY);
            expect(rows.has(`sentry|${KEY}`)).toBe(false);
        });

        it('answers false — never removes — for another account’s binding or an unknown uuid', async () => {
            const { service, repo, rows } = build();
            rows.set(`sentry|${KEY}`, { userId: 'user-a', externalWorkspaceName: null });
            await expect(service.unbind('user-b', UUID)).resolves.toBe(false);
            await expect(
                service.unbind('user-a', '00000000-0000-4000-8000-000000000000'),
            ).resolves.toBe(false);
            expect(repo.remove).not.toHaveBeenCalled();
            expect(rows.get(`sentry|${KEY}`)?.userId).toBe('user-a');
        });
    });

    describe('onInstallationDeleted', () => {
        it('drops the binding when Sentry reports the installation gone', async () => {
            const { service, repo, rows } = build();
            rows.set(`sentry|${KEY}`, { userId: 'user-a', externalWorkspaceName: null });
            await expect(service.onInstallationDeleted(UUID)).resolves.toBe(true);
            expect(repo.remove).toHaveBeenCalledWith('sentry', KEY);
        });

        it('ignores malformed or unknown uuids', async () => {
            const { service, repo } = build();
            await expect(service.onInstallationDeleted('garbage')).resolves.toBe(false);
            await expect(service.onInstallationDeleted(UUID)).resolves.toBe(false);
            expect(repo.remove).toHaveBeenCalledTimes(1);
        });
    });
});
