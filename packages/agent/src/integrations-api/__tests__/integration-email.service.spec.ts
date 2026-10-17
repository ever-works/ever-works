import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import {
    contractValidator,
    createDomainEventsDataSource,
    ORG_A,
    ORG_B,
} from '../../domain-events/__tests__/domain-events.test-helpers';
import { AgentEmailAssignment } from '../../entities/agent-email-assignment.entity';
import { EmailMessage } from '../../entities/email-message.entity';
import { TenantEmailAddress } from '../../entities/tenant-email-address.entity';
import { ResourceNotFoundError } from '../integration-api.errors';
import {
    IntegrationEmailService,
    integrationProviderMessageId,
} from '../integration-email.service';

/**
 * Integration API v1 agent email reads (EW-P4-2) and the inbound address
 * resolution of `POST /email/inbound` (EW-P4-1) on SQLite.
 */
describe('IntegrationEmailService', () => {
    let dataSource: DataSource;
    let email: IntegrationEmailService;
    const expectValid = contractValidator();
    const OWNER = randomUUID();
    const AGENT = randomUUID();

    beforeAll(async () => {
        dataSource = await createDomainEventsDataSource();
        email = new IntegrationEmailService(dataSource);
    });

    beforeEach(async () => {
        for (const table of [
            'email_messages',
            'agent_email_assignments',
            'tenant_email_addresses',
        ]) {
            await dataSource.query(`DELETE FROM "${table}"`);
        }
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    const message = (organizationId: string | null, extra: Partial<EmailMessage> = {}) =>
        dataSource.getRepository(EmailMessage).save({
            userId: OWNER,
            agentId: AGENT,
            emailAddressId: randomUUID(),
            direction: 'inbound',
            pluginId: 'postmark',
            providerMessageId: randomUUID(),
            from: 'ada@example.com',
            toAddresses: ['support@acme.test'],
            subject: 'Refund',
            bodyText: 'Can I get a refund?',
            status: 'received',
            organizationId,
            ...extra,
        } as unknown as EmailMessage);

    it("lists the organization's agent mail, filtered, as contract DTOs; never another organization's or personal mail", async () => {
        const inbound = await message(ORG_A);
        const outbound = await message(ORG_A, {
            direction: 'outbound',
            status: 'sent',
            sentAt: new Date(),
        } as Partial<EmailMessage>);
        await message(ORG_B);
        await message(null);
        const ids = async (query: Parameters<IntegrationEmailService['list']>[1]) =>
            (await email.list(ORG_A, query)).data.map((dto) => dto.id).sort();
        expect(await ids({})).toEqual([inbound.id, outbound.id].sort());
        expect(await ids({ direction: 'outbound' })).toEqual([outbound.id]);
        expect(await ids({ statuses: ['received'] })).toEqual([inbound.id]);
        expect(await ids({ agentId: randomUUID() })).toEqual([]);
        for (const dto of (await email.list(ORG_A, {})).data) {
            expectValid('resources/email-message.schema.json', dto);
        }
        await expect(email.get(ORG_A, inbound.id)).resolves.toMatchObject({ etag: '"1"' });
        await expect(email.get(ORG_B, inbound.id)).rejects.toBeInstanceOf(ResourceNotFoundError);
    });

    it("resolves the agent's first active inbound address, or why there is none", async () => {
        await expect(email.inboundAddressOf(AGENT)).resolves.toMatchObject({ ok: false });
        const address = (direction: string, disabledAt: Date | null = null) =>
            dataSource.getRepository(TenantEmailAddress).save({
                userId: OWNER,
                address: `${randomUUID().slice(0, 8)}@acme.test`,
                direction,
                pluginId: 'postmark',
                providerSettings: {},
                verified: true,
                disabledAt,
                organizationId: ORG_A,
            } as unknown as TenantEmailAddress);
        const disabled = await address('inbound', new Date());
        const active = await address('both');
        for (const [emailAddressId, priority] of [
            [disabled.id, 1],
            [active.id, 2],
        ] as const) {
            await dataSource.getRepository(AgentEmailAssignment).save({
                agentId: AGENT,
                emailAddressId,
                direction: 'inbound',
                priority,
                dispatchMode: 'task-spawn',
            } as unknown as AgentEmailAssignment);
        }
        const resolved = await email.inboundAddressOf(AGENT);
        expect(resolved).toMatchObject({ ok: true, address: { id: active.id } });
    });

    it('derives a stable provider message id per key, organization and dedupe key', () => {
        const a = integrationProviderMessageId('key-1', ORG_A, 'message-id:x@y');
        expect(a).toBe(integrationProviderMessageId('key-1', ORG_A, 'message-id:x@y'));
        expect(a).not.toBe(integrationProviderMessageId('key-2', ORG_A, 'message-id:x@y'));
        // One key pushing the same mail into two organizations delivers it to each.
        expect(a).not.toBe(integrationProviderMessageId('key-1', ORG_B, 'message-id:x@y'));
        expect(a.length).toBeLessThanOrEqual(200);
    });

    it("finds a replayed push only in the pinned organization's mail", async () => {
        const pushed = await message(ORG_A, { providerMessageId: 'integration-abc' });
        await expect(email.findPushed(ORG_A, 'postmark', 'integration-abc')).resolves.toMatchObject(
            { id: pushed.id },
        );
        await expect(email.findPushed(ORG_B, 'postmark', 'integration-abc')).resolves.toBeNull();
    });
});
