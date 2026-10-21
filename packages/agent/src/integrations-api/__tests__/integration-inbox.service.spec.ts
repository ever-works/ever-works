import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import {
    contractValidator,
    createDomainEventsDataSource,
    ORG_A,
    ORG_B,
} from '../../domain-events/__tests__/domain-events.test-helpers';
import { InboxItem } from '../../entities/inbox-item.entity';
import { ResourceNotFoundError } from '../integration-api.errors';
import { IntegrationInboxService } from '../integration-inbox.service';

/**
 * Integration API v1 inbox reads (EW-P3-1) on SQLite: every recipient's
 * messages of the pinned organization, never a personal-scope message or
 * another organization's, keyset-paged by `(updatedAt, id)`, filtered by
 * recipient / status / kind, archived only on request, and every DTO valid
 * against the published `inbox-item.schema.json`.
 */
describe('IntegrationInboxService', () => {
    let dataSource: DataSource;
    let inbox: IntegrationInboxService;
    const expectValid = contractValidator();
    const ADA = randomUUID();
    const BOB = randomUUID();

    beforeAll(async () => {
        dataSource = await createDomainEventsDataSource();
        inbox = new IntegrationInboxService(dataSource);
    });

    beforeEach(async () => {
        await dataSource.query(`DELETE FROM "inbox_items"`);
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    const item = (
        userId: string,
        organizationId: string | null,
        extra: Partial<InboxItem> = {},
    ): Promise<InboxItem> =>
        dataSource.getRepository(InboxItem).save({
            userId,
            organizationId,
            kind: 'question',
            title: 'Which tier?',
            body: 'Which tier should the page lead with?',
            options: [
                { id: 'pro', label: 'Pro', recommended: true },
                { id: 'team', label: 'Team' },
            ],
            sourceType: 'agent-run',
            // Fleet provenance: must never reach an integration.
            sourceMeta: { nodeId: 'node-1', nodeName: 'EVERDESK', branch: 'feat/x' },
            status: 'open',
            unread: true,
            ...extra,
        } as unknown as InboxItem);

    it("lists every recipient's messages of the pinned organization, never personal-scope or another organization's", async () => {
        const ada = await item(ADA, ORG_A);
        const bob = await item(BOB, ORG_A, { kind: 'notice', options: null, sourceType: 'system' });
        await item(ADA, null);
        await item(BOB, ORG_B);
        const page = await inbox.list(ORG_A, {});
        expect(page.data.map((dto) => dto.id).sort()).toEqual([ada.id, bob.id].sort());
        expect(page).toMatchObject({ hasMore: false, nextCursor: null });
        for (const dto of page.data) {
            expectValid('resources/inbox-item.schema.json', dto);
            expect(dto).not.toHaveProperty('sourceMeta');
        }
        const adas = page.data.find((dto) => dto.id === ada.id)!;
        expect(adas).toMatchObject({ recipientUserId: ADA, kind: 'question', version: 1 });
    });

    it('filters by recipient, status and kind; archived messages only when asked', async () => {
        const open = await item(ADA, ORG_A);
        const answered = await item(ADA, ORG_A, {
            status: 'answered',
            unread: false,
            answeredAt: new Date(),
            answerOptionId: 'pro',
        });
        const archived = await item(ADA, ORG_A, { status: 'archived' });
        const notice = await item(BOB, ORG_A, { kind: 'notice', options: null });

        const ids = async (query: Parameters<IntegrationInboxService['list']>[1]) =>
            (await inbox.list(ORG_A, query)).data.map((dto) => dto.id).sort();

        expect(await ids({ recipientUserId: ADA })).toEqual([open.id, answered.id].sort());
        expect(await ids({ recipientUserId: ADA, includeArchived: true })).toEqual(
            [open.id, answered.id, archived.id].sort(),
        );
        expect(await ids({ statuses: ['archived'] })).toEqual([archived.id]);
        expect(await ids({ statuses: ['open', 'answered'] })).toEqual(
            [open.id, answered.id, notice.id].sort(),
        );
        expect(await ids({ kinds: ['notice'] })).toEqual([notice.id]);
    });

    it('pages with a cursor and filters by updatedSince', async () => {
        const created: InboxItem[] = [];
        for (let i = 0; i < 3; i++) created.push(await item(ADA, ORG_A, { title: `Q${i}` }));
        const first = await inbox.list(ORG_A, { limit: 2 });
        expect(first.data).toHaveLength(2);
        expect(first.hasMore).toBe(true);
        const second = await inbox.list(ORG_A, { limit: 2, cursor: first.nextCursor });
        expect(second.hasMore).toBe(false);
        expect([...first.data, ...second.data].map((dto) => dto.id).sort()).toEqual(
            created.map((row) => row.id).sort(),
        );
        const later = await inbox.list(ORG_A, { updatedSince: new Date(Date.now() + 60_000) });
        expect(later.data).toEqual([]);
    });

    it('gets one message with its ETag and recipient, and 404s outside the organization', async () => {
        const mine = await item(ADA, ORG_A);
        const other = await item(ADA, ORG_B);
        const personal = await item(ADA, null);
        const got = await inbox.get(ORG_A, mine.id);
        expect(got.etag).toBe('"1"');
        expect(got.recipientUserId).toBe(ADA);
        expect(got.dto).toMatchObject({ id: mine.id, recipientUserId: ADA, status: 'open' });
        expectValid('resources/inbox-item.schema.json', got.dto);
        for (const id of [other.id, personal.id, randomUUID()]) {
            await expect(inbox.get(ORG_A, id)).rejects.toBeInstanceOf(ResourceNotFoundError);
        }
    });
});

/**
 * Works-security lane 3a (2026-10-18) — the two helpers behind the relayed
 * MERGE decision rule: which approvals are merges (relayed only with the
 * `merges:decide` scope), and the provenance stamp on the decided proposal.
 */
describe('IntegrationInboxService — merge approvals and relay provenance', () => {
    function fake(row: Record<string, unknown> | null | Error) {
        const repo = {
            findOne:
                row instanceof Error
                    ? jest.fn().mockRejectedValue(row)
                    : jest.fn().mockResolvedValue(row),
            update: jest.fn().mockResolvedValue({ affected: 1 }),
        };
        const service = new IntegrationInboxService({ getRepository: () => repo } as never);
        return { repo, service };
    }

    it('counts only a merge_pull_request approval as a merge', async () => {
        const merge = fake({ id: 'p1', actionType: 'merge_pull_request' });
        await expect(
            merge.service.isMergeApproval({ kind: 'approval', proposalId: 'p1' }),
        ).resolves.toBe(true);
        const spawn = fake({ id: 'p2', actionType: 'spawn_agent' });
        await expect(
            spawn.service.isMergeApproval({ kind: 'approval', proposalId: 'p2' }),
        ).resolves.toBe(false);
    });

    it('never treats a question, an escalation or an approval without a proposal as a merge', async () => {
        const { service, repo } = fake({ id: 'p1', actionType: 'merge_pull_request' });
        await expect(service.isMergeApproval({ kind: 'question', proposalId: 'p1' })).resolves.toBe(
            false,
        );
        await expect(
            service.isMergeApproval({ kind: 'escalation', proposalId: null }),
        ).resolves.toBe(false);
        await expect(service.isMergeApproval({ kind: 'approval', proposalId: null })).resolves.toBe(
            false,
        );
        expect(repo.findOne).not.toHaveBeenCalled();
    });

    it('fails closed: a missing or unreadable proposal counts as a merge', async () => {
        await expect(
            fake(null).service.isMergeApproval({ kind: 'approval', proposalId: 'gone' }),
        ).resolves.toBe(true);
        await expect(
            fake(new Error('db down')).service.isMergeApproval({
                kind: 'approval',
                proposalId: 'p1',
            }),
        ).resolves.toBe(true);
    });

    it('stamps payload.decisionRelay on a proposal this recipient decided, keeping the payload', async () => {
        const { service, repo } = fake({
            id: 'p1',
            status: 'approved',
            decidedById: 'ada',
            payload: { prNumber: 7 },
        });
        const now = new Date('2026-10-18T12:00:00.000Z');
        await expect(
            service.recordRelayedDecision(
                'p1',
                {
                    recipientUserId: 'ada',
                    integrationKeyId: 'key-1',
                    integrationKind: 'ever-gauzy',
                },
                now,
            ),
        ).resolves.toBe(true);
        expect(repo.update).toHaveBeenCalledWith(
            { id: 'p1' },
            {
                payload: {
                    prNumber: 7,
                    decisionRelay: {
                        via: 'integration',
                        integrationKeyId: 'key-1',
                        integrationKind: 'ever-gauzy',
                        recordedAt: '2026-10-18T12:00:00.000Z',
                    },
                },
            },
        );
    });

    it('never stamps a pending proposal or somebody else’s decision', async () => {
        const relay = {
            recipientUserId: 'ada',
            integrationKeyId: 'key-1',
            integrationKind: 'generic',
        };
        const pending = fake({ id: 'p1', status: 'pending', decidedById: null, payload: {} });
        await expect(pending.service.recordRelayedDecision('p1', relay)).resolves.toBe(false);
        const other = fake({ id: 'p1', status: 'approved', decidedById: 'bob', payload: {} });
        await expect(other.service.recordRelayedDecision('p1', relay)).resolves.toBe(false);
        expect(pending.repo.update).not.toHaveBeenCalled();
        expect(other.repo.update).not.toHaveBeenCalled();
    });
});
