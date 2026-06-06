import { Test, TestingModule } from '@nestjs/testing';
import {
    KnowledgeBaseTranscribeService,
    TranscriptionNotConfiguredError,
} from './knowledge-base-transcribe.service';
import { KB_STORAGE_PLUGIN, KnowledgeBaseService } from './knowledge-base.service';
import { WorkKnowledgeUploadRepository } from '../database/repositories/work-knowledge-upload.repository';
import { WorkKnowledgeDocumentRepository } from '../database/repositories/work-knowledge-document.repository';
import { AiFacadeService } from '../facades/ai.facade';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { WorkKnowledgeUpload } from '../entities/work-knowledge-upload.entity';
import { KbUploadExtractionStatus } from '../entities/kb-types';
import type { KbTranscribePayload } from '../tasks/kb-transcribe.types';

const WORK_ID = '00000000-0000-0000-0000-000000000001';
const UPLOAD_ID = '00000000-0000-0000-0000-000000000002';
const USER_ID = '00000000-0000-0000-0000-000000000003';

function buildUpload(overrides: Partial<WorkKnowledgeUpload> = {}): WorkKnowledgeUpload {
    return {
        id: UPLOAD_ID,
        workId: WORK_ID,
        storageProvider: 'local-fs',
        storagePath: 'kb-originals/freeform/abc.mp4',
        originalFilename: 'sample.mp4',
        mimeType: 'video/mp4',
        fileSize: 1024,
        sha256: 'a'.repeat(64),
        extractionStatus: 'running' as KbUploadExtractionStatus,
        uploadedById: USER_ID,
        tags: null,
        metadata: null,
        createdAt: new Date('2026-06-01T00:00:00Z'),
        updatedAt: new Date('2026-06-01T00:00:00Z'),
        ...overrides,
    } as WorkKnowledgeUpload;
}

describe('KnowledgeBaseTranscribeService', () => {
    let service: KnowledgeBaseTranscribeService;
    let uploadRepo: jest.Mocked<Pick<WorkKnowledgeUploadRepository, 'findById'>>;
    let docRepo: jest.Mocked<
        Pick<WorkKnowledgeDocumentRepository, 'findByMetadataKey' | 'updateById'>
    >;
    let kb: { createDocument: jest.Mock };
    let aiFacade: { transcribe: jest.Mock };
    let storage: { getObject: jest.Mock };
    let activityLog: { log: jest.Mock };

    const payload: KbTranscribePayload = {
        workId: WORK_ID,
        uploadId: UPLOAD_ID,
        sourceStoragePath: 'kb-originals/normalized/abcd.mp3',
        sourceMimeType: 'audio/mpeg',
        language: 'en',
    };

    beforeEach(async () => {
        uploadRepo = {
            findById: jest.fn().mockResolvedValue(buildUpload()),
        };
        docRepo = {
            findByMetadataKey: jest.fn().mockResolvedValue(null),
            updateById: jest.fn().mockResolvedValue(undefined),
        };
        kb = {
            createDocument: jest.fn().mockResolvedValue({
                id: '00000000-0000-0000-0000-000000000010',
                path: 'research/transcripts/upload-id.md',
                title: 'Transcript — sample.mp4',
            }),
        };
        aiFacade = {
            transcribe: jest.fn().mockResolvedValue({
                text: 'hello world',
                model: 'whisper-1',
                language: 'en',
                durationSeconds: 12.5,
                segments: [{ start: 0, end: 12.5, text: 'hello world' }],
            }),
        };
        storage = {
            getObject: jest.fn().mockResolvedValue({
                buffer: Buffer.from('audio-bytes'),
                mimeType: 'audio/mpeg',
            }),
        };
        activityLog = { log: jest.fn().mockResolvedValue(undefined) };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                KnowledgeBaseTranscribeService,
                { provide: WorkKnowledgeUploadRepository, useValue: uploadRepo },
                { provide: WorkKnowledgeDocumentRepository, useValue: docRepo },
                { provide: KnowledgeBaseService, useValue: kb },
                { provide: AiFacadeService, useValue: aiFacade },
                { provide: KB_STORAGE_PLUGIN, useValue: storage },
                { provide: ActivityLogService, useValue: activityLog },
            ],
        }).compile();

        service = module.get(KnowledgeBaseTranscribeService);
    });

    it('happy path: creates a document carrying metadata.transcribedFromUploadId', async () => {
        const result = await service.transcribeUpload(payload);

        expect(storage.getObject).toHaveBeenCalledWith(payload.sourceStoragePath);
        expect(aiFacade.transcribe).toHaveBeenCalledWith(
            expect.objectContaining({
                file: expect.any(Buffer),
                filename: expect.any(String),
            }),
            expect.objectContaining({
                workId: WORK_ID,
                userId: USER_ID,
            }),
        );
        expect(kb.createDocument).toHaveBeenCalledWith(
            expect.objectContaining({
                workId: WORK_ID,
                userId: USER_ID,
                body: 'hello world',
                sourceUploadId: UPLOAD_ID,
                metadata: expect.objectContaining({
                    transcribedFromUploadId: UPLOAD_ID,
                    transcriptionProviderId: 'whisper-1',
                    durationSeconds: 12.5,
                    detectedLanguage: 'en',
                    segmentCount: 1,
                }),
            }),
        );
        expect(result.documentId).toBe('00000000-0000-0000-0000-000000000010');
        expect(result.providerId).toBe('whisper-1');
    });

    it('idempotency: returns the existing document and skips createDocument when a transcript already exists', async () => {
        docRepo.findByMetadataKey.mockResolvedValue({
            id: 'existing-doc-id',
            metadata: {
                transcribedFromUploadId: UPLOAD_ID,
                transcriptionProviderId: 'whisper-1',
                durationSeconds: 8,
            },
        } as any);

        const result = await service.transcribeUpload(payload);

        expect(docRepo.findByMetadataKey).toHaveBeenCalledWith(
            WORK_ID,
            'transcribedFromUploadId',
            UPLOAD_ID,
        );
        expect(kb.createDocument).not.toHaveBeenCalled();
        expect(aiFacade.transcribe).not.toHaveBeenCalled();
        expect(storage.getObject).not.toHaveBeenCalled();
        expect(result.documentId).toBe('existing-doc-id');
    });

    it('surfaces TranscriptionNotConfiguredError from the facade', async () => {
        aiFacade.transcribe.mockRejectedValue(
            new TranscriptionNotConfiguredError(
                'No transcription-capable AI provider configured',
                'unknown',
            ),
        );

        await expect(service.transcribeUpload(payload)).rejects.toBeInstanceOf(
            TranscriptionNotConfiguredError,
        );

        expect(kb.createDocument).not.toHaveBeenCalled();
    });

    it('swallows activity-log failures so the pipeline still succeeds', async () => {
        activityLog.log.mockRejectedValue(new Error('activity-log offline'));

        await expect(service.transcribeUpload(payload)).resolves.toMatchObject({
            documentId: expect.any(String),
            providerId: 'whisper-1',
        });

        expect(kb.createDocument).toHaveBeenCalled();
    });
});
