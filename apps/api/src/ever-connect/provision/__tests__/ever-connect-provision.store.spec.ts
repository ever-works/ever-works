import type { DataSource } from 'typeorm';
import { EverConnectLink, EverConnectProvisionIntent } from '@ever-works/agent/entities';
import { createIdentityDataSource } from '../../identity/__tests__/db.helper-spec';
import {
    ClaimLostError,
    EverConnectProvisionStore,
    type ProvisionClaimInput,
} from '../ever-connect-provision.store';

/**
 * The rules of a creation, on a real database: every statement here is a
 * compare-and-set, and the stand-ins that hid a failing creation elsewhere are not
 * used.
 */
const KEY = 'job-1:2:provision_cloud_tenant:works';
const input = (over: Partial<ProvisionClaimInput> = {}): ProvisionClaimInput => ({
    creationKey: KEY,
    jti: 'jti-1',
    iat: 100,
    everOrgId: 'ever-org-1',
    handle: 'acme',
    userId: '11111111-1111-4111-8111-111111111111',
    idempotencyKey: 'browser-key-1',
    bodyHash: 'hash-1',
    ...over,
});
const soon = () => new Date(Date.now() + 60_000);

describe('EverConnectProvisionStore', () => {
    let dataSource: DataSource;
    let store: EverConnectProvisionStore;

    beforeEach(async () => {
        dataSource = await createIdentityDataSource();
        store = new EverConnectProvisionStore(dataSource);
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    const stop = (id: string) =>
        dataSource
            .getRepository('EverConnectProvisionRecord')
            .update({ id }, { claimedUntil: new Date(Date.now() - 1_000) });

    describe('claim', () => {
        it('gives a new creation to the first attempt and tells the second it is busy', async () => {
            const first = await store.claim(input(), 'a', soon());
            expect(first.outcome).toBe('claimed');
            const second = await store.claim(input(), 'b', soon());
            expect(second.outcome).toBe('busy');
        });

        it('lets a new request of the same step finish a stopped creation, never 409', async () => {
            const first = await store.claim(input(), 'a', soon());
            if (first.outcome !== 'claimed') throw new Error('not claimed');
            await store.checkpoint(
                first.record.id,
                'a',
                {
                    companyWorkId: '22222222-2222-4222-8222-222222222222',
                    steps: { cursor: 'core_done' },
                },
                soon(),
            );
            await stop(first.record.id);

            const retry = await store.claim(input({ jti: 'jti-2', iat: 200 }), 'b', soon());
            expect(retry.outcome).toBe('claimed');
            if (retry.outcome !== 'claimed') return;
            expect(retry.record.id).toBe(first.record.id);
            expect(retry.record.intentJti).toBe('jti-2');
            expect(retry.record.companyWorkId).toBe('22222222-2222-4222-8222-222222222222');
            expect(retry.record.steps.cursor).toBe('core_done');
        });

        it('stops the attempt that lost its claim', async () => {
            const first = await store.claim(input(), 'a', soon());
            if (first.outcome !== 'claimed') throw new Error('not claimed');
            await stop(first.record.id);
            await store.claim(input({ jti: 'jti-2', iat: 200 }), 'b', soon());
            await expect(store.checkpoint(first.record.id, 'a', {}, soon())).rejects.toBeInstanceOf(
                ClaimLostError,
            );
            await expect(
                store.finish(first.record.id, 'a', 'created', { cursor: 'done' }),
            ).rejects.toBeInstanceOf(ClaimLostError);
        });

        it('lets a failed creation be finished, and frees the Ever organization meanwhile', async () => {
            const first = await store.claim(input(), 'a', soon());
            if (first.outcome !== 'claimed') throw new Error('not claimed');
            await store.fail(first.record.id, 'a', 'boom');
            const other = await store.claim(
                input({ creationKey: 'other-key', jti: 'jti-9' }),
                'c',
                soon(),
            );
            expect(other.outcome).toBe('claimed');

            // The Ever organization is held by the other key now.
            const back = await store.claim(input({ jti: 'jti-2', iat: 200 }), 'b', soon());
            expect(back.outcome).toBe('org_linked');
        });

        it('never lets an older request take a creation back', async () => {
            const first = await store.claim(input({ jti: 'jti-2', iat: 200 }), 'a', soon());
            if (first.outcome !== 'claimed') throw new Error('not claimed');
            await stop(first.record.id);
            expect(
                (await store.claim(input({ jti: 'jti-1', iat: 100 }), 'b', soon())).outcome,
            ).toBe('replayed');
        });

        it('refuses a request used under another key', async () => {
            await store.claim(input(), 'a', soon());
            const other = await store.claim(
                input({ creationKey: 'other-key', everOrgId: 'ever-org-2' }),
                'b',
                soon(),
            );
            expect(other.outcome).toBe('replayed');
        });

        it('refuses a second key for one Ever organization', async () => {
            await store.claim(input(), 'a', soon());
            const other = await store.claim(
                input({ creationKey: 'other-key', jti: 'jti-2' }),
                'b',
                soon(),
            );
            expect(other.outcome).toBe('org_linked');
        });

        it('answers a finished creation as it is', async () => {
            const first = await store.claim(input(), 'a', soon());
            if (first.outcome !== 'claimed') throw new Error('not claimed');
            await store.finish(first.record.id, 'a', 'partial', { cursor: 'done' });
            const again = await store.claim(input({ jti: 'jti-2', iat: 200 }), 'b', soon());
            expect(again.outcome).toBe('finished');
        });
    });

    describe('reports', () => {
        const finished = async () => {
            const first = await store.claim(input(), 'a', soon());
            if (first.outcome !== 'claimed') throw new Error('not claimed');
            await store.finish(first.record.id, 'a', 'created', { cursor: 'done' });
            return (await store.byKey(KEY))!;
        };

        it('makes a finished creation due, and leases it to one caller', async () => {
            const record = await finished();
            expect(record.callbackStatus).toBe('pending');
            const due = await store.dueReports(10, new Date(Date.now() + 1_000));
            expect(due.map((row) => row.id)).toEqual([record.id]);

            expect(await store.leaseReport(record, soon(), new Date(Date.now() + 1_000))).toBe(
                true,
            );
            expect(await store.leaseReport(record, soon(), new Date(Date.now() + 1_000))).toBe(
                false,
            );
            expect(await store.dueReports(10, new Date(Date.now() + 1_000))).toEqual([]);
        });

        it('moves a report to a newer request until Ever Platform answered it', async () => {
            const record = await finished();
            await store.updateReport(record.id, 0, {
                callbackStatus: 'failed',
                callbackAttempts: 1,
            });
            expect(await store.reportUnder(record.id, 'jti-2', 200)).toBe(true);
            const moved = (await store.byKey(KEY))!;
            expect(moved.intentJti).toBe('jti-2');
            expect(moved.callbackStatus).toBe('pending');
            expect(moved.callbackAttempts).toBe(0);

            await store.updateReport(record.id, 0, { completedAt: new Date() });
            expect(await store.reportUnder(record.id, 'jti-3', 300)).toBe(false);
        });

        it('never moves a report back to an older request', async () => {
            const record = await finished();
            expect(await store.reportUnder(record.id, 'jti-0', 50)).toBe(false);
        });
    });

    describe('refuse', () => {
        const declined = () =>
            store.refuse({
                creationKey: KEY,
                jti: 'jti-1',
                iat: 100,
                everOrgId: 'ever-org-1',
                handle: 'acme',
                userId: input().userId,
            });

        it('records a declined request, with a report due', async () => {
            const record = await declined();
            expect(record?.status).toBe('refused');
            expect(record?.callbackStatus).toBe('pending');
            expect(record?.everOrgKey).toBeNull();
        });

        it('is safe to repeat, and a new request after it can still create', async () => {
            await declined();
            expect((await declined())?.status).toBe('refused');
            const retry = await store.claim(input({ jti: 'jti-2', iat: 200 }), 'a', soon());
            expect(retry.outcome).toBe('claimed');
            if (retry.outcome !== 'claimed') return;
            expect(retry.record.status).toBe('pending');
            expect(retry.record.callbackStatus).toBeNull();
        });

        it('refuses to decline a company that exists', async () => {
            const first = await store.claim(input(), 'a', soon());
            if (first.outcome !== 'claimed') throw new Error('not claimed');
            await store.finish(first.record.id, 'a', 'created', { cursor: 'done' });
            expect(await declined()).toBeNull();
        });
    });

    describe('keeping and removing', () => {
        it('keeps a request once, under its own key', async () => {
            const values = {
                jti: 'jti-1',
                idempotencyKey: KEY,
                claims: '{}',
                expiresAt: new Date(Date.now() + 1_000),
            };
            expect(await store.saveIntent(values)).toBe(true);
            expect(await store.saveIntent(values)).toBe(true);
            expect(await store.saveIntent({ ...values, idempotencyKey: 'another' })).toBe(false);
        });

        it('removes requests that ended, except one whose report is open', async () => {
            const past = new Date(Date.now() - 2 * 86_400_000);
            for (const jti of ['jti-1', 'jti-2']) {
                await store.saveIntent({ jti, idempotencyKey: KEY, claims: '{}', expiresAt: past });
            }
            const first = await store.claim(input(), 'a', soon());
            if (first.outcome !== 'claimed') throw new Error('not claimed');
            await store.finish(first.record.id, 'a', 'created', { cursor: 'done' });

            expect(await store.purgeEndedIntents(new Date(Date.now() - 86_400_000))).toBe(1);
            const left = await dataSource.getRepository(EverConnectProvisionIntent).find();
            expect(left.map((row) => row.jti)).toEqual(['jti-1']);
        });

        it('prunes finished records after their time, never one with an open report', async () => {
            const first = await store.claim(input(), 'a', soon());
            if (first.outcome !== 'claimed') throw new Error('not claimed');
            await store.finish(first.record.id, 'a', 'created', { cursor: 'done' });
            const later = new Date(Date.now() + 60_000);
            expect(await store.pruneRecords(later)).toBe(0);
            await store.updateReport(first.record.id, 0, { callbackStatus: 'sent' });
            expect(await store.pruneRecords(later)).toBe(1);
        });

        it('holds one active link per tenant and per Ever organization', async () => {
            const links = dataSource.getRepository(EverConnectLink);
            const row = (organizationId: string, tenantId: string, everOrgId: string) => ({
                organizationId,
                tenantId,
                everOrgId,
                handle: 'acme',
                createdVia: 'provisioning' as const,
            });
            const a = '33333333-3333-4333-8333-333333333331';
            const b = '33333333-3333-4333-8333-333333333332';
            const c = '33333333-3333-4333-8333-333333333333';
            const t = '44444444-4444-4444-8444-444444444441';
            const u = '44444444-4444-4444-8444-444444444442';
            await links.insert(row(a, t, 'org-1'));
            await expect(links.insert(row(b, t, 'org-2'))).rejects.toThrow();
            await expect(links.insert(row(b, u, 'org-1'))).rejects.toThrow();
            await links.update({ organizationId: a }, { status: 'archived' });
            await links.insert(row(c, t, 'org-1'));
            expect(await store.activeLinkOfTenant(t)).toMatchObject({ organizationId: c });
            expect(await store.activeLinkOfEverOrg('org-1')).toMatchObject({ organizationId: c });
        });
    });
});
