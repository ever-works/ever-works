import {
    AppWorkDeletionCompletionRefusedError,
    AppWorkDeletionCompletionService,
} from '../app-work-deletion-completion.service';
import { AppRuntimeDeletionService } from '../app-runtime-deletion.service';

/**
 * Lane aw-safety (2026-10-26) — the API's guarded `APP_WORK_DELETION_COMPLETION`, reached from the
 * isolated worker through `AppRuntimeDeletionService.finishDeletion`. It ends in a row delete, so
 * every refusal is asserted with the delete NOT happening.
 */

type Row = { deletionRequestedAt?: Date | null; deletionRequestedByUserId?: string | null } | null;

function harness(
    options: {
        work?: { id: string; kind: string; userId: string; name?: string; slug?: string } | null;
        row?: Row;
        rowThrows?: boolean;
        lifecycleMissing?: boolean;
        lifecycleThrows?: boolean;
        notifyThrows?: boolean;
    } = {},
) {
    const deleted: string[] = [];
    const notifications: Array<Record<string, unknown>> = [];
    const lifecycle = {
        completeAppWorkDeletion: jest.fn(async (workId: string) => {
            deleted.push(workId);
            return true;
        }),
    };
    const works = {
        findById: jest.fn(async (id: string) =>
            options.work === null
                ? null
                : {
                      id,
                      kind: 'app',
                      userId: 'owner-1',
                      name: 'Hello',
                      slug: 'hello',
                      ...(options.work ?? {}),
                  },
        ),
    };
    const states = {
        getOrCreate: jest.fn(async () => {
            if (options.rowThrows) throw new Error('db down');
            return options.row === undefined
                ? {
                      deletionRequestedAt: new Date('2026-10-26T21:00:00Z'),
                      deletionRequestedByUserId: 'owner-1',
                  }
                : options.row;
        }),
    };
    const notifier = {
        create: jest.fn(async (dto: Record<string, unknown>) => {
            if (options.notifyThrows) throw new Error('notifications down');
            notifications.push(dto);
            return dto;
        }),
    };
    const service = new AppWorkDeletionCompletionService(works, states, notifier as never, () => {
        if (options.lifecycleThrows) throw new Error('UnknownElementException');
        return options.lifecycleMissing ? undefined : lifecycle;
    });
    return { service, deleted, notifications, lifecycle };
}

describe('AppWorkDeletionCompletionService — the guarded completion (lane aw-safety)', () => {
    it('deletes the row only for an App Work whose runtime state records the deletion', async () => {
        const h = harness();

        await expect(h.service.completeAppWorkDeletion('work-1')).resolves.toBe(true);

        expect(h.deleted).toEqual(['work-1']);
    });

    it('refuses a Work whose row records NO deletion — the hop cannot delete a Work nobody asked to delete', async () => {
        const h = harness({ row: { deletionRequestedAt: null } });

        await expect(h.service.completeAppWorkDeletion('work-1')).rejects.toMatchObject({
            code: 'not_deleting',
        });
        expect(h.deleted).toEqual([]);
        expect(h.notifications).toEqual([]);
    });

    it('refuses when the runtime state cannot be read — never read as a claim', async () => {
        const h = harness({ rowThrows: true });

        await expect(h.service.completeAppWorkDeletion('work-1')).rejects.toBeInstanceOf(
            AppWorkDeletionCompletionRefusedError,
        );
        expect(h.deleted).toEqual([]);
    });

    it('refuses any kind but app', async () => {
        const h = harness({ work: { id: 'work-1', kind: 'directory', userId: 'owner-1' } });

        await expect(h.service.completeAppWorkDeletion('work-1')).rejects.toMatchObject({
            code: 'not_an_app_work',
        });
        expect(h.deleted).toEqual([]);
    });

    it('is a no-op for a Work that is already gone (a replayed hop)', async () => {
        const h = harness({ work: null });

        await expect(h.service.completeAppWorkDeletion('work-1')).resolves.toBe(false);
        expect(h.deleted).toEqual([]);
    });

    it.each([
        ['absent', { lifecycleMissing: true }],
        ['not resolvable', { lifecycleThrows: true }],
    ])('refuses when APW-01 is %s — deletes nothing and tells nobody', async (_label, options) => {
        const h = harness(options);

        await expect(h.service.completeAppWorkDeletion('work-1')).rejects.toMatchObject({
            code: 'lifecycle_unavailable',
        });
        expect(h.notifications).toEqual([]);
    });

    it('tells the owner what may remain and where — before the row goes (FR-40a)', async () => {
        const h = harness();

        await h.service.completeAppWorkDeletion('work-1', {
            target: 'your-cluster',
            code: 'attempts_exhausted',
            mayRemain: [
                { kind: 'Namespace', name: 'ew-hello-1a2b' },
                { kind: 'Component', name: 'web' },
            ],
        });

        expect(h.notifications).toHaveLength(1);
        const note = h.notifications[0];
        expect(note).toMatchObject({
            userId: 'owner-1',
            type: 'warning',
            isPersistent: true,
            deduplicationKey: 'app-work-deleted:work-1',
        });
        expect(String(note.message)).toContain('your cluster');
        expect(String(note.message)).toContain('Namespace ew-hello-1a2b');
        expect(h.deleted).toEqual(['work-1']);
    });

    it('sends a plain success note when nothing remains, and a notification failure never blocks the delete', async () => {
        const ok = harness();
        await ok.service.completeAppWorkDeletion('work-1', {
            target: 'ever-works-apps',
            mayRemain: [],
        });
        expect(ok.notifications[0]).toMatchObject({ type: 'success', isPersistent: false });

        const broken = harness({ notifyThrows: true });
        await expect(broken.service.completeAppWorkDeletion('work-1')).resolves.toBe(true);
        expect(broken.deleted).toEqual(['work-1']);
    });

    it('turns a refusal into completed: false through the deletion service (the API end of the hop)', async () => {
        const h = harness({ row: { deletionRequestedAt: null } });
        const deletion = new AppRuntimeDeletionService(
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            h.service,
        );

        await expect(deletion.finishDeletion('work-1', { mayRemain: [] })).resolves.toEqual({
            completed: false,
            reason: 'completion_unavailable',
        });
        expect(h.deleted).toEqual([]);
    });
});
