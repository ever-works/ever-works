import type { WorkBuild } from '../../entities/work-build.entity';
import { AppBuildsService } from '../app-builds.service';

/**
 * 2026-10-17 (lane aw-builds-2) — three additions to `AppBuildsService`:
 *
 *  - a caller-named Rebuild `commitSha` must be in the tracked branch's history
 *    (plan §5's "40 hex, reachable"), or it is `commitNotReachable`;
 *  - after a pull-token save, the Work's `digestUnconfirmed` Builds are re-checked
 *    (§4.12, §7.4), and the registry read now carries the saved pull token;
 *  - a verification Build's orphaned prompted-value secret is removed (§7.4).
 */

const WORK_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;
const IMAGE = 'ghcr.io/acme/app/ever-works-app';

function service(options: {
    binding?: Record<string, unknown> | null;
    rows?: Partial<WorkBuild>[];
    rowById?: Partial<WorkBuild> | null;
}) {
    const inserted: Partial<WorkBuild>[] = [];
    const builds = {
        findRecentForCommit: jest.fn(async () => null),
        findPage: jest.fn(async () => ({
            rows: options.rows ?? [],
            total: (options.rows ?? []).length,
            page: 1,
            pageSize: 20,
            hasMore: false,
        })),
        insertWithNextNumber: jest.fn(async (_workId: string, data: Partial<WorkBuild>) => {
            inserted.push(data);
            return { id: 'new-build', number: 1, workId: WORK_ID, ...data } as WorkBuild;
        }),
    };
    const rows = {
        findOne: jest.fn(async () => options.rowById ?? null),
        merge: jest.fn((row: Record<string, unknown>, patch: Record<string, unknown>) =>
            Object.assign(row, patch),
        ),
        save: jest.fn(async (row: unknown) => row),
    };
    const works = {
        read: jest.fn(async () => ({
            workId: WORK_ID,
            userId: USER_ID,
            trackedBranch: 'main',
            buildPluginId: 'github-actions-build',
            repositoryFullName: 'acme/app',
            repositoryVisibility: 'private' as const,
        })),
    };
    const specs = {
        read: jest.fn(async () => ({
            spec: { build: { strategy: 'dockerfile' } },
            commitSha: SHA,
        })),
    };
    const plugins = {
        resolve: jest.fn(async () =>
            options.binding === undefined
                ? {
                      pluginId: 'github-actions-build',
                      buildKind: 'github-actions',
                      imageRepository: IMAGE,
                  }
                : options.binding,
        ),
    };
    const svc = new AppBuildsService(
        builds as never,
        { findByWork: jest.fn(async () => null), upsertAfterPrepare: jest.fn() } as never,
        rows as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        plugins as never,
        works as never,
        specs as never,
    );
    return { svc, builds, rows, inserted, plugins };
}

