import { randomUUID } from 'node:crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { DataSource } from 'typeorm';
import {
    catalogDataValidator,
    contractValidator,
    createDomainEventsDataSource,
    ORG_A,
    ORG_B,
    resetDomainEventsTables,
    TENANT,
} from '../../domain-events/__tests__/domain-events.test-helpers';
import { runWithDomainEventContext } from '../../domain-events/domain-event-context';
import { DomainEventFeedService } from '../../domain-events/domain-event-feed.service';
import { DomainEventPublisher } from '../../domain-events/domain-event-publisher.service';
import { DomainEventRecorder } from '../../domain-events/domain-event-recorder.service';
import { DomainEventRelayService } from '../../domain-events/domain-event-relay.service';
import { DomainEventRetentionService } from '../../domain-events/domain-event-retention.service';
import { InboxItemRepository } from '../../database/repositories/inbox-item.repository';
import { DomainEvent } from '../../entities/domain-event.entity';
import { Goal } from '../../entities/goal.entity';
import { InboxItem } from '../../entities/inbox-item.entity';
import { Organization } from '../../entities/organization.entity';
import { OrganizationMember } from '../../entities/organization-member.entity';
import { Task } from '../../entities/task.entity';
import { Tenant } from '../../entities/tenant.entity';
import { User } from '../../entities/user.entity';
import { Work } from '../../entities/work.entity';
import { InboxService } from '../../inbox/inbox.service';
import { ExternalRecordLinksService } from '../external-record-links.service';
import {
    DuplicateExternalRefError,
    IntegrationDomainRuleError,
    IntegrationValidationError,
    ResourceNotFoundError,
    VersionMismatchError,
} from '../integration-api.errors';
import {
    IntegrationInboxService,
    type ExternalInboxItemCreate,
    type ExternalInboxWriter,
} from '../integration-inbox.service';
import { IntegrationResourcesService } from '../integration-resources.service';

/**
 * Integration inbox push on SQLite with the real publisher, relay and feed:
 * an integration key files ITS OWN Inbox items for a member of the pinned
 * organization, changes them (its own only, at the If-Match version only), and
 * reads back the member's answer — while the change feed never serves the
 * key's own writes back to it (`excludeOrigin`). Each security gate has a case
 * that fails without it.
 */
