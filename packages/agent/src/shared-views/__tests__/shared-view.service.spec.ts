import { ActivityActionType, ActivityStatus } from '../../entities/activity-log.types';
import { SharedView, sharedViewDefaults } from '../../entities/shared-view.entity';
import {
    SharedViewConflictError,
    SharedViewInvalidSettingsError,
    SharedViewMissingError,
    SharedViewService,
    normalizeKnowledgeClasses,
    type SharedViewActor,
} from '../shared-view.service';
import { generateShareToken, hashShareToken } from '../shared-view-token';

const ACTOR: SharedViewActor = {
    organizationId: 'org-1',
    tenantId: 'tenant-1',
    ownerUserId: 'owner-1',
};

/** An in-memory stand-in for SharedViewRepository with the same CAS semantics. */
function makeRepository() {
    const rows = new Map<string, SharedView>();
    let nextId = 1;
    const byOrg = (organizationId: string) =>
        [...rows.values()].find((row) => row.organizationId === organizationId) ?? null;
    const clone = (row: SharedView | null) =>
        row ? Object.assign(new SharedView(), JSON.parse(JSON.stringify(row))) : null;

    const repository = {
        rows,
        findByOrganization: jest.fn(async (organizationId: string) => clone(byOrg(organizationId))),
        findById: jest.fn(async (id: string) => clone(rows.get(id) ?? null)),
        findByTokenHash: jest.fn(async (tokenHash: string) =>
            clone([...rows.values()].find((row) => row.tokenHash === tokenHash) ?? null),
        ),
        createForOrganization: jest.fn(async (input: any) => {
            if (byOrg(input.organizationId)) throw new Error('UNIQUE constraint failed');
            const defaults = sharedViewDefaults();
            const row = Object.assign(new SharedView(), {
                id: `view-${nextId++}`,
                organizationId: input.organizationId,
                tenantId: input.tenantId,
                ownerUserId: input.ownerUserId,
                createdById: input.createdById,
                tokenHash: input.tokenHash,
                tokenEncrypted: { token: input.token },
                ...defaults,
                lastViewedAt: null,
                firstViewNotifiedAt: null,
                tokenRotatedAt: null,
            });
            rows.set(row.id, row);
            return clone(row);
        }),
        rotateToken: jest.fn(async (id: string, seen: number, next: any) => {
            const row = rows.get(id);
            if (!row || row.rotationCount !== seen) return false;
            row.tokenHash = next.tokenHash;
            row.tokenEncrypted = { token: next.token };
            row.rotationCount = seen + 1;
            row.tokenRotatedAt = next.now;
            row.firstViewNotifiedAt = null;
            return true;
        }),
        updateSettings: jest.fn(async (id: string, patch: any) => {
            const row = rows.get(id);
            if (row) Object.assign(row, patch);
        }),
        applyViewDelta: jest.fn(async (id: string, delta: number, at: Date) => {
            const row = rows.get(id);
            if (row) {
                row.viewCount += delta;
                row.lastViewedAt = at;
            }
        }),
        claimFirstViewNotification: jest.fn(
            async (id: string, rotationCount: number, now: Date) => {
                const row = rows.get(id);
                if (!row || row.firstViewNotifiedAt || row.rotationCount !== rotationCount)
                    return false;
                row.firstViewNotifiedAt = now;
                return true;
            },
        ),
        deleteForOrganization: jest.fn(async (organizationId: string) => {
            const row = byOrg(organizationId);
            if (!row) return false;
            rows.delete(row.id);
            return true;
        }),
    };
    return repository;
}

function makeService() {
    const repository = makeRepository();
    const activityLog = { log: jest.fn().mockResolvedValue({}) };
    const notifications = { notifySharedViewFirstView: jest.fn().mockResolvedValue(undefined) };
    const service = new SharedViewService(
        repository as any,
        activityLog as any,
        notifications as any,
    );
    return { service, repository, activityLog, notifications };
}

function loggedTypes(activityLog: { log: jest.Mock }): string[] {
    return activityLog.log.mock.calls.map(([entry]) => entry.actionType);
}

