jest.mock('@ever-works/agent/entities', () => ({
    ActivityActionType: {
        WEBSITE_USER_REGISTERED: 'website_user_registered',
        WEBSITE_ITEM_SUBMITTED: 'website_item_submitted',
        WEBSITE_REPORT_FILED: 'website_report_filed',
        WEBSITE_REPORT_RESOLVED: 'website_report_resolved',
    },
}));

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { IngestEventDto } from './ingest-event.dto';

function baseDto(over: Partial<IngestEventDto> = {}) {
    return plainToInstance(IngestEventDto, {
        workId: '11111111-1111-4111-8111-111111111111',
        eventId: '22222222-2222-4222-8222-222222222222',
        actionType: 'website_user_registered',
        occurredAt: '2026-05-13T10:00:00.000Z',
        summary: 'User signed up',
        ...over,
    });
}

describe('IngestEventDto validation', () => {
    it('accepts a well-formed payload with the four allowed action types', async () => {
        const types = [
            'website_user_registered',
            'website_item_submitted',
            'website_report_filed',
            'website_report_resolved',
        ];
        for (const actionType of types) {
            const errors = await validate(baseDto({ actionType: actionType as never }));
            expect(errors).toHaveLength(0);
        }
    });

    it('rejects an actionType outside the allow-list (no WORK_DELETED smuggling)', async () => {
        const errors = await validate(baseDto({ actionType: 'work_deleted' as never }));
        expect(errors.find((e) => e.property === 'actionType')).toBeDefined();
    });

    it('rejects non-UUID workId / eventId', async () => {
        let errors = await validate(baseDto({ workId: 'not-a-uuid' }));
        expect(errors.find((e) => e.property === 'workId')).toBeDefined();
        errors = await validate(baseDto({ eventId: '123' }));
        expect(errors.find((e) => e.property === 'eventId')).toBeDefined();
    });

    it('rejects metadata larger than 8 KiB after JSON serialisation', async () => {
        const blob = 'x'.repeat(9000);
        const errors = await validate(baseDto({ metadata: { blob } }));
        expect(errors.find((e) => e.property === 'metadata')).toBeDefined();
    });

    it('accepts metadata under the size cap', async () => {
        const errors = await validate(
            baseDto({ metadata: { itemId: 'i-1', actor: 'bob', adminUrl: 'https://x' } }),
        );
        expect(errors).toHaveLength(0);
    });

    it('accepts an omitted metadata field', async () => {
        const errors = await validate(baseDto({ metadata: undefined }));
        expect(errors).toHaveLength(0);
    });

    it('caps summary at 500 chars', async () => {
        const errors = await validate(baseDto({ summary: 's'.repeat(501) }));
        expect(errors.find((e) => e.property === 'summary')).toBeDefined();
    });
});
