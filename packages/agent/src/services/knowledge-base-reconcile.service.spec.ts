import { Test, TestingModule } from '@nestjs/testing';
import {
    KB_RECONCILE_POSTHOG_CLIENT,
    KnowledgeBaseReconcileService,
} from './knowledge-base-reconcile.service';
import { KB_STORAGE_PLUGIN } from './knowledge-base.service';
import { WorkKnowledgeUploadRepository } from '../database/repositories/work-knowledge-upload.repository';
import { KbUploadExtractionStatus } from '../entities/kb-types';
import type { WorkKnowledgeUpload } from '../entities/work-knowledge-upload.entity';

/**
 * EW-643 Phase 3 slice 4a — unit tests for the daily KB reconcile sweep.
 *
 * The service mixes one read+update path (DB-only: stale extractions)
 * with one read-only side-channel (storage listing for orphan objects).
 * Both flow through the same `reconcile()` entry point so the tests
 * exercise the whole sweep end-to-end with mocks for the storage
 * plugin, the upload repository, and the optional PostHog client.
 */

const WORK_ID = '00000000-0000-0000-0000-000000000010';
const UPLOAD_ID = '00000000-0000-0000-0000-000000000011';

function buildRunningUpload(overrides: Partial<WorkKnowledgeUpload> = {}): WorkKnowledgeUpload {
    return {
        id: UPLOAD_ID,
        workId: WORK_ID,
        storageProvider: 'local-fs',
        storagePath: 'kb-originals/freeform/abc.mp4',
        originalFilename: 'sample.mp4',
        mimeType: 'video/mp4',
        fileSize: 2048,
        sha256: 'b'.repeat(64),
        extractionStatus: KbUploadExtractionStatus.RUNNING,
        extractionStartedAt: new Date('2026-06-01T00:00:00Z'),
        tags: null,
        metadata: null,
        createdAt: new Date('2026-06-01T00:00:00Z'),
        updatedAt: new Date('2026-06-01T00:00:00Z'),
        ...overrides,
    } as WorkKnowledgeUpload;
}

describe('KnowledgeBaseReconcileService', () => {
    let service: KnowledgeBaseReconcileService;
    let uploadRepo: jest.Mocked<
        Pick<WorkKnowledgeUploadRepository, 'findStaleRunning' | 'listStoragePaths' | 'update'>
    >;
    let storage: {
        providerName: string;
        listObjects: jest.Mock;
        getObject: jest.Mock;
        putObject: jest.Mock;
        deleteObject: jest.Mock;
        isAvailable: jest.Mock;
    };
    let posthog: { capture: jest.Mock };

    beforeEach(async () => {
        uploadRepo = {
            findStaleRunning: jest.fn().mockResolvedValue([]),
            listStoragePaths: jest.fn().mockResolvedValue([]),
            update: jest.fn().mockResolvedValue(null),
        };
        storage = {
            providerName: 'local-fs',
            listObjects: jest.fn().mockResolvedValue([]),
            getObject: jest.fn(),
            putObject: jest.fn(),
            deleteObject: jest.fn(),
            isAvailable: jest.fn().mockResolvedValue(true),
        };
        posthog = { capture: jest.fn() };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                KnowledgeBaseReconcileService,
                { provide: WorkKnowledgeUploadRepository, useValue: uploadRepo },
                { provide: KB_STORAGE_PLUGIN, useValue: storage },
                { provide: KB_RECONCILE_POSTHOG_CLIENT, useValue: posthog },
            ],
        }).compile();

        service = module.get(KnowledgeBaseReconcileService);
    });

    it('reports zeros when there are no stale uploads and no storage objects', async () => {
        const result = await service.reconcile();

        expect(result).toEqual({ orphanedObjects: 0, staleUploads: 0 });
        expect(uploadRepo.findStaleRunning).toHaveBeenCalledTimes(1);
        expect(uploadRepo.update).not.toHaveBeenCalled();
        expect(storage.listObjects).toHaveBeenCalledWith('kb-originals/');
        // Telemetry still fires on clean ticks — operators rely on a
        // steady stream of completed events for cron-liveness alerting.
        expect(posthog.capture).toHaveBeenCalledTimes(1);
        const payload = posthog.capture.mock.calls[0][0];
        expect(payload.event).toBe('kb.reconcile.completed');
        expect(payload.properties.driftCount).toBe(0);
        expect(payload.properties.orphanCount).toBe(0);
    });

    it('marks stuck running uploads as failed with the reconcile reason', async () => {
        uploadRepo.findStaleRunning.mockResolvedValue([buildRunningUpload()]);

        const result = await service.reconcile({ workId: WORK_ID });

        expect(result.staleUploads).toBe(1);
        expect(uploadRepo.update).toHaveBeenCalledTimes(1);
        const [uploadId, patch] = uploadRepo.update.mock.calls[0];
        expect(uploadId).toBe(UPLOAD_ID);
        expect(patch.extractionStatus).toBe(KbUploadExtractionStatus.FAILED);
        expect(patch.extractionError).toBe('reconcile: stale extraction');
        expect(patch.extractionFinishedAt).toBeInstanceOf(Date);
        // The repo lookup was scoped to the requested workId so an
        // ad-hoc operator-run can't accidentally flip every Work.
        expect(uploadRepo.findStaleRunning).toHaveBeenCalledWith(
            expect.objectContaining({ workId: WORK_ID }),
        );
    });

    it('logs orphan storage objects without deleting them', async () => {
        storage.listObjects.mockResolvedValue([
            { key: 'kb-originals/freeform/known.mp4' },
            { key: 'kb-originals/freeform/orphan.mp4' },
            { key: 'kb-originals/normalized/known-derivative.mp3' },
        ]);
        uploadRepo.listStoragePaths.mockResolvedValue([
            {
                id: UPLOAD_ID,
                workId: WORK_ID,
                storagePath: 'kb-originals/freeform/known.mp4',
                normalizedStoragePath: 'kb-originals/normalized/known-derivative.mp3',
            },
        ]);
        const warnSpy = jest
            .spyOn(service['logger'], 'warn')
            .mockImplementation(() => undefined);

        const result = await service.reconcile();

        expect(result.orphanedObjects).toBe(1);
        // Critical: orphans are NEVER deleted in slice 4a — an operator
        // investigates first. Any call to `deleteObject` is a regression.
        expect(storage.deleteObject).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('kb-originals/freeform/orphan.mp4'),
        );

        const payload = posthog.capture.mock.calls[0][0];
        expect(payload.properties.orphanCount).toBe(1);
        // Body-shaped keys are stripped by the kb-events privacy guard
        // when the helper is used; this service calls capture() directly
        // so it asserts on the payload shape by white-listing known
        // numeric / identifier keys.
        for (const key of Object.keys(payload.properties)) {
            expect(key).not.toMatch(/body|content|snippet|chunk|raw|preview/i);
        }
    });
});
