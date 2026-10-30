import type { DataSource } from 'typeorm';
import { ExternalIdentity } from '@ever-works/agent/entities';
import { EverIdIdentityLinkedEvent, EverIdIdentityUnlinkedEvent } from '@ever-works/agent/events';
import { PERSON_LINK_RETRY_DELAYS_MS, PersonLinkReporter } from '../person-link.reporter';
import { createIdentityDataSource, insertIdentity } from './db.helper-spec';
import { FakeIntegration, FakePlatform, FakeQueue, problem } from './fakes.helper-spec';

/**
 * Which local accounts are linked to an Ever ID, as reported to Ever Platform.
 *
 * - A link of Ever Platform's issuer is queued with identifiers only (account
 *   id, issuer, subject, `explicit`, the tenant) — never the e-mail address the
 *   identity row keeps; an unlink is queued by account id.
 * - Nothing is queued while the installation is not connected, `ever_id_login`
 *   is off or no client was handed over, for another provider's identity, or
 *   for a provisioned one; a queued report is dropped unsent once it is off.
 * - `422 subject_unknown` and outages are retried for a day, then given up.
 * - Links made before the client was ready are queued once, page by page.
 */
describe('PersonLinkReporter — person links reported to Ever Platform', () => {
    const ISSUER = 'https://id.example.test';
    let dataSource: DataSource;
    let platform: FakePlatform;
    let integration: FakeIntegration;
    let queue: FakeQueue;
    let reporter: PersonLinkReporter;

    beforeAll(async () => {
        dataSource = await createIdentityDataSource();
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        await dataSource.getRepository(ExternalIdentity).clear();
        platform = new FakePlatform();
        integration = new FakeIntegration();
        integration.stored = { issuer: ISSUER, clientId: 'inst-x', clientSecret: 's' };
        queue = new FakeQueue();
        reporter = new PersonLinkReporter(platform, integration, queue, dataSource);
    });

    const linked = (identity: ExternalIdentity, linkedVia: 'sign-up' | 'settings' | 'provisioning' = 'settings') =>
        new EverIdIdentityLinkedEvent({ identityId: identity.id, userId: identity.userId, linkedVia });

    it('queues a link with identifiers only', async () => {
        const identity = await insertIdentity(dataSource, {
            issuer: ISSUER,
            subject: 'sub-ada',
            tenantId: '9b0a2c5e-6f0e-4d1e-9a4f-1c2b3d4e5f60',
        });
        await reporter.onIdentityLinked(linked(identity, 'sign-up'));

        expect(queue.reports).toEqual([
            {
                id: expect.any(String),
                op: 'link',
                userRef: identity.userId,
                issuer: ISSUER,
                subject: 'sub-ada',
                linkMethod: 'explicit',
                tenantId: '9b0a2c5e-6f0e-4d1e-9a4f-1c2b3d4e5f60',
            },
        ]);
        expect(JSON.stringify(queue.reports)).not.toContain('@');
        expect(platform.calls).toEqual([]);
    });

    it('sends the link and the unlink', async () => {
        platform
            .answer('instanceCreatePersonLink', { id: 'pl-1' })
            .answer('instanceDeletePersonLink', undefined);
        const identity = await insertIdentity(dataSource, { issuer: ISSUER, subject: 'sub-ada' });
        await reporter.onIdentityLinked(linked(identity));
        expect(await reporter.send(queue.reports[0])).toEqual({ outcome: 'sent' });
        const [create] = platform.callsOf('instanceCreatePersonLink');
        expect(create.input?.body).toEqual({
            product_user_ref: identity.userId,
            identity_issuer: ISSUER,
            identity_subject: 'sub-ada',
            link_method: 'explicit',
        });
        expect(create.input?.idempotencyKey).toBe(`person-link-${queue.reports[0].id}`);

        await dataSource.getRepository(ExternalIdentity).delete({ id: identity.id });
        await reporter.onIdentityUnlinked(
            new EverIdIdentityUnlinkedEvent({ identityId: identity.id, userId: identity.userId }),
        );
        expect(queue.reports[1]).toEqual({ id: expect.any(String), op: 'unlink', userRef: identity.userId });
        expect(await reporter.send(queue.reports[1])).toEqual({ outcome: 'sent' });
        expect(platform.callsOf('instanceDeletePersonLink')[0].input?.path).toEqual({
            ref: identity.userId,
        });
    });

    it('queues nothing when not connected, ever_id_login is off or no client was handed over', async () => {
        const identity = await insertIdentity(dataSource, { issuer: ISSUER, subject: 'sub-ada' });
        platform.connected = false;
        await reporter.onIdentityLinked(linked(identity));
        platform.connected = true;
        integration.enabled = false;
        await reporter.onIdentityLinked(linked(identity));
        integration.enabled = true;
        integration.stored = null;
        await reporter.onIdentityLinked(linked(identity));
        expect(queue.reports).toEqual([]);
    });

    it("queues nothing for another provider's identity or a provisioned one", async () => {
        const other = await insertIdentity(dataSource, {
            issuer: 'https://other.example.test',
            subject: 'sub-ada',
        });
        await reporter.onIdentityLinked(linked(other));
        const provisioned = await insertIdentity(dataSource, {
            issuer: ISSUER,
            subject: 'sub-bob',
            linkedVia: 'provisioning',
        });
        await reporter.onIdentityLinked(linked(provisioned, 'provisioning'));
        expect(queue.reports).toEqual([]);
    });

    it("an account that keeps Ever Platform's identity is not unlinked when another goes", async () => {
        const identity = await insertIdentity(dataSource, { issuer: ISSUER, subject: 'sub-ada' });
        await reporter.onIdentityUnlinked(
            new EverIdIdentityUnlinkedEvent({ identityId: 'another-provider', userId: identity.userId }),
        );
        expect(queue.reports).toEqual([]);
    });

    it('a queued report is dropped unsent once ever_id_login is off or the installation disconnected', async () => {
        const report = { id: 'r1', op: 'unlink' as const, userRef: 'user-1' };
        integration.enabled = false;
        expect(await reporter.send(report)).toEqual({
            outcome: 'dropped',
            code: 'integration_disabled',
        });
        integration.enabled = true;
        platform.connected = false;
        expect(await reporter.send(report)).toEqual({ outcome: 'dropped', code: 'not_connected' });
        platform.connected = true;
        platform.answer('instanceDeletePersonLink', problem(403, 'integration_revoked'));
        expect(await reporter.send(report)).toEqual({
            outcome: 'dropped',
            code: 'integration_revoked',
        });
        expect(platform.calls).toHaveLength(1);
    });

    it('subject_unknown and outages are retried for a day, then given up', async () => {
        const report = {
            id: 'r1',
            op: 'link' as const,
            userRef: 'user-1',
            issuer: ISSUER,
            subject: 'sub-gone',
            linkMethod: 'explicit' as const,
        };
        platform.answer('instanceCreatePersonLink', problem(422, 'subject_unknown'));
        for (let attempt = 0; attempt < PERSON_LINK_RETRY_DELAYS_MS.length; attempt += 1) {
            expect(await reporter.send(report, attempt)).toEqual({
                outcome: 'retry',
                afterMs: PERSON_LINK_RETRY_DELAYS_MS[attempt],
                code: 'subject_unknown',
            });
        }
        expect(await reporter.send(report, PERSON_LINK_RETRY_DELAYS_MS.length)).toEqual({
            outcome: 'failed',
            code: 'subject_unknown',
        });

        platform.answer('instanceCreatePersonLink', problem(503, 'unavailable'));
        expect(await reporter.send(report, 0)).toMatchObject({ outcome: 'retry' });
        platform.answer('instanceCreatePersonLink', problem(422, 'link_not_found'));
        expect(await reporter.send(report, 0)).toEqual({ outcome: 'failed', code: 'link_not_found' });
    });

    it('queues the links that existed before the client was ready, page by page', async () => {
        for (let i = 0; i < 205; i += 1) {
            await insertIdentity(dataSource, { issuer: ISSUER, subject: `sub-${i}` });
        }
        await insertIdentity(dataSource, { issuer: ISSUER, subject: 'sub-p', linkedVia: 'provisioning' });
        await insertIdentity(dataSource, { issuer: 'https://other.example.test', subject: 'sub-o' });

        expect(await reporter.reportExistingLinks(ISSUER)).toBe(205);
        expect(new Set(queue.reports.map((r) => (r.op === 'link' ? r.subject : '')))).toEqual(
            new Set(Array.from({ length: 205 }, (_, i) => `sub-${i}`)),
        );
    });
});
