import { Test, TestingModule } from '@nestjs/testing';
import { MemoryConsolidationService } from '../memory-consolidation.service';
import { WorkKnowledgeDocumentRepository } from '../../database/repositories/work-knowledge-document.repository';
import { OrganizationRepository } from '../../database/repositories/organization.repository';
import { KnowledgeBaseService } from '../knowledge-base.service';

const ORG_ID = '00000000-0000-0000-0000-0000000000c1';

/**
 * Scheduled Memory Consolidation — settings read/write.
 *
 * These methods are the reason the scheduled pass can run at all. The
 * tick selects organizations with `memory_consolidation IS NOT NULL`, and
 * before this nothing in the codebase ever wrote that column — the only
 * other write updates `lastRunAt` on rows that are already non-null. The
 * candidate set was therefore permanently empty and the entire feature
 * was unreachable in production.
 *
 * So the behaviours pinned here are: that a write actually persists, that
 * defaults are safe (off, and dry-run — nothing auto-persists), and that
 * a partial update cannot clobber the fields it did not mention.
 */
describe('MemoryConsolidationService — schedule settings', () => {
    let service: MemoryConsolidationService;
    let orgRepo: { findById: jest.Mock; update: jest.Mock };

    beforeEach(async () => {
        orgRepo = {
            findById: jest.fn().mockResolvedValue({ id: ORG_ID, memoryConsolidation: null }),
            update: jest.fn().mockResolvedValue(undefined),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                MemoryConsolidationService,
                { provide: WorkKnowledgeDocumentRepository, useValue: {} },
                { provide: KnowledgeBaseService, useValue: {} },
                { provide: OrganizationRepository, useValue: orgRepo },
            ],
        }).compile();

        service = module.get(MemoryConsolidationService);
    });

    it('defaults to OFF and dry-run for an organization that never configured it', async () => {
        const settings = await service.getScheduleSettings(ORG_ID);

        // Both matter: a pass that persists anything must be an explicit
        // choice, and consolidation must never start running on its own.
        expect(settings.enabled).toBe(false);
        expect(settings.mode).toBe('dry-run');
        expect(settings.cadence).toBe('weekly');
    });

    it('actually persists the settings — the write the scheduler was missing', async () => {
        await service.updateScheduleSettings(ORG_ID, { enabled: true, cadence: 'daily' });

        expect(orgRepo.update).toHaveBeenCalledTimes(1);
        const [id, patch] = orgRepo.update.mock.calls[0];
        expect(id).toBe(ORG_ID);
        // Non-null is precisely what `findWithMemoryConsolidationSettings`
        // filters on, so this write is what puts the org in scope at all.
        expect(patch.memoryConsolidation).toMatchObject({ enabled: true, cadence: 'daily' });
    });

    it('merges a partial update instead of clobbering the rest', async () => {
        orgRepo.findById.mockResolvedValue({
            id: ORG_ID,
            memoryConsolidation: {
                enabled: true,
                cadence: 'daily',
                mode: 'propose',
                notify: false,
                lastRunAt: '2026-07-01T00:00:00.000Z',
            },
        });

        const next = await service.updateScheduleSettings(ORG_ID, { cadence: 'monthly' });

        expect(next.cadence).toBe('monthly');
        expect(next.mode).toBe('propose');
        expect(next.notify).toBe(false);
        expect(next.enabled).toBe(true);
    });

    it('preserves lastRunAt so changing cadence does not re-fire the pass', async () => {
        orgRepo.findById.mockResolvedValue({
            id: ORG_ID,
            memoryConsolidation: { enabled: true, lastRunAt: '2026-07-01T00:00:00.000Z' },
        });

        const next = await service.updateScheduleSettings(ORG_ID, { cadence: 'monthly' });

        // Resetting it would make the scheduler believe the pass had never
        // run and fire immediately on the next tick.
        expect(next.lastRunAt).toBe('2026-07-01T00:00:00.000Z');
    });

    it('throws loudly when the organization repository is unavailable', async () => {
        const bare: TestingModule = await Test.createTestingModule({
            providers: [
                MemoryConsolidationService,
                { provide: WorkKnowledgeDocumentRepository, useValue: {} },
                { provide: KnowledgeBaseService, useValue: {} },
            ],
        }).compile();
        const bareService = bare.get(MemoryConsolidationService);

        // An optional-chained write would report success having stored
        // nothing — the same silent failure this whole change fixes.
        await expect(bareService.getScheduleSettings(ORG_ID)).rejects.toThrow(
            /OrganizationRepository is not available/,
        );
    });
});
