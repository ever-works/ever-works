import { subjectHash } from '@ever-co/connect-sdk';
import { Repository, type DataSource } from 'typeorm';
import type { ActivityLogService } from '@ever-works/agent/activity-log';
import {
    AuthSession,
    EverConnectPersonRequest,
    ExternalIdentity,
} from '@ever-works/agent/entities';
import type { PersonDataParticipant } from '../person-data-participant.port';
import { PersonRequestNotAnsweredError, PersonRequestsHandler } from '../person-requests.handler';
import { createIdentityDataSource, insertIdentity, insertSession } from './db.helper-spec';
import { FakePlatform, problem } from './fakes.helper-spec';

/**
 * Ever Platform's deletion and export requests for a person, answered with
 * `POST /v1/instances/me/ack`.
 *
 * - Deletion removes the person's connected identities (and the sessions they
 *   opened); without a bound participant the answer is `failed` with
 *   `account_deletion_pending` and the account's Activity says so — never
 *   `retained_legal`. A bound participant's answer is passed on
 *   (`retained_legal` only with its legal basis). No matching account:
 *   `no_account`.
 * - Export: the participant's `https` address (`exported`); unbound, `failed`
 *   with `export_not_available`.
 * - One answer per job: an event delivered again sends no second ack, and a
 *   request answered on one delivery is never re-decided from data already
 *   removed. A final answer already recorded (`409 receipt_final`) or a job not
 *   asked of this installation (`404`) is done; an outage rejects so the event
 *   is delivered again.
 */
