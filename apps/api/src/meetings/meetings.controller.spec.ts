// The controller injects WorkOwnershipService; stub the barrel so the spec
// never drags the services graph (and its ESM-only auth deps) in.
jest.mock('@ever-works/agent/services', () => ({
    WorkOwnershipService: class WorkOwnershipService {},
}));

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
    let ownership: { ensureCanEdit: jest.Mock };

    beforeEach(() => {
        ownership = { ensureCanEdit: jest.fn(async () => ({ work: { id: 'work-9' } })) };
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
        controller = new MeetingsController(service as never, ownership as never);
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

    describe('workId needs EDIT access to the Work', () => {
        const body = { title: 'Sync', startedAt: '2026-07-24T10:00:00.000Z', workId: 'work-9' };

        it('create checks edit access before anything is written', async () => {
            await controller.create(auth, body as never);
            expect(ownership.ensureCanEdit).toHaveBeenCalledWith('work-9', 'user-1');
            expect(service.createForUser).toHaveBeenCalled();
        });

        it('create refuses a Work the caller cannot edit, writing nothing', async () => {
            ownership.ensureCanEdit.mockRejectedValueOnce(new Error('forbidden'));
            await expect(controller.create(auth, body as never)).rejects.toThrow('forbidden');
            expect(service.createForUser).not.toHaveBeenCalled();
        });

        it('update refuses moving a meeting onto a Work the caller cannot edit', async () => {
            ownership.ensureCanEdit.mockRejectedValueOnce(new Error('forbidden'));
            await expect(
                controller.update(auth, 'meeting-1', { workId: 'foreign-work' } as never),
            ).rejects.toThrow('forbidden');
            expect(service.updateForUser).not.toHaveBeenCalled();
        });

        it('no workId (an org-wide meeting, or detaching) needs no Work check', async () => {
            await controller.create(auth, { title: 'Sync', startedAt: body.startedAt } as never);
            await controller.update(auth, 'meeting-1', { workId: null } as never);
            service.getForUser.mockResolvedValueOnce(meeting({ workId: null }));
            await controller.update(auth, 'meeting-1', { title: 'Renamed' } as never);
            expect(ownership.ensureCanEdit).not.toHaveBeenCalled();
        });

        // CodeRabbit on #2769: a patch that leaves `workId` out keeps the
        // meeting on its CURRENT Work — checked against that Work.
        it("update without workId is checked against the meeting's current Work", async () => {
            ownership.ensureCanEdit.mockRejectedValueOnce(new Error('forbidden'));
            await expect(
                controller.update(auth, 'meeting-1', { title: 'Renamed' } as never),
            ).rejects.toThrow('forbidden');
            expect(ownership.ensureCanEdit).toHaveBeenCalledWith('work-9', 'user-1');
            expect(service.updateForUser).not.toHaveBeenCalled();
        });

        it("a transcript needs edit access to the meeting's Work (it feeds its memory)", async () => {
            ownership.ensureCanEdit.mockRejectedValueOnce(new Error('forbidden'));
            await expect(
                controller.ingestTranscript(auth, 'meeting-1', { transcriptText: 'x' }),
            ).rejects.toThrow('forbidden');
            expect(ownership.ensureCanEdit).toHaveBeenCalledWith('work-9', 'user-1');
            expect(service.ingestTranscriptForUser).not.toHaveBeenCalled();
        });

        it('fails closed when the ownership service is not bound', async () => {
            const bare = new MeetingsController(service as never);
            await expect(bare.create(auth, body as never)).rejects.toThrow(
                'Work access cannot be verified here.',
            );
            expect(service.createForUser).not.toHaveBeenCalled();
        });
    });

    it('delete routes through the owner-scoped service path', async () => {
        await controller.remove(auth, 'meeting-1');
        expect(service.deleteForUser).toHaveBeenCalledWith('user-1', 'meeting-1');
    });
});
