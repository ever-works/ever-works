import type { DataSource } from 'typeorm';
import { EverConnectLink } from '@ever-works/agent/entities';
import type { EverConnectLeaseService } from '../../ever-connect-lease.service';
import type { EverConnectService } from '../../ever-connect.service';
import { createIdentityDataSource } from '../../identity/__tests__/db.helper-spec';
import {
    EverConnectProvisionCallback,
    PROVISION_CALLBACK_MAX_ATTEMPTS,
} from '../ever-connect-provision-callback.service';
import { EverConnectProvisionStore } from '../ever-connect-provision.store';

/**
 * The report to Ever Platform, on a real database. A fault between here and Ever
 * Platform never loses it, and it is `sent` only once the link is known here.
 */
const INSTANCE = '01K9A00000000000000000WKC0';
const KEY = 'job-1:2:provision_cloud_tenant:works';
const ORG = '33333333-3333-4333-8333-333333333331';
const TENANT = '44444444-4444-4444-8444-444444444441';
const USER = '11111111-1111-4111-8111-111111111111';
const LINK = '01K9A00000000000000000LNK1';

function problem(status: number, code: string): Error {
    return Object.assign(new Error(code), { name: 'ProblemError', status, code });
}

describe('EverConnectProvisionCallback', () => {
    let dataSource: DataSource;
    let store: EverConnectProvisionStore;
    let callback: EverConnectProvisionCallback;
    let complete: jest.Mock;
    let self: jest.Mock;
    let ended: jest.Mock;
    let connected: boolean;

    const client = () => ({
        connect: { completeProvisionIntent: complete },
        instances: { self },
    });

    beforeEach(async () => {
        dataSource = await createIdentityDataSource();
        store = new EverConnectProvisionStore(dataSource);
        complete = jest.fn(async () => ({ status: 'completed', tenant_link_id: LINK }));
        self = jest.fn(async () => ({ tenant_links: [] }));
        ended = jest.fn(async () => undefined);
        connected = true;
        const connection = {
            connection: async () => ({
                status: connected ? 'active' : 'disconnected',
                platformInstanceId: connected ? INSTANCE : null,
            }),
            client: async () => (connected ? client() : null),
            ended,
        } as unknown as EverConnectService;
        callback = new EverConnectProvisionCallback(store, connection, {
            hold: async () => true,
        } as unknown as EverConnectLeaseService);
    });

    afterEach(async () => {
        callback.onModuleDestroy();
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    async function created() {
        const claim = await store.claim(
            {
                creationKey: KEY,
                jti: 'jti-1',
                iat: 100,
                everOrgId: 'ever-org-1',
                handle: 'acme',
                userId: USER,
                idempotencyKey: 'k',
                bodyHash: 'h',
            },
            'a',
            new Date(Date.now() + 60_000),
        );
        if (claim.outcome !== 'claimed') throw new Error('not claimed');
        await store.checkpoint(
            claim.record.id,
            'a',
            { tenantId: TENANT, organizationId: ORG, organizationSlug: 'acme-2', userId: USER },
            new Date(Date.now() + 60_000),
        );
        await store.finish(claim.record.id, 'a', 'created', { cursor: 'done' });
        await dataSource.getRepository(EverConnectLink).insert({
            organizationId: ORG,
            tenantId: TENANT,
            everOrgId: 'ever-org-1',
            handle: 'acme',
            createdVia: 'provisioning',
        });
    }

    const row = async () => (await store.byKey(KEY))!;
    /** The next attempt, when it is due. */
    const later = (ms = 100 * 3_600_000) => callback.sendDue(new Date(Date.now() + ms));

    it('sends the identifiers and keeps the link Ever Platform answers', async () => {
        await created();
        await callback.sendNow(KEY);

        expect(complete).toHaveBeenCalledTimes(1);
        const [jti, body] = complete.mock.calls[0];
        expect(jti).toBe('jti-1');
        expect(body).toEqual({
            instance_id: INSTANCE,
            product_tenant_id: TENANT,
            product_org_id: 'acme-2',
            product_user_ref: USER,
            urls: { app: expect.stringMatching(/\/acme-2$/) },
            result: 'created',
        });
        expect(JSON.stringify(body)).not.toContain('@');

        const record = await row();
        expect(record.callbackStatus).toBe('sent');
        expect(record.platformLinkId).toBe(LINK);
        const link = await dataSource
            .getRepository(EverConnectLink)
            .findOneByOrFail({ tenantId: TENANT });
        expect(link.platformLinkId).toBe(LINK);
    });

    it('retries a report Ever Platform could not take, then finishes it', async () => {
        await created();
        complete.mockRejectedValueOnce(problem(503, 'unavailable'));
        await callback.sendNow(KEY);
        let record = await row();
        expect(record.callbackStatus).toBe('pending');
        expect(record.callbackAttempts).toBe(1);
        expect(record.callbackError).toBe('503_unavailable');
        expect(new Date(record.nextCallbackAt!).getTime()).toBeGreaterThan(Date.now());

        await callback.sendDue(); // Not due yet.
        expect(complete).toHaveBeenCalledTimes(1);

        await later();
        record = await row();
        expect(complete).toHaveBeenCalledTimes(2);
        expect(record.callbackStatus).toBe('sent');
    });

    it('treats no answer at all as worth retrying', async () => {
        await created();
        complete.mockRejectedValueOnce(new TypeError('fetch failed'));
        await callback.sendNow(KEY);
        expect((await row()).callbackStatus).toBe('pending');
    });

    it('never marks a report done when it finds no link: it stays open and is retried', async () => {
        await created();
        complete.mockResolvedValue({ status: 'already_completed', tenant_link_id: null });
        await callback.sendNow(KEY);

        let record = await row();
        expect(record.callbackStatus).toBe('pending');
        expect(record.callbackError).toBe('link_not_found');
        expect(record.completedAt).not.toBeNull();

        // Ever Platform is not asked again once it answered; the link is looked for again.
        self.mockResolvedValue({
            tenant_links: [
                { id: LINK, org_id: 'ever-org-1', product_tenant_id: TENANT, unlinked_at: null },
            ],
        });
        await later();
        record = await row();
        expect(complete).toHaveBeenCalledTimes(1);
        expect(record.callbackStatus).toBe('sent');
        expect(record.platformLinkId).toBe(LINK);
    });

    it('gives a report without a link up in the end, never as done', async () => {
        await created();
        complete.mockResolvedValue({ status: 'already_completed', tenant_link_id: null });
        for (let attempt = 0; attempt < PROVISION_CALLBACK_MAX_ATTEMPTS; attempt += 1) {
            await later((attempt + 1) * 100 * 3_600_000);
        }
        const record = await row();
        expect(record.callbackStatus).toBe('failed');
        expect(record.callbackError).toBe('link_not_found');
        expect(record.callbackAttempts).toBe(PROVISION_CALLBACK_MAX_ATTEMPTS);
    });

    it('gives a refusal up at once, and a new request opens the report again', async () => {
        await created();
        complete.mockRejectedValueOnce(problem(410, 'intent_expired'));
        await callback.sendNow(KEY);
        let record = await row();
        expect(record.callbackStatus).toBe('failed');
        expect(record.callbackError).toBe('410_intent_expired');

        expect(await store.reportUnder(record.id, 'jti-2', 200)).toBe(true);
        await callback.sendNow(KEY);
        record = await row();
        expect(complete).toHaveBeenLastCalledWith('jti-2', expect.anything());
        expect(record.callbackStatus).toBe('sent');
    });

    it('waits while the installation is not connected, without counting an attempt', async () => {
        await created();
        connected = false;
        await callback.sendNow(KEY);
        expect(complete).not.toHaveBeenCalled();
        expect((await row()).callbackAttempts).toBe(0);
        connected = true;
        await callback.sendNow(KEY);
        expect((await row()).callbackStatus).toBe('sent');
    });

    it('ends the connection when the credential was revoked', async () => {
        await created();
        complete.mockRejectedValueOnce(problem(401, 'credential_revoked'));
        await callback.sendNow(KEY);
        expect(ended).toHaveBeenCalledWith('revoked');
    });

    it('sends a declined request as a refusal, with nothing created', async () => {
        const record = await store.refuse({
            creationKey: KEY,
            jti: 'jti-1',
            iat: 100,
            everOrgId: 'ever-org-1',
            handle: 'acme',
            userId: USER,
        });
        await callback.sendNow(KEY);
        expect(complete).toHaveBeenCalledWith('jti-1', {
            instance_id: INSTANCE,
            product_tenant_id: 'none',
            result: 'refused',
            refusal_reason: 'user_declined',
        });
        const after = (await store.byKey(record!.creationKey))!;
        expect(after.callbackStatus).toBe('sent');
        expect(self).not.toHaveBeenCalled();
    });

    it('sends one report once when two callers race for it', async () => {
        await created();
        await Promise.all([callback.sendNow(KEY), callback.sendNow(KEY)]);
        expect(complete).toHaveBeenCalledTimes(1);
    });

    it('removes what ended on its schedule', async () => {
        const now = new Date();
        await store.saveIntent({
            jti: 'old',
            idempotencyKey: KEY,
            claims: '{}',
            expiresAt: new Date(now.getTime() - 3 * 86_400_000),
        });
        await callback.prune(now);
        expect(await store.intent('old')).toBeNull();
    });
});
