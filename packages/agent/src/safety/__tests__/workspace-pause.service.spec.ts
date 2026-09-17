import { WORKSPACE_PAUSE_REASON_MAX } from '@ever-works/contracts';
import type { WorkspacePause } from '../../entities/workspace-pause.entity';
import type { WorkspacePauseRepository } from '../workspace-pause.repository';
import { WorkspacePauseService } from '../workspace-pause.service';

const REF = { tenantId: 'tenant-1', organizationId: 'org-1' };

function pauseRow(partial: Partial<WorkspacePause> = {}): WorkspacePause {
    return {
        id: 'p1',
        userId: 'user-1',
        tenantId: 'tenant-1',
        organizationId: 'org-1',
        reason: 'chasing a bad instruction',
        pausedByUserId: 'user-1',
        pausedAt: new Date('2026-09-16T10:00:00.000Z'),
        refusedStarts: 137,
        cleanlyStopped: 11,
        createdAt: new Date('2026-09-16T10:00:00.000Z'),
        updatedAt: new Date('2026-09-16T10:00:00.000Z'),
        ...partial,
    } as WorkspacePause;
}

function makeService(overrides: Partial<WorkspacePauseRepository> = {}) {
    const repository = {
        find: jest.fn().mockResolvedValue(null),
        pause: jest.fn().mockResolvedValue(pauseRow()),
        resume: jest.fn().mockResolvedValue(true),
        countRefusedStart: jest.fn().mockResolvedValue(undefined),
        countCleanlyStopped: jest.fn().mockResolvedValue(undefined),
        ...overrides,
    } as unknown as WorkspacePauseRepository;
    return { service: new WorkspacePauseService(repository), repository };
}

describe('WorkspacePauseService.state', () => {
    it('reports a workspace with no row as running', async () => {
        const { service } = makeService();
        expect(await service.state(REF)).toMatchObject({ paused: false, unverified: false });
    });

    it('reports the row, its actor and its counters', async () => {
        const { service } = makeService({ find: jest.fn().mockResolvedValue(pauseRow()) } as never);
        expect(await service.state(REF)).toEqual({
            paused: true,
            unverified: false,
            reason: 'chasing a bad instruction',
            pausedByUserId: 'user-1',
            pausedAt: '2026-09-16T10:00:00.000Z',
            refusedStarts: 137,
            cleanlyStopped: 11,
        });
    });

    it('FAILS CLOSED on a read error, and never throws', async () => {
        // A stop that permits whenever it cannot read itself is not a stop —
        // exactly the posture `FleetKillSwitchService.state()` documents.
        const { service } = makeService({
            find: jest.fn().mockRejectedValue(new Error('database down')),
        } as never);
        const state = await service.state(REF);
        expect(state.paused).toBe(true);
        expect(state.unverified).toBe(true);
    });

    it('treats an account with no tenant as running, not as unreadable', async () => {
        // The pre-tenant path is an absence, not a failure. Refusing here
        // would stop every action for every account not yet upgraded.
        const { service } = makeService();
        expect(await service.state(null)).toMatchObject({ paused: false, unverified: false });
        expect(await service.state({ tenantId: '' })).toMatchObject({ paused: false });
    });
});

describe('WorkspacePauseService.pause', () => {
    it('reports changed on the first pause', async () => {
        const { service, repository } = makeService({
            find: jest.fn().mockResolvedValueOnce(null).mockResolvedValue(pauseRow()),
        } as never);
        const result = await service.pause(REF, 'user-1', 'user-1', 'chasing a bad instruction');
        expect(result.changed).toBe(true);
        expect(result.state.paused).toBe(true);
        expect(repository.pause).toHaveBeenCalledWith(
            expect.objectContaining({
                pausedByUserId: 'user-1',
                reason: 'chasing a bad instruction',
            }),
        );
    });

    it('is idempotent: pausing again refreshes the reason and reports unchanged', async () => {
        const { service } = makeService({ find: jest.fn().mockResolvedValue(pauseRow()) } as never);
        const result = await service.pause(REF, 'user-2', 'user-1', 'still chasing it');
        expect(result.changed).toBe(false);
    });

    it('trims a reason and caps it at the published limit', async () => {
        const { service, repository } = makeService({
            find: jest.fn().mockResolvedValueOnce(null).mockResolvedValue(pauseRow()),
        } as never);
        await service.pause(REF, 'user-1', 'user-1', `  ${'x'.repeat(600)}  `);
        const written = (repository.pause as jest.Mock).mock.calls[0][0];
        expect(written.reason).toHaveLength(WORKSPACE_PAUSE_REASON_MAX);
    });

    it('treats a blank reason as no reason', async () => {
        const { service, repository } = makeService({
            find: jest.fn().mockResolvedValueOnce(null).mockResolvedValue(pauseRow()),
        } as never);
        await service.pause(REF, 'user-1', 'user-1', '   ');
        expect((repository.pause as jest.Mock).mock.calls[0][0].reason).toBeNull();
    });

    it('counts a pause that could not be read before as a change', async () => {
        const { service } = makeService({
            find: jest.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue(pauseRow()),
        } as never);
        expect((await service.pause(REF, 'user-1', 'user-1')).changed).toBe(true);
    });
});

describe('WorkspacePauseService.resume', () => {
    it('reports changed when a row was removed', async () => {
        const { service } = makeService();
        const result = await service.resume(REF, 'user-1');
        expect(result.changed).toBe(true);
        expect(result.state.paused).toBe(false);
    });

    it('is idempotent when nothing was paused', async () => {
        const { service } = makeService({ resume: jest.fn().mockResolvedValue(false) } as never);
        expect((await service.resume(REF, 'user-1')).changed).toBe(false);
    });
});

describe('WorkspacePauseService.countRefusedStart', () => {
    it('never throws when the counter cannot be written', async () => {
        // The banner's number is bookkeeping; a failed increment must never be
        // the reason a refusal did not land.
        const { service } = makeService({
            countRefusedStart: jest.fn().mockRejectedValue(new Error('nope')),
        } as never);
        await expect(service.countRefusedStart(REF)).resolves.toBeUndefined();
    });
});
