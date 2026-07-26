import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { IngestEventsDto } from './ingest-events.dto';

const validEnvelope = (overrides: Record<string, unknown> = {}) => ({
    id: 'env-1',
    source: 'slack-connector',
    sourceEventId: 'evt-1',
    kind: 'slack.message',
    occurredAt: '2026-07-01T10:00:00.000Z',
    actor: { name: 'Ada' },
    subject: { type: 'channel', externalId: 'C123', title: 'general' },
    sourceUrl: 'https://example.com/archives/C123/p1',
    payload: { text: 'hello' },
    ...overrides,
});

const build = (events: unknown[]) => plainToInstance(IngestEventsDto, { events });

describe('IngestEventsDto', () => {
    it('accepts a valid envelope batch', async () => {
        const errors = await validate(build([validEnvelope()]));
        expect(errors).toHaveLength(0);
    });

    it('rejects batches larger than 100 envelopes', async () => {
        const events = Array.from({ length: 101 }, (_, i) =>
            validEnvelope({ sourceEventId: `evt-${i}` }),
        );
        const errors = await validate(build(events));
        expect(errors).toHaveLength(1);
        expect(errors[0].constraints).toHaveProperty('arrayMaxSize');
    });

    it('rejects an empty batch', async () => {
        const errors = await validate(build([]));
        expect(errors).toHaveLength(1);
        expect(errors[0].constraints).toHaveProperty('arrayNotEmpty');
    });

    it('rejects a payload that serialises past the 32 KB cap', async () => {
        const errors = await validate(
            build([validEnvelope({ payload: { blob: 'x'.repeat(33 * 1024) } })]),
        );
        expect(errors).toHaveLength(1);
        expect(JSON.stringify(errors)).toContain('payloadByteCap');
    });

    it('rejects an array payload (must be an object map)', async () => {
        const errors = await validate(build([validEnvelope({ payload: ['not', 'an', 'object'] })]));
        expect(errors).toHaveLength(1);
        expect(JSON.stringify(errors)).toContain('payload');
    });

    it('rejects a missing kind and a non-ISO occurredAt', async () => {
        const missingKind = await validate(build([validEnvelope({ kind: '' })]));
        expect(missingKind).toHaveLength(1);

        const badDate = await validate(build([validEnvelope({ occurredAt: 'yesterday' })]));
        expect(badDate).toHaveLength(1);
        expect(JSON.stringify(badDate)).toContain('occurredAt');
    });

    it('validates nested actor/subject shapes', async () => {
        const errors = await validate(build([validEnvelope({ actor: { name: '' } })]));
        expect(errors).toHaveLength(1);
        expect(JSON.stringify(errors)).toContain('name');
    });

    it('rejects a non-uuid workId routing hint', async () => {
        const errors = await validate(build([validEnvelope({ workId: 'not-a-uuid' })]));
        expect(errors).toHaveLength(1);
        expect(JSON.stringify(errors)).toContain('workId');
    });

    it('accepts a well-formed workHint', async () => {
        const errors = await validate(
            build([
                validEnvelope({
                    workHint: { kind: 'chat-channel', externalId: 'C0123456789', label: 'general' },
                }),
            ]),
        );
        expect(errors).toHaveLength(0);
    });

    it('rejects a workHint of an unknown kind (the resolver must understand every kind it routes)', async () => {
        const errors = await validate(
            build([validEnvelope({ workHint: { kind: 'whatever', externalId: 'x' } })]),
        );
        expect(errors).toHaveLength(1);
        expect(JSON.stringify(errors)).toContain('kind');
    });

    it('rejects a workHint with an empty or over-long externalId', async () => {
        const empty = await validate(
            build([validEnvelope({ workHint: { kind: 'repo', externalId: '' } })]),
        );
        expect(empty).toHaveLength(1);

        const tooLong = await validate(
            build([validEnvelope({ workHint: { kind: 'repo', externalId: 'x'.repeat(201) } })]),
        );
        expect(tooLong).toHaveLength(1);
        expect(JSON.stringify(tooLong)).toContain('externalId');
    });
});
