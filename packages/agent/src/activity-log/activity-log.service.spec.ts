import { ActivityLogService } from './activity-log.service';
import { ActivityStatus } from '../entities/activity-log.types';
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

    describe('formatGenerationCompletionSummary', () => {
        it('formats cancelled generation summaries separately from failures', () => {
            expect(
                service.formatGenerationCompletionSummary({
                    name: 'Example Directory',
                    generateStatus: { status: GenerateStatusType.CANCELLED },
                }),
            ).toBe('Generation cancelled for Example Directory');
        });

        it('formats failed generation summaries', () => {
            expect(
                service.formatGenerationCompletionSummary({
                    name: 'Example Directory',
                    generateStatus: { status: GenerateStatusType.ERROR },
                }),
            ).toBe('Generation failed for Example Directory');
        });

        it('formats successful generation counts', () => {
            expect(
                service.formatGenerationCompletionSummary(
                    {
                        name: 'Example Directory',
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
