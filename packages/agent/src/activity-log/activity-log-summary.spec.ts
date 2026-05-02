import { formatGenerationCountsSummary, formatStoredActivitySummary } from './activity-log-summary';

describe('activity log summary', () => {
    it('formats generation completion summaries from structured counts', () => {
        expect(
            formatStoredActivitySummary({
                actionType: 'generation',
                status: 'completed',
                summary: 'Generated 0 items for Example Work',
                details: {
                    newItemsCount: 13,
                    updatedItemsCount: 55,
                    totalItemsCount: 4412,
                },
            }),
        ).toBe('Added 13. Changed 55. Total: 4412');
    });

    it('falls back to the stored summary for non-generation activities', () => {
        expect(
            formatStoredActivitySummary({
                actionType: 'member_invited',
                status: 'completed',
                summary: 'Invited jane@example.com as editor',
                details: {
                    inviteeEmail: 'jane@example.com',
                },
            }),
        ).toBe('Invited jane@example.com as editor');
    });

    it('falls back to the stored summary for failed generation entries', () => {
        expect(
            formatStoredActivitySummary({
                actionType: 'generation',
                status: 'failed',
                summary: 'Generation failed for Example Work',
                details: {
                    newItemsCount: 13,
                    updatedItemsCount: 55,
                    totalItemsCount: 4412,
                },
            }),
        ).toBe('Generation failed for Example Work');
    });

    it('formats generation counts directly', () => {
        expect(
            formatGenerationCountsSummary({
                newItemsCount: 1,
                updatedItemsCount: 2,
                totalItemsCount: 3,
            }),
        ).toBe('Added 1. Changed 2. Total: 3');
    });

    it('formats zero-change runs more clearly', () => {
        expect(
            formatGenerationCountsSummary({
                newItemsCount: 0,
                updatedItemsCount: 0,
                totalItemsCount: 86,
            }),
        ).toBe('No item changes. Total: 86');
    });
});
