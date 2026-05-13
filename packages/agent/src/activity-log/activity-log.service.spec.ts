import { ActivityLogService } from './activity-log.service';
import { ActivityActionType, ActivityStatus } from '../entities/activity-log.types';
import { GenerateStatusType } from '../entities/types';

describe('ActivityLogService', () => {
    const service = new ActivityLogService({} as any, {} as any, {} as any);

    describe('resolveGenerationActivityStatus', () => {
        it('maps cancelled generation to cancelled activity status', () => {
            expect(
                service.resolveGenerationActivityStatus({
                    generateStatus: { status: GenerateStatusType.CANCELLED },
                }),
            ).toBe(ActivityStatus.CANCELLED);
        });

        it('maps error or missing generation state to failed activity status', () => {
            expect(
                service.resolveGenerationActivityStatus({
                    generateStatus: { status: GenerateStatusType.ERROR },
                }),
            ).toBe(ActivityStatus.FAILED);
            expect(service.resolveGenerationActivityStatus(null)).toBe(ActivityStatus.FAILED);
        });

        it('maps successful generation state to completed activity status', () => {
            expect(
                service.resolveGenerationActivityStatus({
                    generateStatus: { status: GenerateStatusType.GENERATED },
                }),
            ).toBe(ActivityStatus.COMPLETED);
        });
    });

    describe('ingestFromWebsite (EW-120)', () => {
        const buildService = (
            existingByEvent: Record<string, unknown> | null = null,
            work: { id: string; userId: string } | null = { id: 'work-1', userId: 'owner-1' },
        ) => {
            const created: Array<Record<string, unknown>> = [];
            const repo = {
                findByWorkAndIngestEventId: jest.fn().mockResolvedValue(existingByEvent),
                create: jest.fn().mockImplementation((entry, overrides) => {
                    const row = {
                        id: 'al-' + (created.length + 1),
                        ...entry,
                        ...(overrides ?? {}),
                    };
                    created.push(row);
                    return Promise.resolve(row);
                }),
            };
            const workRepo = { findById: jest.fn().mockResolvedValue(work) };
            const svc = new ActivityLogService(repo as never, workRepo as never, {} as never);
            return { svc, repo, workRepo, created };
        };

        it('returns the existing row when the same eventId was already ingested', async () => {
            const existing = { id: 'al-existing', ingestEventId: 'evt-1' };
            const { svc, repo } = buildService(existing);

            const result = await svc.ingestFromWebsite({
                workId: 'work-1',
                eventId: 'evt-1',
                actionType: ActivityActionType.WEBSITE_USER_REGISTERED,
                occurredAt: new Date('2026-05-13T10:00:00.000Z'),
                summary: 'User signed up',
            });

            expect(result).toBe(existing);
            expect(repo.findByWorkAndIngestEventId).toHaveBeenCalledWith('work-1', 'evt-1');
            expect(repo.create).not.toHaveBeenCalled();
        });

        it('creates a new row attributed to the work owner on first ingest', async () => {
            const { svc, repo, created } = buildService(null);

            await svc.ingestFromWebsite({
                workId: 'work-1',
                eventId: 'evt-1',
                actionType: ActivityActionType.WEBSITE_ITEM_SUBMITTED,
                occurredAt: new Date('2026-05-13T10:00:00.000Z'),
                summary: 'Item submitted',
                metadata: { itemId: 'i-1', actor: 'bob' },
            });

            expect(repo.create).toHaveBeenCalledTimes(1);
            const row = created[0];
            expect(row.userId).toBe('owner-1');
            expect(row.workId).toBe('work-1');
            expect(row.actionType).toBe(ActivityActionType.WEBSITE_ITEM_SUBMITTED);
            expect(row.status).toBe(ActivityStatus.COMPLETED);
            expect(row.summary).toBe('Item submitted');
            expect(row.ingestEventId).toBe('evt-1');
            const metadata = row.metadata as Record<string, unknown>;
            expect(metadata.itemId).toBe('i-1');
            expect(metadata.occurredAt).toBe('2026-05-13T10:00:00.000Z');
        });

        it('sets createdAt to occurredAt so feed ordering reflects when the event happened', async () => {
            const { svc, repo } = buildService(null);
            const occurredAt = new Date('2026-05-13T10:00:00.000Z');

            await svc.ingestFromWebsite({
                workId: 'work-1',
                eventId: 'evt-1',
                actionType: ActivityActionType.WEBSITE_USER_REGISTERED,
                occurredAt,
                summary: 'User signed up',
            });

            // Repository.create receives the override as the second arg.
            expect(repo.create).toHaveBeenCalledWith(
                expect.objectContaining({ ingestEventId: 'evt-1' }),
                { createdAt: occurredAt },
            );
        });

        it('throws when the referenced work does not exist', async () => {
            const { svc } = buildService(null, null);

            await expect(
                svc.ingestFromWebsite({
                    workId: 'missing',
                    eventId: 'evt-1',
                    actionType: ActivityActionType.WEBSITE_REPORT_FILED,
                    occurredAt: new Date(),
                    summary: 'Report',
                }),
            ).rejects.toThrow(/work missing not found/i);
        });
    });

    describe('formatGenerationCompletionSummary', () => {
        it('formats cancelled generation summaries separately from failures', () => {
            expect(
                service.formatGenerationCompletionSummary({
                    name: 'Example Work',
                    generateStatus: { status: GenerateStatusType.CANCELLED },
                }),
            ).toBe('Generation cancelled for Example Work');
        });

        it('formats failed generation summaries', () => {
            expect(
                service.formatGenerationCompletionSummary({
                    name: 'Example Work',
                    generateStatus: { status: GenerateStatusType.ERROR },
                }),
            ).toBe('Generation failed for Example Work');
        });

        it('formats successful generation counts', () => {
            expect(
                service.formatGenerationCompletionSummary(
                    {
                        name: 'Example Work',
                        generateStatus: { status: GenerateStatusType.GENERATED },
                    },
                    {
                        newItemsCount: 2,
                        updatedItemsCount: 3,
                        totalItemsCount: 5,
                    },
                ),
            ).toBe('Added 2. Changed 3. Total: 5');
        });
    });
});
