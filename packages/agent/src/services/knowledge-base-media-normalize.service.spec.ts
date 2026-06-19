import { Test, TestingModule } from '@nestjs/testing';
import { writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
// We replace `child_process.spawn` with a controllable jest.fn via
// jest.mock() rather than `jest.spyOn(childProcess, 'spawn')`. Modern
// Node defines `spawn` as a non-configurable property on the
// `node:child_process` module record, so spyOn — which calls
// Object.defineProperty under the hood — throws
// `TypeError: Cannot redefine property: spawn` on the second test in
// the suite. jest.mock() factories run before module evaluation and
// install a fresh module shape we fully own.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const spawnFn: jest.Mock = jest.fn();
jest.mock('node:child_process', () => ({
    ...jest.requireActual<typeof import('node:child_process')>('node:child_process'),
    spawn: (...args: unknown[]) => spawnFn(...args),
}));
import {
    FfmpegFailedError,
    KnowledgeBaseMediaNormalizeService,
} from './knowledge-base-media-normalize.service';
import { KB_STORAGE_PLUGIN } from './knowledge-base.service';
import { WorkKnowledgeUploadRepository } from '../database/repositories/work-knowledge-upload.repository';
import {
    KB_NORMALIZE_MEDIA_DISPATCHER,
    KB_TRANSCRIBE_DISPATCHER,
    RuntimeBindingStamperService,
    type KbNormalizeMediaPayload,
} from '../tasks';
import { WorkRepository } from '../database/repositories/work.repository';
import { WorkKnowledgeUpload } from '../entities/work-knowledge-upload.entity';
import { KbUploadExtractionStatus } from '../entities/kb-types';

/**
 * EW-643 Phase 3 slice 2c — unit tests for
 * `KnowledgeBaseMediaNormalizeService`.
 *
 * The service spawns ffmpeg and writes the normalized derivative to
 * the configured storage plugin, then dispatches the follow-up
 * `kb-transcribe` task. We stub the ffmpeg child process at the
 * `child_process.spawn` boundary so the tests can drive the
 * exit-code branches deterministically without a real ffmpeg binary.
 */

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

/**
 * Stand-in for a Trigger.dev-side `ChildProcess`. We need stdout/stderr
 * streams plus the `close` / `error` events; the service only listens to
 * `stderr.data` + `close` + `error`. EventEmitter satisfies all three.
 */
class FakeChild extends EventEmitter {
    stderr = new EventEmitter();
    stdout = new EventEmitter();
}

describe('KnowledgeBaseMediaNormalizeService', () => {
    let service: KnowledgeBaseMediaNormalizeService;
    let uploadRepo: jest.Mocked<Pick<WorkKnowledgeUploadRepository, 'findById' | 'updateById'>>;
    let storage: {
        providerName: string;
        putObject: jest.Mock;
        getObject: jest.Mock;
        deleteObject: jest.Mock;
        isAvailable: jest.Mock;
    };
    let transcribeDispatcher: { dispatchKbTranscribe: jest.Mock };
    let normalizeDispatcher: { dispatchKbNormalizeMedia: jest.Mock };

    beforeEach(async () => {
        spawnFn.mockReset();
        uploadRepo = {
            findById: jest.fn(),
            updateById: jest.fn().mockResolvedValue(undefined),
        };
        storage = {
            providerName: 'local-fs',
            putObject: jest.fn().mockResolvedValue({ key: 'kb-originals/normalized/deadbeef.mp4' }),
            getObject: jest.fn().mockResolvedValue({
                buffer: Buffer.from('original-bytes'),
                mimeType: 'video/mp4',
            }),
            deleteObject: jest.fn(),
            isAvailable: jest.fn().mockResolvedValue(true),
        };
        transcribeDispatcher = {
            dispatchKbTranscribe: jest.fn().mockResolvedValue('run_transcribe_1'),
        };
        normalizeDispatcher = {
            dispatchKbNormalizeMedia: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                KnowledgeBaseMediaNormalizeService,
                { provide: WorkKnowledgeUploadRepository, useValue: uploadRepo },
                { provide: KB_STORAGE_PLUGIN, useValue: storage },
                { provide: KB_TRANSCRIBE_DISPATCHER, useValue: transcribeDispatcher },
                { provide: KB_NORMALIZE_MEDIA_DISPATCHER, useValue: normalizeDispatcher },
            ],
        }).compile();

        service = module.get(KnowledgeBaseMediaNormalizeService);
    });

    /**
     * Wire the mocked `child_process.spawn` (installed by jest.mock at
     * the top of the file) to return a fake child that:
     *   1. writes some bytes to a tmp output path so the service's
     *      `readFile(outputPath)` call resolves with non-empty data
     *   2. emits the configured `close` exit code
     */
    function stubSpawn(exitCode: number | null = 0): void {
        spawnFn.mockImplementation((..._args: unknown[]) => {
            const child = new FakeChild();
            const argList = _args[1] as string[];
            const outputPath = argList[argList.length - 1];
            // Write a small fake output so `readFile` succeeds and
            // the sha256 + putObject pipeline runs through.
            void writeFile(outputPath, Buffer.from('normalized-bytes')).finally(() => {
                if (exitCode !== 0) {
                    child.stderr.emit('data', Buffer.from('ffmpeg exploded\n'));
                }
                // Defer close to the next tick so the listener
                // attached by the service is wired first.
                setImmediate(() => child.emit('close', exitCode));
            });
            return child;
        });
    }

    const videoPayload: KbNormalizeMediaPayload = {
        workId: WORK_ID,
        uploadId: UPLOAD_ID,
        mediaKind: 'video',
        originalSha256: 'a'.repeat(64),
        originalMimeType: 'video/mp4',
    };

    const audioPayload: KbNormalizeMediaPayload = {
        workId: WORK_ID,
        uploadId: UPLOAD_ID,
        mediaKind: 'audio',
        originalSha256: 'b'.repeat(64),
        originalMimeType: 'audio/mpeg',
    };

    it('normalizeVideo happy path: writes normalized object, updates upload metadata, dispatches transcribe', async () => {
        uploadRepo.findById.mockResolvedValue(buildUpload());
        stubSpawn(0);

        const result = await service.normalizeVideo(videoPayload);

        // Output object written to storage under the normalized prefix.
        expect(storage.putObject).toHaveBeenCalledWith(
            expect.objectContaining({
                filename: expect.stringMatching(/^kb-originals\/normalized\/[a-f0-9]{64}\./),
                mimeType: expect.stringMatching(/^video\//),
                workId: WORK_ID,
            }),
        );
        // Upload metadata stamped with originalSha256 + normalized fields.
        expect(uploadRepo.updateById).toHaveBeenCalledWith(
            WORK_ID,
            UPLOAD_ID,
            expect.objectContaining({
                metadata: expect.objectContaining({
                    originalSha256: videoPayload.originalSha256,
                    normalizedStoragePath: expect.any(String),
                    normalizedSha256: expect.any(String),
                    normalizedMimeType: expect.any(String),
                    normalizedAt: expect.any(String),
                }),
            }),
        );
        // Transcribe is dispatched with the normalized storage key.
        expect(transcribeDispatcher.dispatchKbTranscribe).toHaveBeenCalledWith(
            expect.objectContaining({
                workId: WORK_ID,
                uploadId: UPLOAD_ID,
                sourceStoragePath: expect.any(String),
                sourceMimeType: expect.any(String),
            }),
        );
        expect(result.transcribeRunId).toBe('run_transcribe_1');
        expect(result.normalizedSha256).toMatch(/^[a-f0-9]{64}$/);
    });

    it('normalizeAudio happy path: writes normalized MP3 + dispatches transcribe', async () => {
        uploadRepo.findById.mockResolvedValue(
            buildUpload({
                mimeType: 'audio/mpeg',
                originalFilename: 'voice-memo.mp3',
                storagePath: 'kb-originals/freeform/voice.mp3',
            }),
        );
        storage.getObject.mockResolvedValue({
            buffer: Buffer.from('original-audio'),
            mimeType: 'audio/mpeg',
        });
        stubSpawn(0);

        const result = await service.normalizeAudio(audioPayload);

        expect(storage.putObject).toHaveBeenCalledWith(
            expect.objectContaining({
                mimeType: expect.stringMatching(/^audio\//),
            }),
        );
        expect(transcribeDispatcher.dispatchKbTranscribe).toHaveBeenCalledTimes(1);
        expect(result.transcribeRunId).toBe('run_transcribe_1');
    });

    it('ffmpeg failure throws FfmpegFailedError carrying stage + exit code', async () => {
        uploadRepo.findById.mockResolvedValue(buildUpload());
        stubSpawn(1);

        await expect(service.normalizeVideo(videoPayload)).rejects.toBeInstanceOf(
            FfmpegFailedError,
        );

        // Storage write must NOT have happened on the failure path.
        expect(storage.putObject).not.toHaveBeenCalled();
        expect(transcribeDispatcher.dispatchKbTranscribe).not.toHaveBeenCalled();
    });

    it('rejects when the upload row is missing', async () => {
        uploadRepo.findById.mockResolvedValue(null);

        await expect(service.normalizeVideo(videoPayload)).rejects.toThrow(/upload .* not found/i);
    });

    it('returns transcribeRunId: null when the transcribe dispatcher is absent', async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                KnowledgeBaseMediaNormalizeService,
                { provide: WorkKnowledgeUploadRepository, useValue: uploadRepo },
                { provide: KB_STORAGE_PLUGIN, useValue: storage },
                // KB_TRANSCRIBE_DISPATCHER intentionally NOT provided —
                // the `@Optional()` constructor param should resolve to
                // undefined and the result should carry a null run id.
                { provide: KB_NORMALIZE_MEDIA_DISPATCHER, useValue: normalizeDispatcher },
            ],
        }).compile();
        const isolated = module.get(KnowledgeBaseMediaNormalizeService);
        uploadRepo.findById.mockResolvedValue(buildUpload());
        stubSpawn(0);

        const result = await isolated.normalizeVideo(videoPayload);

        expect(result.transcribeRunId).toBeNull();
        expect(transcribeDispatcher.dispatchKbTranscribe).not.toHaveBeenCalled();
    });

    // EW-742 P3.2 T22 — KB-transcribe dispatcher stamping. Builds a
    // fresh service with WorkRepository + RuntimeBindingStamperService
    // wired and asserts that the (providerId, credentialVersion) pair
    // gets threaded onto the transcribe dispatch payload.
    describe('T22 — KB-transcribe enqueue-site tenant binding capture', () => {
        const TENANT_ID = '00000000-0000-0000-0000-00000000aaaa';

        async function buildWithStamper(opts: {
            stamperResult?: { providerId: string | null; credentialVersion: number | null };
            stamperThrows?: boolean;
            workTenantId?: string | null;
            workFindThrows?: boolean;
        }) {
            const workRepoMock = {
                findById: opts.workFindThrows
                    ? jest.fn().mockRejectedValue(new Error('db boom'))
                    : jest.fn().mockResolvedValue(
                          opts.workTenantId === undefined
                              ? null
                              : ({ id: WORK_ID, tenantId: opts.workTenantId } as any),
                      ),
            };
            const stamperMock = {
                stamp: opts.stamperThrows
                    ? jest.fn().mockRejectedValue(new Error('stamper boom'))
                    : jest
                          .fn()
                          .mockResolvedValue(
                              opts.stamperResult ?? {
                                  providerId: null,
                                  credentialVersion: null,
                              },
                          ),
            };
            const module: TestingModule = await Test.createTestingModule({
                providers: [
                    KnowledgeBaseMediaNormalizeService,
                    { provide: WorkKnowledgeUploadRepository, useValue: uploadRepo },
                    { provide: KB_STORAGE_PLUGIN, useValue: storage },
                    { provide: KB_TRANSCRIBE_DISPATCHER, useValue: transcribeDispatcher },
                    { provide: KB_NORMALIZE_MEDIA_DISPATCHER, useValue: normalizeDispatcher },
                    {
                        provide: RuntimeBindingStamperService,
                        useValue: stamperMock,
                    },
                    { provide: WorkRepository, useValue: workRepoMock },
                ],
            }).compile();
            return {
                service: module.get(KnowledgeBaseMediaNormalizeService),
                workRepoMock,
                stamperMock,
            };
        }

        it('stamps transcribe payload with stamper result when overlay is active', async () => {
            const { service: svc, workRepoMock, stamperMock } = await buildWithStamper({
                workTenantId: TENANT_ID,
                stamperResult: { providerId: 'trigger', credentialVersion: 17 },
            });
            uploadRepo.findById.mockResolvedValue(buildUpload());
            stubSpawn(0);

            await svc.normalizeVideo(videoPayload);

            expect(workRepoMock.findById).toHaveBeenCalledWith(WORK_ID);
            expect(stamperMock.stamp).toHaveBeenCalledWith(TENANT_ID);
            expect(transcribeDispatcher.dispatchKbTranscribe).toHaveBeenCalledWith(
                expect.objectContaining({
                    workId: WORK_ID,
                    providerId: 'trigger',
                    credentialVersion: 17,
                }),
            );
        });

        it('ships null/null when work has no tenantId', async () => {
            const { service: svc, stamperMock } = await buildWithStamper({
                workTenantId: null,
                stamperResult: { providerId: null, credentialVersion: null },
            });
            uploadRepo.findById.mockResolvedValue(buildUpload());
            stubSpawn(0);

            await svc.normalizeVideo(videoPayload);

            expect(stamperMock.stamp).toHaveBeenCalledWith(null);
            expect(transcribeDispatcher.dispatchKbTranscribe).toHaveBeenCalledWith(
                expect.objectContaining({
                    providerId: null,
                    credentialVersion: null,
                }),
            );
        });

        it('fails open on stamper throw', async () => {
            const { service: svc } = await buildWithStamper({
                workTenantId: TENANT_ID,
                stamperThrows: true,
            });
            uploadRepo.findById.mockResolvedValue(buildUpload());
            stubSpawn(0);

            await svc.normalizeVideo(videoPayload);

            expect(transcribeDispatcher.dispatchKbTranscribe).toHaveBeenCalledWith(
                expect.objectContaining({
                    providerId: null,
                    credentialVersion: null,
                }),
            );
        });

        it('fails open on workRepository.findById throw', async () => {
            const { service: svc, stamperMock } = await buildWithStamper({
                workFindThrows: true,
            });
            uploadRepo.findById.mockResolvedValue(buildUpload());
            stubSpawn(0);

            await svc.normalizeVideo(videoPayload);

            expect(stamperMock.stamp).not.toHaveBeenCalled();
            expect(transcribeDispatcher.dispatchKbTranscribe).toHaveBeenCalledWith(
                expect.objectContaining({
                    providerId: null,
                    credentialVersion: null,
                }),
            );
        });
    });
});
