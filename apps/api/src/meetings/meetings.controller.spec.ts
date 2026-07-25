import { MeetingsController } from './meetings.controller';
import type { AuthenticatedUser } from '../auth/types/auth.types';

const auth = { userId: 'user-1' } as AuthenticatedUser;

const meeting = (overrides: Record<string, unknown> = {}) => ({
    id: 'meeting-1',
    userId: 'user-1',
    organizationId: null,
    workId: 'work-9',
    title: 'Weekly sync',
    startedAt: new Date('2026-07-24T10:00:00.000Z'),
    endedAt: new Date('2026-07-24T10:30:00.000Z'),
    source: 'zoom',
    externalId: 'uuid-1',
    participants: [{ name: 'Alice' }],
    transcriptText: 'Alice: Hello.',
    summary: 'The team aligned on the launch.',
    sourceUrl: 'https://example.zoom.us/rec/play/abc',
    dedupeKey: 'secret-dedupe-key',
    createdAt: new Date('2026-07-24T11:00:00.000Z'),
    ...overrides,
});

describe('MeetingsController', () => {
    let service: {
        listForUser: jest.Mock;
        createForUser: jest.Mock;
        getForUser: jest.Mock;
        updateForUser: jest.Mock;
        deleteForUser: jest.Mock;
        ingestTranscriptForUser: jest.Mock;
    };
    let controller: MeetingsController;

    beforeEach(() => {
        service = {
            listForUser: jest.fn(async () => [meeting()]),
            createForUser: jest.fn(async () => meeting()),
            getForUser: jest.fn(async () => meeting()),
            updateForUser: jest.fn(async () => meeting()),
            deleteForUser: jest.fn(async () => undefined),
            ingestTranscriptForUser: jest.fn(async () => ({
                meeting: meeting(),
                summary: 'The team aligned on the launch.',
                memorySaved: true,
                envelopeEmitted: true,
            })),
        };
        controller = new MeetingsController(service as never);
    });

    it('list is owner-scoped, passes safe filters through and OMITS the transcript body', async () => {
        const rows = await controller.list(auth, 'work-9', 'zoom', '10', undefined);

        expect(service.listForUser).toHaveBeenCalledWith('user-1', {
            workId: 'work-9',
            source: 'zoom',
            limit: 10,
        });
        expect(rows[0]).toMatchObject({
            id: 'meeting-1',
            hasTranscript: true,
            summary: 'The team aligned on the launch.',
        });
        expect(rows[0].transcriptText).toBeUndefined();
        // The internal dedupe key never leaves the API.
        expect(rows[0] as unknown as Record<string, unknown>).not.toHaveProperty('dedupeKey');
    });

    it('list drops unknown source filters instead of passing them to the query', async () => {
        await controller.list(auth, undefined, 'carrier-pigeon', undefined, undefined);
        expect(service.listForUser).toHaveBeenCalledWith('user-1', {});
    });

    it('getOne includes the transcript body', async () => {
        const view = await controller.getOne(auth, 'meeting-1');

        expect(service.getForUser).toHaveBeenCalledWith('user-1', 'meeting-1');
        expect(view.transcriptText).toBe('Alice: Hello.');
    });

    it('ingestTranscript returns the pipeline outcome flags with the refreshed view', async () => {
        const result = await controller.ingestTranscript(auth, 'meeting-1', {
            transcriptText: 'Alice: Hello.',
        });

        expect(service.ingestTranscriptForUser).toHaveBeenCalledWith(
            'user-1',
            'meeting-1',
            'Alice: Hello.',
        );
        expect(result).toMatchObject({
            summary: 'The team aligned on the launch.',
            memorySaved: true,
            envelopeEmitted: true,
        });
        expect(result.meeting.hasTranscript).toBe(true);
    });

    it('delete routes through the owner-scoped service path', async () => {
        await controller.remove(auth, 'meeting-1');
        expect(service.deleteForUser).toHaveBeenCalledWith('user-1', 'meeting-1');
    });
});