describe('SharedViewService', () => {
    describe('enable', () => {
        it('creates the Workspace view with the board on, knowledge off and crawlers blocked', async () => {
            const { service, activityLog } = makeService();
            const { view, created } = await service.enable(ACTOR);

            expect(created).toBe(true);
            expect(view.status).toBe('active');
            expect(view.sections).toEqual({ board: true, knowledge: false });
            expect(view.knowledgeClasses).toEqual([]);
            expect(view.searchIndexable).toBe(false);
            expect(view.ownerUserId).toBe('owner-1');
            expect(view.tokenHash).toBe(hashShareToken(service.readToken(view)!));
            expect(loggedTypes(activityLog)).toEqual([ActivityActionType.SHARED_VIEW_ENABLED]);
        });

        it('is idempotent — turning sharing on again returns the same link and logs nothing', async () => {
            const { service, activityLog } = makeService();
            const first = await service.enable(ACTOR);
            const second = await service.enable(ACTOR);

            expect(second.created).toBe(false);
            expect(second.view.id).toBe(first.view.id);
            expect(service.readToken(second.view)).toBe(service.readToken(first.view));
            expect(activityLog.log).toHaveBeenCalledTimes(1);
        });

        it('returns the row another request created first instead of a second link', async () => {
            const { service, repository } = makeService();
            await service.enable(ACTOR);
            repository.findByOrganization.mockResolvedValueOnce(null);

            const raced = await service.enable(ACTOR);
            expect(raced.created).toBe(false);
            expect(repository.rows.size).toBe(1);
        });

        it('re-activates a paused view with its SAME token', async () => {
            const { service, activityLog } = makeService();
            const { view } = await service.enable(ACTOR);
            const token = service.readToken(view);
            await service.disable(ACTOR);

            const resumed = await service.enable(ACTOR);
            expect(resumed.view.status).toBe('active');
            expect(service.readToken(resumed.view)).toBe(token);
            expect(loggedTypes(activityLog)).toEqual([
                ActivityActionType.SHARED_VIEW_ENABLED,
                ActivityActionType.SHARED_VIEW_DISABLED,
                ActivityActionType.SHARED_VIEW_ENABLED,
            ]);
        });
    });

    describe('disable', () => {
        it('pauses the view but keeps the token', async () => {
            const { service } = makeService();
            const { view } = await service.enable(ACTOR);
            const paused = await service.disable(ACTOR);

            expect(paused.status).toBe('paused');
            expect(paused.tokenHash).toBe(view.tokenHash);
            expect(await service.resolveByToken(service.readToken(view))).toBeNull();
        });

        it('refuses a Workspace that never turned sharing on', async () => {
            const { service } = makeService();
            await expect(service.disable(ACTOR)).rejects.toBeInstanceOf(SharedViewMissingError);
        });
    });

    describe('regenerate', () => {
        it('replaces the token, bumps the rotation count and kills the old link', async () => {
            const { service, activityLog } = makeService();
            const { view } = await service.enable(ACTOR);
            const oldToken = service.readToken(view)!;

            const next = await service.regenerate(ACTOR, view.rotationCount);
            const newToken = service.readToken(next)!;

            expect(newToken).not.toBe(oldToken);
            expect(next.rotationCount).toBe(1);
            expect(next.tokenRotatedAt).toBeTruthy();
            expect(next.firstViewNotifiedAt).toBeNull();
            expect(await service.resolveByToken(oldToken)).toBeNull();
            expect((await service.resolveByToken(newToken))?.id).toBe(view.id);
            expect(loggedTypes(activityLog)).toContain(ActivityActionType.SHARED_VIEW_REGENERATED);
        });

        it('lets exactly one of two tabs that saw the same link win', async () => {
            const { service } = makeService();
            const { view } = await service.enable(ACTOR);

            await service.regenerate(ACTOR, view.rotationCount);
            await expect(service.regenerate(ACTOR, view.rotationCount)).rejects.toBeInstanceOf(
                SharedViewConflictError,
            );
            expect((await service.getForOrganization('org-1'))?.rotationCount).toBe(1);
        });

        it('raises the conflict when the compare-and-set loses between read and write', async () => {
            const { service, repository } = makeService();
            await service.enable(ACTOR);
            repository.rotateToken.mockResolvedValueOnce(false);
            await expect(service.regenerate(ACTOR)).rejects.toBeInstanceOf(SharedViewConflictError);
        });
    });

    describe('updateSettings', () => {
        it('writes exactly one activity row per changed facet', async () => {
            const { service, activityLog } = makeService();
            await service.enable(ACTOR);
            activityLog.log.mockClear();

            await service.updateSettings(ACTOR, {
                status: 'paused',
                sections: { board: false },
                knowledgeClasses: ['glossary'],
                searchIndexable: true,
            });

            expect(loggedTypes(activityLog)).toEqual([
                ActivityActionType.SHARED_VIEW_DISABLED,
                ActivityActionType.SHARED_VIEW_SECTIONS_CHANGED,
                ActivityActionType.SHARED_VIEW_SECTIONS_CHANGED,
                ActivityActionType.SHARED_VIEW_INDEXING_CHANGED,
            ]);
            for (const [entry] of activityLog.log.mock.calls) {
                expect(entry.status).toBe(ActivityStatus.COMPLETED);
                expect(entry.userId).toBe('owner-1');
                expect(entry.tenantId).toBe('tenant-1');
                expect(entry.organizationId).toBe('org-1');
            }
        });

        it('writes nothing for a facet that did not change', async () => {
            const { service, activityLog } = makeService();
            await service.enable(ACTOR);
            activityLog.log.mockClear();

            await service.updateSettings(ACTOR, {
                status: 'active',
                sections: { board: true },
                knowledgeClasses: [],
                searchIndexable: false,
            });
            expect(activityLog.log).not.toHaveBeenCalled();
        });

        it('never puts the token in any activity row', async () => {
            const { service, activityLog } = makeService();
            const { view } = await service.enable(ACTOR);
            const first = service.readToken(view)!;
            const regenerated = await service.regenerate(ACTOR);
            const second = service.readToken(regenerated)!;
            await service.updateSettings(ACTOR, { searchIndexable: true, status: 'paused' });
            await service.deleteForOrganization(ACTOR);

            const serialised = JSON.stringify(activityLog.log.mock.calls);
            expect(serialised).not.toContain(first);
            expect(serialised).not.toContain(second);
            expect(serialised).not.toContain(view.tokenHash);
        });

        it('refuses to turn the knowledge section on before it ships', async () => {
            const { service } = makeService();
            await service.enable(ACTOR);
            await expect(
                service.updateSettings(ACTOR, { sections: { knowledge: true } }),
            ).rejects.toMatchObject({ reason: 'knowledge_section_unavailable' });
        });

        it('refuses an unknown knowledge class rather than keeping it', async () => {
            const { service } = makeService();
            await service.enable(ACTOR);
            await expect(
                service.updateSettings(ACTOR, { knowledgeClasses: ['everything'] }),
            ).rejects.toBeInstanceOf(SharedViewInvalidSettingsError);
        });

        it('keeps the change even when the activity log is unavailable', async () => {
            const { service, activityLog } = makeService();
            await service.enable(ACTOR);
            activityLog.log.mockRejectedValue(new Error('activity store down'));
            const updated = await service.updateSettings(ACTOR, { searchIndexable: true });
            expect(updated.searchIndexable).toBe(true);
        });
    });

    describe('deleteForOrganization', () => {
        it('deletes the view so its link never resolves again', async () => {
            const { service } = makeService();
            const { view } = await service.enable(ACTOR);
            await service.deleteForOrganization(ACTOR);
            expect(await service.resolveByToken(service.readToken(view))).toBeNull();
            await expect(service.deleteForOrganization(ACTOR)).rejects.toBeInstanceOf(
                SharedViewMissingError,
            );
        });
    });

    describe('resolveByToken', () => {
        it('answers the same null for junk, unknown, regenerated-away and paused tokens', async () => {
            const { service, repository } = makeService();
            const { view } = await service.enable(ACTOR);
            const live = service.readToken(view)!;
            expect((await service.resolveByToken(live))?.id).toBe(view.id);

            repository.findByTokenHash.mockClear();
            expect(await service.resolveByToken('not-a-token')).toBeNull();
            expect(await service.resolveByToken({})).toBeNull();
            expect(repository.findByTokenHash).not.toHaveBeenCalled();

            expect(await service.resolveByToken(generateShareToken())).toBeNull();
            await service.regenerate(ACTOR);
            expect(await service.resolveByToken(live)).toBeNull();
        });
    });

    describe('readToken', () => {
        it('answers null when the stored token cannot be read', () => {
            const { service } = makeService();
            const row = Object.assign(new SharedView(), {
                tokenEncrypted: { token: 'enc::v1::garbled' },
            });
            expect(service.readToken(row)).toBeNull();
        });
    });

    describe('recordView', () => {
        it('counts the view and notifies the owner for the first view only', async () => {
            const { service, repository, notifications } = makeService();
            const { view } = await service.enable(ACTOR);

            await service.recordView(view);
            const afterFirst = (await service.getForOrganization('org-1'))!;
            await service.recordView(afterFirst);
            await service.recordView(view);

            expect(repository.rows.get(view.id)!.viewCount).toBe(3);
            expect(notifications.notifySharedViewFirstView).toHaveBeenCalledTimes(1);
            expect(notifications.notifySharedViewFirstView).toHaveBeenCalledWith({
                userId: 'owner-1',
                sharedViewId: view.id,
                rotationCount: 0,
            });
        });

        it('notifies once more for a regenerated link', async () => {
            const { service, notifications } = makeService();
            const { view } = await service.enable(ACTOR);
            await service.recordView(view);
            const regenerated = await service.regenerate(ACTOR);
            await service.recordView(regenerated);
            expect(notifications.notifySharedViewFirstView).toHaveBeenCalledTimes(2);
        });

        it('never fails the visitor when counting fails', async () => {
            const { service, repository } = makeService();
            const { view } = await service.enable(ACTOR);
            repository.applyViewDelta.mockRejectedValueOnce(new Error('db down'));
            await expect(service.recordView(view)).resolves.toBeUndefined();
        });
    });
});

describe('normalizeKnowledgeClasses', () => {
    it('trims, lower-cases, de-duplicates and sorts known classes', () => {
        expect(normalizeKnowledgeClasses([' Glossary', 'brand', 'glossary'])).toEqual([
            'brand',
            'glossary',
        ]);
    });

    it('keeps an empty selection empty — it never means everything', () => {
        expect(normalizeKnowledgeClasses([])).toEqual([]);
    });

    it.each([['everything'], [42], [null]])('refuses %p', (value) => {
        expect(() => normalizeKnowledgeClasses([value])).toThrow(SharedViewInvalidSettingsError);
    });
});