describe('AppBuildsService — aw-builds-2 additions', () => {
    describe('requestRebuild: a named commit must be on the tracked branch (plan §5)', () => {
        it('refuses a commit the tracked branch does not contain', async () => {
            const isCommitReachable = jest.fn(async () => false);
            const h = service({
                binding: {
                    pluginId: 'p',
                    buildKind: 'github-actions',
                    imageRepository: IMAGE,
                    isCommitReachable,
                },
            });
            await expect(
                h.svc.requestRebuild(WORK_ID, USER_ID, { commitSha: 'c'.repeat(40) }),
            ).resolves.toEqual({
                ok: false,
                code: 'commitNotReachable',
            });
            expect(isCommitReachable).toHaveBeenCalledWith('c'.repeat(40));
            expect(h.builds.insertWithNextNumber).not.toHaveBeenCalled();
        });

        it('refuses a named commit when no build plugin can be resolved to check it', async () => {
            const h = service({ binding: null });
            await expect(
                h.svc.requestRebuild(WORK_ID, USER_ID, { commitSha: 'c'.repeat(40) }),
            ).resolves.toEqual({
                ok: false,
                code: 'buildProviderUnavailable',
            });
        });

        it('refuses with buildProviderUnavailable when the provider cannot tell', async () => {
            const h = service({
                binding: {
                    pluginId: 'p',
                    buildKind: 'github-actions',
                    imageRepository: IMAGE,
                    isCommitReachable: jest.fn(async () => {
                        throw new Error('GitHub 502');
                    }),
                },
            });
            await expect(
                h.svc.requestRebuild(WORK_ID, USER_ID, { commitSha: 'c'.repeat(40) }),
            ).resolves.toEqual({
                ok: false,
                code: 'buildProviderUnavailable',
            });
        });

        it('builds a reachable commit, and does not check when no commit is named', async () => {
            const isCommitReachable = jest.fn(async () => true);
            const h = service({
                binding: {
                    pluginId: 'p',
                    buildKind: 'github-actions',
                    imageRepository: IMAGE,
                    isCommitReachable,
                },
            });
            const named = await h.svc.requestRebuild(WORK_ID, USER_ID, {
                commitSha: 'c'.repeat(40),
            });
            expect(named.ok).toBe(true);

            isCommitReachable.mockClear();
            const head = await h.svc.requestRebuild(WORK_ID, USER_ID);
            expect(head.ok).toBe(true);
            expect(isCommitReachable).not.toHaveBeenCalled();
        });
    });

    describe('reconfirmUnconfirmedDigests (§4.12, §7.4)', () => {
        it('re-checks only the digestUnconfirmed succeeded Builds', async () => {
            const h = service({
                rows: [
                    { id: 'b1', notDeployableReason: 'digestUnconfirmed' },
                    { id: 'b2', notDeployableReason: null, deployable: true },
                    { id: 'b3', notDeployableReason: 'digestUnconfirmed' },
                ],
            });
            const reconfirm = jest
                .spyOn(h.svc, 'reconfirmDigest')
                .mockResolvedValueOnce({ reconfirmed: true } as never)
                .mockRejectedValueOnce(new Error('registry down'));

            await expect(h.svc.reconfirmUnconfirmedDigests(WORK_ID)).resolves.toEqual({
                checked: 2,
                reconfirmed: 1,
                failed: 1,
            });
            expect(reconfirm.mock.calls.map((call) => call[0])).toEqual(['b1', 'b3']);
            expect(h.builds.findPage).toHaveBeenCalledWith(
                WORK_ID,
                { status: ['succeeded'] },
                1,
                20,
            );
        });

        it('reads a private image WITH the saved pull token', async () => {
            const checkImageAccess = jest.fn(async () => ({
                visibility: 'private',
                readable: true,
                digest: DIGEST,
            }));
            const h = service({
                binding: {
                    pluginId: 'p',
                    buildKind: 'github-actions',
                    imageRepository: IMAGE,
                    settings: { pullToken: 'ghp_pull' },
                    checkImageAccess,
                },
                rowById: {
                    id: 'b1',
                    workId: WORK_ID,
                    status: 'succeeded',
                    trigger: 'push',
                    commitSha: SHA,
                    imageDigest: DIGEST,
                    imageRepository: IMAGE,
                    digestConfirmed: false,
                    notDeployableReason: 'digestUnconfirmed',
                },
            });
            await h.svc.reconfirmDigest('b1').catch(() => undefined);
            expect(checkImageAccess).toHaveBeenCalledWith({
                imageRepository: IMAGE,
                tag: `sha-${SHA}`,
                pullToken: 'ghp_pull',
            });
        });
    });

    describe('removeOrphanedVerifySecret (§7.4)', () => {
        it('deletes the secret through the binding and clears the record', async () => {
            const deleteVerifyPromptedSecret = jest.fn(async () => ({ deleted: true }));
            const row = {
                id: 'v1',
                workId: WORK_ID,
                trigger: 'verification',
                status: 'succeeded',
                verifySecretNames: ['EW_VERIFY__PROMPTED'],
            };
            const h = service({
                binding: {
                    pluginId: 'p',
                    buildKind: 'github-actions',
                    imageRepository: IMAGE,
                    deleteVerifyPromptedSecret,
                },
                rowById: row as Partial<WorkBuild>,
            });
            await expect(h.svc.removeOrphanedVerifySecret('v1')).resolves.toBe(true);
            expect(deleteVerifyPromptedSecret).toHaveBeenCalledTimes(1);
            expect(h.rows.save).toHaveBeenCalledWith(
                expect.objectContaining({ verifySecretNames: [] }),
            );
        });

        it('leaves the shared secret to a newer open verification Build, clearing only this record', async () => {
            const deleteVerifyPromptedSecret = jest.fn(async () => ({ deleted: true }));
            const h = service({
                binding: {
                    pluginId: 'p',
                    buildKind: 'github-actions',
                    imageRepository: IMAGE,
                    deleteVerifyPromptedSecret,
                },
                rowById: {
                    id: 'v1',
                    workId: WORK_ID,
                    trigger: 'verification',
                    status: 'failed',
                    verifySecretNames: ['EW_VERIFY__PROMPTED'],
                } as Partial<WorkBuild>,
                rows: [{ id: 'v2', trigger: 'verification', status: 'running' }],
            });
            await expect(h.svc.removeOrphanedVerifySecret('v1')).resolves.toBe(false);
            expect(deleteVerifyPromptedSecret).not.toHaveBeenCalled();
            expect(h.rows.save).toHaveBeenCalledWith(
                expect.objectContaining({ verifySecretNames: [] }),
            );
        });

        it('never deletes under a Build that is still running', async () => {
            const deleteVerifyPromptedSecret = jest.fn(async () => ({ deleted: true }));
            const h = service({
                binding: {
                    pluginId: 'p',
                    buildKind: 'github-actions',
                    imageRepository: IMAGE,
                    deleteVerifyPromptedSecret,
                },
                rowById: {
                    id: 'v1',
                    workId: WORK_ID,
                    trigger: 'verification',
                    status: 'running',
                    verifySecretNames: ['EW_VERIFY__PROMPTED'],
                } as Partial<WorkBuild>,
            });
            await expect(h.svc.removeOrphanedVerifySecret('v1')).resolves.toBe(false);
            expect(deleteVerifyPromptedSecret).not.toHaveBeenCalled();
        });

        it('does nothing for a non-verification Build, an empty record, or a binding without the member', async () => {
            const push = service({
                rowById: { id: 'p1', workId: WORK_ID, trigger: 'push', verifySecretNames: ['X'] },
            });
            await expect(push.svc.removeOrphanedVerifySecret('p1')).resolves.toBe(false);

            const empty = service({
                rowById: {
                    id: 'v1',
                    workId: WORK_ID,
                    trigger: 'verification',
                    verifySecretNames: [],
                },
            });
            await expect(empty.svc.removeOrphanedVerifySecret('v1')).resolves.toBe(false);

            const bare = service({
                rowById: {
                    id: 'v1',
                    workId: WORK_ID,
                    trigger: 'verification',
                    status: 'succeeded',
                    verifySecretNames: ['EW_VERIFY__PROMPTED'],
                },
            });
            await expect(bare.svc.removeOrphanedVerifySecret('v1')).resolves.toBe(false);
            expect(bare.rows.save).not.toHaveBeenCalled();
        });
    });
});