describe('PersonRequestsHandler — deletion and export requests', () => {
    const ISSUER = 'https://id.example.test';
    const JOB = '01K6A7S2ABCDEFGHJKMNPQRSTV';
    const JOB_2 = '01K6A7S2ABCDEFGHJKMNPQRSTW';
    let dataSource: DataSource;
    let platform: FakePlatform;
    let activity: { log: jest.Mock };

    const deletion = (jobId: string, hashes: string[], id = `evt-${jobId}`) => ({
        id,
        type: 'ever.registry.person.deletion_requested',
        data: {
            person_id: '01JMQCKPERS0N00000000000P1',
            job_id: jobId,
            respond_by: '2026-11-30T00:00:00Z',
            subject_hash: hashes[0],
            subject_hashes: hashes,
        },
    });
    const exportRequest = (jobId: string, hashes: string[]) => ({
        ...deletion(jobId, hashes),
        type: 'ever.registry.person.export_requested',
    });

    const handler = (participant?: PersonDataParticipant) =>
        new PersonRequestsHandler(
            platform,
            dataSource,
            activity as unknown as ActivityLogService,
            participant,
        );

    beforeAll(async () => {
        dataSource = await createIdentityDataSource();
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        await dataSource.getRepository(ExternalIdentity).clear();
        await dataSource.getRepository(AuthSession).clear();
        await dataSource.getRepository(EverConnectPersonRequest).clear();
        platform = new FakePlatform().answer('instanceAckRequest', undefined);
        activity = { log: jest.fn().mockResolvedValue({}) };
    });

    it('handles the two person topics only', () => {
        const h = handler();
        expect(h.handles('ever.registry.person.deletion_requested')).toBe(true);
        expect(h.handles('ever.registry.person.export_requested')).toBe(true);
        expect(h.handles('ever.registry.instance.disconnected')).toBe(false);
    });

    it('deletion without a participant: identities and their sessions removed, failed account_deletion_pending', async () => {
        const ada = await insertIdentity(dataSource, { issuer: ISSUER, subject: 'sub-ada' });
        const other = await insertIdentity(dataSource, { issuer: ISSUER, subject: 'sub-bob' });
        await insertSession(dataSource, ada);
        await insertSession(dataSource, other);

        const answer = await handler().handle(deletion(JOB, [subjectHash(ISSUER, 'sub-ada')]));

        expect(answer).toEqual({
            jobId: JOB,
            kind: 'deletion',
            result: 'failed',
            reasonCode: 'account_deletion_pending',
            recorded: true,
        });
        expect(platform.callsOf('instanceAckRequest')[0].input?.body).toEqual({
            job_id: JOB,
            result: 'failed',
            detail: { reason_code: 'account_deletion_pending' },
        });
        const left = await dataSource.getRepository(ExternalIdentity).find();
        expect(left.map((identity) => identity.subject)).toEqual(['sub-bob']);
        const sessions = await dataSource.getRepository(AuthSession).find();
        expect(sessions.map((session) => session.externalIdentityId)).toEqual([other.id]);
        expect(activity.log).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: ada.userId,
                action: 'ever_connect.person_deletion.account_pending',
                metadata: { jobId: JOB, reasonCode: 'account_deletion_pending' },
            }),
        );
    });

    it('an event delivered again sends no second answer', async () => {
        await insertIdentity(dataSource, { issuer: ISSUER, subject: 'sub-ada' });
        const event = deletion(JOB, [subjectHash(ISSUER, 'sub-ada')]);
        const h = handler();
        await h.handle(event);
        const again = await h.handle(event);
        expect(again).toMatchObject({ result: 'failed', recorded: true });
        expect(platform.callsOf('instanceAckRequest')).toHaveLength(1);
    });

    it('an answer not delivered is sent again, unchanged, on the next delivery', async () => {
        await insertIdentity(dataSource, { issuer: ISSUER, subject: 'sub-ada' });
        const event = deletion(JOB, [subjectHash(ISSUER, 'sub-ada')]);
        platform.answer('instanceAckRequest', problem(503, 'unavailable'), undefined);
        const h = handler();
        await expect(h.handle(event)).rejects.toBeInstanceOf(PersonRequestNotAnsweredError);
        // The identity is gone already; the stored answer is sent, not `no_account`.
        const answer = await h.handle(event);
        expect(answer).toMatchObject({
            result: 'failed',
            reasonCode: 'account_deletion_pending',
            recorded: true,
        });
        const bodies = platform.callsOf('instanceAckRequest').map((call) => call.input?.body);
        expect(bodies[1]).toEqual(bodies[0]);
    });

    it('no matching account: no_account', async () => {
        await insertIdentity(dataSource, { issuer: ISSUER, subject: 'sub-bob' });
        const answer = await handler().handle(deletion(JOB, [subjectHash(ISSUER, 'sub-ada')]));
        expect(answer).toMatchObject({ result: 'no_account', reasonCode: null });
        expect(platform.callsOf('instanceAckRequest')[0].input?.body).toEqual({
            job_id: JOB,
            result: 'no_account',
        });
        expect(activity.log).not.toHaveBeenCalled();
    });

    it("a bound participant's answer is passed on; retained_legal needs its legal basis", async () => {
        await insertIdentity(dataSource, { issuer: ISSUER, subject: 'sub-ada' });
        const participant = {
            deleteAccounts: jest.fn().mockResolvedValue({ result: 'deleted' }),
            exportAccounts: jest.fn(),
        };
        expect(
            await handler(participant).handle(deletion(JOB, [subjectHash(ISSUER, 'sub-ada')])),
        ).toMatchObject({ result: 'deleted', reasonCode: null });
        expect(participant.deleteAccounts).toHaveBeenCalledWith({
            userIds: [expect.any(String)],
            jobId: JOB,
            respondBy: '2026-11-30T00:00:00Z',
        });

        await insertIdentity(dataSource, { issuer: ISSUER, subject: 'sub-bob' });
        participant.deleteAccounts.mockResolvedValue({ result: 'retained_legal', legalBasis: ' ' });
        expect(
            await handler(participant).handle(deletion(JOB_2, [subjectHash(ISSUER, 'sub-bob')])),
        ).toMatchObject({ result: 'failed', reasonCode: 'legal_basis_missing' });
    });

    it('export: the participant address, or failed export_not_available when unbound', async () => {
        await insertIdentity(dataSource, { issuer: ISSUER, subject: 'sub-ada' });
        const hash = subjectHash(ISSUER, 'sub-ada');
        expect(await handler().handle(exportRequest(JOB, [hash]))).toMatchObject({
            kind: 'export',
            result: 'failed',
            reasonCode: 'export_not_available',
        });

        const participant = {
            deleteAccounts: jest.fn(),
            exportAccounts: jest.fn().mockResolvedValue({
                result: 'exported',
                exportUrl: 'https://works.example.test/exports/1',
            }),
        };
        expect(await handler(participant).handle(exportRequest(JOB_2, [hash]))).toMatchObject({
            result: 'exported',
        });
        expect(platform.callsOf('instanceAckRequest')[1].input?.body).toEqual({
            job_id: JOB_2,
            result: 'exported',
            export_url: 'https://works.example.test/exports/1',
        });
        // An export never removes anything.
        expect(await dataSource.getRepository(ExternalIdentity).count()).toBe(1);
    });

    it('an export address that is not https is not passed on', async () => {
        await insertIdentity(dataSource, { issuer: ISSUER, subject: 'sub-ada' });
        const participant = {
            deleteAccounts: jest.fn(),
            exportAccounts: jest.fn().mockResolvedValue({
                result: 'exported',
                exportUrl: 'http://works.example.test/x',
            }),
        };
        expect(
            await handler(participant).handle(exportRequest(JOB, [subjectHash(ISSUER, 'sub-ada')])),
        ).toMatchObject({ result: 'failed', reasonCode: 'export_failed' });
    });

    it('receipt_final and a job not asked of this installation are done; an outage rejects', async () => {
        const hash = subjectHash(ISSUER, 'sub-ada');
        platform.answer('instanceAckRequest', problem(409, 'receipt_final'));
        expect(await handler().handle(deletion(JOB, [hash]))).toMatchObject({ recorded: true });
        platform.answer('instanceAckRequest', problem(404, 'not_found'));
        expect(await handler().handle(deletion(JOB_2, [hash]))).toMatchObject({ recorded: true });

        platform.answer('instanceAckRequest', problem(500, 'internal_error'));
        await expect(
            handler().handle(deletion('01K6A7S2ABCDEFGHJKMNPQRSTX', [hash])),
        ).rejects.toBeInstanceOf(PersonRequestNotAnsweredError);
        platform.connected = false;
        await expect(
            handler().handle(deletion('01K6A7S2ABCDEFGHJKMNPQRSTX', [hash])),
        ).rejects.toThrow('not_connected');
    });

    it('a malformed request is ignored', async () => {
        expect(
            await handler().handle({
                id: 'evt-1',
                type: 'ever.registry.person.deletion_requested',
                data: { job_id: 'not-a-job' },
            }),
        ).toBeNull();
        expect(await handler().handle({ id: 'evt-2', type: 'other', data: {} })).toBeNull();
        expect(platform.calls).toEqual([]);
    });

    it('reads the first page of identities without an id cursor (not a uuid)', async () => {
        const find = jest.spyOn(Repository.prototype, 'find');
        await handler().handle(deletion(JOB, [subjectHash(ISSUER, 'sub-ada')]));
        const first = find.mock.calls.find(
            (call) => (call[0] as { select?: Record<string, unknown> })?.select?.subject,
        );
        expect((first?.[0] as { where: Record<string, unknown> }).where).not.toHaveProperty('id');
        find.mockRestore();
    });

    it('stores identifiers only', async () => {
        await insertIdentity(dataSource, { issuer: ISSUER, subject: 'sub-ada' });
        await handler().handle(deletion(JOB, [subjectHash(ISSUER, 'sub-ada')]));
        const [row] = await dataSource.getRepository(EverConnectPersonRequest).find();
        const stored = JSON.stringify(row);
        expect(stored).not.toContain('sub-ada');
        expect(stored).not.toContain(subjectHash(ISSUER, 'sub-ada'));
        expect(stored).not.toContain('@');
    });
});