describe('IntegrationInboxService — integration inbox push', () => {
    let dataSource: DataSource;
    let publisher: DomainEventPublisher;
    let service: IntegrationInboxService;
    const expectValid = contractValidator();
    const expectValidEvent = catalogDataValidator();

    const KEY = randomUUID();
    const OTHER_KEY = randomUUID();
    const OWNER = randomUUID();
    const ADA = randomUUID(); // member of ORG_A
    const BOB = randomUUID(); // member of ORG_B only (same tenant)
    const EVE = randomUUID(); // member of ORG_A, deactivated
    const ORIGIN = 'gauzy:conn-1';

    const writer = (overrides: Partial<ExternalInboxWriter> = {}): ExternalInboxWriter => ({
        organizationId: ORG_A,
        tenantId: TENANT,
        integrationKeyId: KEY,
        defaultSourceLabel: 'Ever Gauzy',
        ...overrides,
    });
    const input = (overrides: Partial<ExternalInboxItemCreate> = {}): ExternalInboxItemCreate => ({
        externalId: 'gauzy-inbox-1',
        recipientUserId: ADA,
        kind: 'notice',
        title: 'Timesheet approved',
        body: 'Your **timesheet** for week 43 was approved.',
        sourceUrl: 'https://app.gauzy.co/#/pages/inbox/1',
        ...overrides,
    });
    /** A write as Gauzy makes it: inside its request's X-Sync-Origin. */
    const asGauzy = <T>(fn: () => Promise<T>): Promise<T> =>
        runWithDomainEventContext(
            {
                actor: { type: 'integration', id: KEY, label: 'Ever Gauzy (prod)' },
                originTag: ORIGIN,
                integrationKeyId: KEY,
            },
            fn,
        );
    const events = () =>
        dataSource.getRepository(DomainEvent).find({ order: { outboxSeq: 'ASC' } });
    /** The error a write is refused with (fails the test when it is not refused). */
    const refusal = async (write: Promise<unknown>): Promise<unknown> => {
        try {
            await write;
        } catch (error) {
            return error;
        }
        throw new Error('expected the write to be refused');
    };
    const rows = () => dataSource.getRepository(InboxItem).find();

    beforeAll(async () => {
        dataSource = await createDomainEventsDataSource();
        publisher = new DomainEventPublisher(new DomainEventRecorder(), dataSource);
        service = new IntegrationInboxService(
            dataSource,
            new IntegrationResourcesService(dataSource, new ExternalRecordLinksService(dataSource)),
            publisher,
        );
    });

    beforeEach(async () => {
        await resetDomainEventsTables(dataSource);
        for (const table of [
            'inbox_items',
            'organizations',
            'organization_members',
            'users',
            'tasks',
            'works',
            'goals',
        ]) {
            await dataSource.query(`DELETE FROM "${table}"`);
        }
        await dataSource.getRepository(Organization).insert([
            { id: ORG_A, tenantId: TENANT, slug: 'acme', displayName: 'Acme' },
            { id: ORG_B, tenantId: TENANT, slug: 'beta', displayName: 'Beta' },
        ] as unknown as Organization[]);
        await dataSource.getRepository(Tenant).insert({
            id: TENANT,
            ownerUserId: OWNER,
            slug: 'tenant',
            displayName: 'Tenant',
        } as unknown as Tenant);
        for (const [id, isActive] of [
            [OWNER, true],
            [ADA, true],
            [BOB, true],
            [EVE, false],
        ] as const) {
            await dataSource.getRepository(User).insert({
                id,
                username: `u-${id.slice(0, 6)}`,
                slug: `u-${id.slice(0, 6)}`,
                email: `${id.slice(0, 6)}@example.com`,
                tenantId: TENANT,
                isActive,
            } as unknown as User);
        }
        await dataSource.getRepository(OrganizationMember).insert([
            { organizationId: ORG_A, userId: ADA, tenantId: TENANT, role: 'member', joinedAt: new Date() },
            { organizationId: ORG_B, userId: BOB, tenantId: TENANT, role: 'member', joinedAt: new Date() },
            { organizationId: ORG_A, userId: EVE, tenantId: TENANT, role: 'member', joinedAt: new Date() },
        ] as unknown as OrganizationMember[]);
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    const task = (organizationId: string, visibility = 'organization') =>
        dataSource.getRepository(Task).save({
            id: randomUUID(),
            userId: OWNER,
            slug: `T-${Math.floor(Math.random() * 1e6)}`,
            title: 'Ship the feed',
            createdByType: 'user',
            createdById: OWNER,
            tenantId: TENANT,
            organizationId,
            visibility,
        } as unknown as Task);
    const work = async (organizationId: string) => {
        const id = randomUUID();
        await dataSource.getRepository(Work).insert({
            id,
            name: 'Docs',
            slug: `docs-${id.slice(0, 6)}`,
            description: 'Docs',
            userId: OWNER,
            tenantId: TENANT,
            organizationId,
        } as unknown as Work);
        return id;
    };
    const goal = (organizationId: string) =>
        dataSource.getRepository(Goal).save(
            dataSource.getRepository(Goal).create({
                userId: OWNER,
                title: 'Ship v1',
                window: 'total',
                tenantId: TENANT,
                organizationId,
                visibility: 'organization',
            } as Partial<Goal>),
        );

    // ── create ────────────────────────────────────────────────────────

    it('files an origin-integration item for a member, recording inbox.item.created with the request origin', async () => {
        const { item, created } = await asGauzy(() => service.createExternal(writer(), input()));
        expect(created).toBe(true);
        expect(item.etag).toBe('"1"');
        expect(item.dto).toMatchObject({
            organizationId: ORG_A,
            recipientUserId: ADA,
            kind: 'notice',
            origin: 'integration',
            externalId: 'gauzy-inbox-1',
            sourceUrl: 'https://app.gauzy.co/#/pages/inbox/1',
            sourceLabel: 'Ever Gauzy',
            sourceType: 'integration',
            status: 'open',
            unread: true,
            version: 1,
            // Markdown is stored as the text it is, never rendered.
            body: 'Your **timesheet** for week 43 was approved.',
        });
        expectValid('resources/inbox-item.schema.json', item.dto);

        const [row] = await rows();
        expect(row).toMatchObject({ integrationKeyId: KEY, tenantId: TENANT, origin: 'integration' });
        const [event] = await events();
        expect(event).toMatchObject({
            type: 'inbox.item.created',
            aggregateId: row.id,
            aggregateVersion: 1,
            originTag: ORIGIN,
            integrationKeyId: KEY,
            visibility: 'recipient',
        });
        expectValidEvent(event);
    });

    it('a replayed externalId returns the existing item unchanged: never a duplicate, never a second event', async () => {
        const first = await service.createExternal(writer(), input());
        const replay = await service.createExternal(
            writer(),
            input({ title: 'Something else entirely', body: 'changed' }),
        );
        expect(replay.created).toBe(false);
        expect(replay.item.dto).toEqual(first.item.dto);
        expect(await rows()).toHaveLength(1);
        expect((await events()).map((event) => event.type)).toEqual(['inbox.item.created']);
    });

    it('two concurrent creates of one externalId leave one item (the unique index decides)', async () => {
        const [a, b] = await Promise.all([
            service.createExternal(writer(), input()),
            service.createExternal(writer(), input()),
        ]);
        expect(a.item.dto.id).toBe(b.item.dto.id);
        expect([a.created, b.created].sort()).toEqual([false, true]);
        expect(await rows()).toHaveLength(1);
    });

    it('scopes externalId to the key: another key files its own; the same key in another organization is a conflict', async () => {
        await dataSource.getRepository(OrganizationMember).insert({
            organizationId: ORG_B,
            userId: ADA,
            tenantId: TENANT,
            role: 'member',
            joinedAt: new Date(),
        } as unknown as OrganizationMember);
        const mine = await service.createExternal(writer(), input());
        const theirs = await service.createExternal(writer({ integrationKeyId: OTHER_KEY }), input());
        expect(theirs.created).toBe(true);
        expect(theirs.item.dto.id).not.toBe(mine.item.dto.id);
        await expect(
            service.createExternal(writer({ organizationId: ORG_B }), input()),
        ).rejects.toBeInstanceOf(DuplicateExternalRefError);
    });

    it('defaults sourceLabel to the integration name and keeps the one it was given', async () => {
        const named = await service.createExternal(
            writer(),
            input({ externalId: 'x-2', sourceLabel: '  Gauzy HR  ' }),
        );
        expect(named.item.dto.sourceLabel).toBe('Gauzy HR');
        const generic = await service.createExternal(
            writer({ defaultSourceLabel: 'Acme Sync' }),
            input({ externalId: 'x-3' }),
        );
        expect(generic.item.dto.sourceLabel).toBe('Acme Sync');
    });

    it('stores the email header block for kind email, and the choices of a question', async () => {
        const email = await service.createExternal(
            writer(),
            input({
                externalId: 'mail-1',
                kind: 'email',
                title: 'Invoice #42',
                email: {
                    from: 'Billing <billing@example.com>',
                    to: 'ada@example.com',
                    subject: 'Invoice #42',
                    receivedAt: '2026-10-28T09:00:00.000Z',
                },
                occurredAt: '2026-10-28T09:00:00.000Z',
            }),
        );
        expect(email.item.dto).toMatchObject({
            kind: 'email',
            email: {
                from: 'Billing <billing@example.com>',
                to: 'ada@example.com',
                subject: 'Invoice #42',
                receivedAt: '2026-10-28T09:00:00.000Z',
            },
            occurredAt: '2026-10-28T09:00:00.000Z',
        });
        expectValid('resources/inbox-item.schema.json', email.item.dto);

        const question = await service.createExternal(
            writer(),
            input({
                externalId: 'q-1',
                kind: 'question',
                title: 'Approve the leave request?',
                choices: [
                    { id: 'yes', label: 'Approve' },
                    { id: 'no', label: 'Decline' },
                ],
            }),
        );
        expect(question.item.dto.options).toEqual([
            { id: 'yes', label: 'Approve' },
            { id: 'no', label: 'Decline' },
        ]);
    });

    it('links the related Task, Work and Goal of the pinned organization', async () => {
        const t = await task(ORG_A);
        const w = await work(ORG_A);
        const g = await goal(ORG_A);
        const { item } = await service.createExternal(
            writer(),
            input({ kind: 'assignment', related: { taskId: t.id, workId: w, goalId: g.id } }),
        );
        expect(item.dto).toMatchObject({ taskId: t.id, workId: w, goalId: g.id });
    });

    // ── the security gates (each fails without its check) ─────────────

    it('GATE cross-org recipient: a member of another organization only is 422, and nothing is filed', async () => {
        const error = await refusal(service.createExternal(writer(), input({ recipientUserId: BOB })));
        expect(error).toBeInstanceOf(IntegrationDomainRuleError);
        expect(error).toMatchObject({ details: { field: 'recipientUserId' } });
        // Nobody at all, and a deactivated member, are refused the same way.
        for (const recipientUserId of [randomUUID(), EVE]) {
            await expect(
                service.createExternal(writer(), input({ recipientUserId })),
            ).rejects.toBeInstanceOf(IntegrationDomainRuleError);
        }
        expect(await rows()).toEqual([]);
        expect(await events()).toEqual([]);
    });

    it('the tenant owner is a member of every organization (no roster row needed)', async () => {
        const { item } = await service.createExternal(writer(), input({ recipientUserId: OWNER }));
        expect(item.dto.recipientUserId).toBe(OWNER);
    });

    it('GATE cross-org related id: a Task, Work or Goal of another organization (or a private Task) is 422', async () => {
        const cases: Array<[string, Record<string, string>]> = [
            ['related.taskId', { taskId: (await task(ORG_B)).id }],
            ['related.taskId', { taskId: (await task(ORG_A, 'private')).id }],
            ['related.taskId', { taskId: randomUUID() }],
            ['related.workId', { workId: await work(ORG_B) }],
            ['related.goalId', { goalId: (await goal(ORG_B)).id }],
        ];
        for (const [field, related] of cases) {
            const error = await refusal(service.createExternal(writer(), input({ related })));
            expect(error).toBeInstanceOf(IntegrationDomainRuleError);
            expect(error).toMatchObject({ details: { field } });
        }
        expect(await rows()).toEqual([]);
    });

    it('GATE http sourceUrl: only an absolute https URL without credentials is stored', async () => {
        for (const sourceUrl of [
            'http://app.gauzy.co/inbox/1',
            'javascript:alert(document.cookie)',
            'JAVASCRIPT:alert(1)',
            'data:text/html,<script>alert(1)</script>',
            '//app.gauzy.co/inbox/1',
            '/pages/inbox/1',
            'https://user:pass@app.gauzy.co/inbox/1',
            'https://app.gauzy.co/inbox/1 ',
            'https://app.gauzy.co/\u0000inbox',
            `https://app.gauzy.co/${'a'.repeat(2000)}`,
        ]) {
            const error = await refusal(service.createExternal(writer(), input({ sourceUrl })));
            expect([sourceUrl, error instanceof IntegrationValidationError]).toEqual([sourceUrl, true]);
            expect(error).toMatchObject({ path: 'sourceUrl' });
        }
        expect(await rows()).toEqual([]);
    });

    it('GATE oversize body: 20 000 characters are stored as written, one more is refused (never truncated)', async () => {
        const { item } = await service.createExternal(
            writer(),
            input({ externalId: 'big', body: 'x'.repeat(20_000) }),
        );
        expect(item.dto.body).toHaveLength(20_000);
        const error = await refusal(
            service.createExternal(writer(), input({ externalId: 'too-big', body: 'x'.repeat(20_001) })),
        );
        expect(error).toBeInstanceOf(IntegrationValidationError);
        expect(error).toMatchObject({ path: 'body' });
        expect(await rows()).toHaveLength(1);
    });

    it('refuses the shapes the contract closes: escalation kind, choices off question / approval, email off kind email, caps', async () => {
        const refused: Array<[string, Partial<ExternalInboxItemCreate>]> = [
            ['kind', { kind: 'escalation' }],
            ['kind', { kind: 'memo' }],
            ['choices', { kind: 'notice', choices: [{ id: 'a', label: 'A' }] }],
            [
                'choices',
                {
                    kind: 'question',
                    choices: Array.from({ length: 11 }, (_, i) => ({ id: `c${i}`, label: `C${i}` })),
                },
            ],
            [
                'choices[1].id',
                {
                    kind: 'approval',
                    choices: [
                        { id: 'a', label: 'A' },
                        { id: 'a', label: 'Again' },
                    ],
                },
            ],
            ['choices[0].id', { kind: 'question', choices: [{ id: 'x'.repeat(65), label: 'A' }] }],
            [
                'email',
                {
                    kind: 'notice',
                    email: { from: 'a@b.c', subject: 'S', receivedAt: '2026-10-28T09:00:00Z' },
                },
            ],
            ['title', { title: 'x'.repeat(301) }],
            ['title', { title: 'two\nlines' }],
            ['externalId', { externalId: 'x'.repeat(129) }],
            ['sourceLabel', { sourceLabel: 'x'.repeat(81) }],
            ['occurredAt', { occurredAt: 'yesterday' }],
            ['recipientUserId', { recipientUserId: 'ada' }],
        ];
        for (const [path, overrides] of refused) {
            const error = await refusal(service.createExternal(writer(), input(overrides)));
            expect([path, error instanceof IntegrationValidationError]).toEqual([path, true]);
            expect(error).toMatchObject({ path });
        }
    });

    // ── update ────────────────────────────────────────────────────────

    it('PATCH updates text, choices and state at the If-Match version and records inbox.item.updated', async () => {
        const { item } = await service.createExternal(
            writer(),
            input({ kind: 'approval', choices: [{ id: 'approve', label: 'Approve' }] }),
        );
        const updated = await asGauzy(() =>
            service.updateExternal(writer(), item.dto.id, 1, {
                title: 'Timesheet approved (edited)',
                choices: [
                    { id: 'approve', label: 'Approve' },
                    { id: 'reject', label: 'Reject' },
                ],
            }),
        );
        expect(updated.dto).toMatchObject({ title: 'Timesheet approved (edited)', version: 2 });
        expect(updated.etag).toBe('"2"');
        const resolved = await service.updateExternal(writer(), item.dto.id, 2, {
            state: 'resolved',
            resolution: { choiceId: 'reject', text: 'Decided in Gauzy' },
        });
        expect(resolved.dto).toMatchObject({
            status: 'answered',
            unread: false,
            answerOptionId: 'reject',
            answerText: 'Decided in Gauzy',
            version: 3,
        });
        expect(resolved.dto.answeredAt).not.toBeNull();

        const recorded = (await events()).slice(1);
        expect(recorded.map((event) => [event.type, event.aggregateVersion])).toEqual([
            ['inbox.item.updated', 2],
            ['inbox.item.updated', 3],
        ]);
        expect(recorded[0]).toMatchObject({
            originTag: ORIGIN,
            changedFields: ['title', 'options'],
            previous: { title: 'Timesheet approved' },
        });
        for (const event of recorded) expectValidEvent(event);

        const reopened = await service.updateExternal(writer(), item.dto.id, 3, { state: 'open' });
        expect(reopened.dto).toMatchObject({
            status: 'open',
            answeredAt: null,
            answerText: null,
            answerOptionId: null,
        });
        const archived = await service.updateExternal(writer(), item.dto.id, 4, { state: 'archived' });
        expect(archived.dto.status).toBe('archived');
    });

    it('GATE PATCH on someone else’s item: another key’s, a platform item and another organization’s are all 404', async () => {
        const { item } = await service.createExternal(writer(), input());
        await expect(
            service.updateExternal(writer({ integrationKeyId: OTHER_KEY }), item.dto.id, 1, {
                title: 'Hijacked',
            }),
        ).rejects.toBeInstanceOf(ResourceNotFoundError);
        await expect(
            service.updateExternal(writer({ organizationId: ORG_B }), item.dto.id, 1, {
                title: 'Hijacked',
            }),
        ).rejects.toBeInstanceOf(ResourceNotFoundError);

        const platform = await dataSource.getRepository(InboxItem).save({
            userId: ADA,
            organizationId: ORG_A,
            tenantId: TENANT,
            kind: 'question',
            title: 'Which tier?',
            body: 'Which tier?',
            sourceType: 'agent-run',
            status: 'open',
            unread: true,
        } as unknown as InboxItem);
        await expect(
            service.updateExternal(writer(), platform.id, 1, { title: 'Hijacked' }),
        ).rejects.toBeInstanceOf(ResourceNotFoundError);

        expect((await service.get(ORG_A, item.dto.id)).dto.title).toBe('Timesheet approved');
        expect((await service.get(ORG_A, platform.id)).dto.title).toBe('Which tier?');
        expect((await events()).map((event) => event.type)).toEqual(['inbox.item.created']);
    });

    it('GATE If-Match mismatch: a stale version is 412 and changes nothing; of two writers at one version only one lands', async () => {
        const { item } = await service.createExternal(writer(), input());
        await service.updateExternal(writer(), item.dto.id, 1, { title: 'Second' });
        const stale = await refusal(
            service.updateExternal(writer(), item.dto.id, 1, { title: 'Stale' }),
        );
        expect(stale).toBeInstanceOf(VersionMismatchError);
        expect(stale).toMatchObject({ expected: 1, current: 2 });
        expect((await service.get(ORG_A, item.dto.id)).dto.title).toBe('Second');

        const results = await Promise.allSettled([
            service.updateExternal(writer(), item.dto.id, 2, { title: 'A' }),
            service.updateExternal(writer(), item.dto.id, 2, { title: 'B' }),
        ]);
        expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
        const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
        expect(rejected.reason).toBeInstanceOf(VersionMismatchError);
        const stored = await service.get(ORG_A, item.dto.id);
        expect(stored.dto.version).toBe(3);
        // One event per landed write, each at its own version.
        expect((await events()).map((event) => event.aggregateVersion)).toEqual([1, 2, 3]);
    });

    it('PATCH refuses a resolution without state resolved, a choiceId the item does not offer, and an empty body', async () => {
        const { item } = await service.createExternal(
            writer(),
            input({ kind: 'question', choices: [{ id: 'yes', label: 'Yes' }] }),
        );
        await expect(
            service.updateExternal(writer(), item.dto.id, 1, { resolution: { text: 'x' } }),
        ).rejects.toMatchObject({ path: 'resolution' });
        await expect(
            service.updateExternal(writer(), item.dto.id, 1, {
                state: 'resolved',
                resolution: { choiceId: 'maybe' },
            }),
        ).rejects.toMatchObject({ path: 'resolution.choiceId' });
        await expect(service.updateExternal(writer(), item.dto.id, 1, {})).rejects.toBeInstanceOf(
            IntegrationValidationError,
        );
        await expect(
            service.updateExternal(writer(), item.dto.id, 1, { body: 'x'.repeat(20_001) }),
        ).rejects.toMatchObject({ path: 'body' });
        expect((await service.get(ORG_A, item.dto.id)).dto.version).toBe(1);
    });

    // ── the member's answer, and the loop guard ───────────────────────

    it("the member's answer in Ever Works starts no run and is recorded as inbox.item.updated; the feed never serves the key's own writes back", async () => {
        const runs = {
            findById: jest.fn(async () => null),
            findByIdAndUser: jest.fn(async () => null),
            setAwaitingInput: jest.fn(async () => undefined),
        };
        const steering = { steer: jest.fn(), resume: jest.fn() };
        const approvals = { decide: jest.fn() };
        const app = new InboxService(
            new InboxItemRepository(dataSource.getRepository(InboxItem)),
            runs as never,
            steering as never,
            approvals as never,
            undefined,
            undefined,
            undefined,
            publisher,
        );
        // A Gauzy approval that even names an Ever Works Task: still routes nowhere.
        const t = await task(ORG_A);
        const { item } = await asGauzy(() =>
            service.createExternal(
                writer(),
                input({
                    kind: 'approval',
                    title: 'Approve the expense?',
                    choices: [
                        { id: 'approve', label: 'Approve' },
                        { id: 'reject', label: 'Reject' },
                    ],
                    related: { taskId: t.id },
                }),
            ),
        );
        await asGauzy(() => service.updateExternal(writer(), item.dto.id, 1, { body: 'Edited in Gauzy' }));

        // The member answers in the Ever Works web Inbox (no X-Sync-Origin).
        const outcome = await app.reply(ADA, item.dto.id, { optionId: 'approve', text: 'Looks right' });
        expect(outcome.routed).toBe('none');
        expect(steering.steer).not.toHaveBeenCalled();
        expect(steering.resume).not.toHaveBeenCalled();
        expect(approvals.decide).not.toHaveBeenCalled();
        expect(runs.findByIdAndUser).not.toHaveBeenCalled();

        const recorded = await events();
        expect(recorded.map((event) => [event.type, event.originTag])).toEqual([
            ['inbox.item.created', ORIGIN],
            ['inbox.item.updated', ORIGIN],
            ['inbox.item.updated', null],
        ]);
        expect(recorded[2].data).toMatchObject({
            status: 'answered',
            answerOptionId: 'approve',
            answerText: 'Looks right',
            origin: 'integration',
            externalId: 'gauzy-inbox-1',
            version: 3,
        });
        for (const event of recorded) expectValidEvent(event);

        const relay = new DomainEventRelayService(
            dataSource,
            new DomainEventRetentionService(dataSource),
            new EventEmitter2(),
        );
        await relay.tick();
        await relay.stop();
        const feed = new DomainEventFeedService(dataSource);
        const read = (excludeOrigins: string[]) =>
            feed.readPage({
                organizationIds: [ORG_A],
                after: '0',
                excludeOrigins,
                grantedScopes: ['events:read', 'inbox:read'],
            });
        // Gauzy's own create and edit stay out; the member's answer comes through.
        const own = await read([ORIGIN]);
        expect(own.events.map((event) => [event.type, event.data.answerOptionId])).toEqual([
            ['inbox.item.updated', 'approve'],
        ]);
        expect(own.events[0].origin).toEqual({ tag: null, integrationKeyId: null });
        // Without the exclusion every write is served.
        expect((await read([])).events.map((event) => event.type)).toEqual([
            'inbox.item.created',
            'inbox.item.updated',
            'inbox.item.updated',
        ]);
    });
});
