import { ConflictException } from '@nestjs/common';
import { ResourceNotFoundError, VersionMismatchError } from '@ever-works/agent/integrations-api';
import { IntegrationHttpException } from '../../../auth/integration/integration-http.exception';
import { IntegrationInboxController } from '../inbox.controller';

/**
 * The Inbox of `/api/integrations/v1` (EW-P3-1) over doubles of the services:
 * reads of the pinned organization, the closed filters, and the rule that a
 * reply or a state change acts AS the recipient only (X-Act-As-User =
 * recipientUserId), through the app's own `InboxService`.
 */
describe('IntegrationInboxController', () => {
    const ORG = 'org-1';
    const RECIPIENT = '2b6d4e8f-0a3c-4d5e-9f71-8b9c0d1e2f30';
    const OTHER = '3c7e5f90-1b4d-4e6f-8a82-9c0d1e2f3a41';
    const principal = (actAsUserId: string | null, extraScopes: string[] = []) => ({
        keyId: 'key-1',
        keyName: 'Gauzy',
        integrationKind: 'ever-gauzy',
        tenantId: 'tenant-1',
        allowedOrganizationIds: [ORG],
        scopes: ['inbox:read', 'inbox:write', ...extraScopes],
        ownerUserId: 'owner-1',
        actAsUserId,
    });
    const as = (actAsUserId: string | null, extraScopes: string[] = []) =>
        ({
            userId: actAsUserId ?? 'owner-1',
            authMethod: 'integration',
            integration: principal(actAsUserId, extraScopes),
        }) as never;
    const dto = (version = 1, extra: Record<string, unknown> = {}) => ({
        id: 'item-1',
        recipientUserId: RECIPIENT,
        status: 'open',
        unread: true,
        version,
        ...extra,
    });
    const res = () => ({ status: jest.fn(), setHeader: jest.fn() });
    const req = (key?: string) => ({
        method: 'POST',
        originalUrl: '/api/integrations/v1/inbox/items/item-1/reply',
        body: {},
        headers: key ? { 'idempotency-key': key } : {},
    });

    const setup = () => {
        let version = 1;
        const inbox = {
            list: jest.fn().mockResolvedValue({ data: [], nextCursor: null, hasMore: false }),
            get: jest.fn(async () => ({
                dto: dto(version),
                etag: `"${version}"`,
                recipientUserId: RECIPIENT,
            })),
            // Works-security lane 3a — merge approvals need `merges:decide`.
            isMergeApproval: jest.fn().mockResolvedValue(false),
            recordRelayedDecision: jest.fn().mockResolvedValue(true),
        };
        const items = {
            reply: jest.fn(async () => {
                version += 1;
                return { item: {}, routed: 'resumed', restart: 'resumed', runId: 'run-2' };
            }),
            setUnread: jest.fn(async () => {
                version += 1;
            }),
            setArchived: jest.fn(async () => {
                version += 1;
            }),
        };
        const idempotency = {
            run: jest.fn(
                async (
                    _input: unknown,
                    work: () => Promise<{ status: number; body: unknown }>,
                ) => ({
                    ...(await work()),
                    replayed: false,
                }),
            ),
        };
        const scope = { getScope: () => ({ tenantId: 'tenant-1', organizationId: ORG }) };
        const controller = new IntegrationInboxController(
            inbox as never,
            items as never,
            idempotency as never,
            scope as never,
        );
        return { controller, inbox, items, idempotency };
    };

    it('lists the pinned organization with the parsed filters', async () => {
        const { controller, inbox } = setup();
        await controller.list({
            recipientUserId: RECIPIENT,
            status: 'open,answered',
            kind: ['question'],
            includeArchived: 'true',
            limit: '50',
        });
        expect(inbox.list).toHaveBeenCalledWith(ORG, {
            recipientUserId: RECIPIENT,
            statuses: ['open', 'answered'],
            kinds: ['question'],
            includeArchived: true,
            updatedSince: null,
            cursor: null,
            limit: 50,
        });
    });

    it('refuses an unknown status / kind and a non-UUID recipient (400 validation_failed)', async () => {
        const { controller } = setup();
        for (const query of [{ status: 'closed' }, { kind: 'email' }, { recipientUserId: 'ada' }]) {
            await expect(controller.list(query)).rejects.toMatchObject({
                code: 'validation_failed',
            });
        }
    });

    it('gets one message with its ETag', async () => {
        const { controller } = setup();
        const response = res();
        await expect(controller.get('item-1', response)).resolves.toMatchObject({ id: 'item-1' });
        expect(response.setHeader).toHaveBeenCalledWith('ETag', '"1"');
    });

    it('replies AS the recipient through InboxService.reply and answers {item, routed, restart, runId}', async () => {
        const { controller, items, idempotency } = setup();
        const body = await controller.reply(
            as(RECIPIENT),
            'item-1',
            { optionId: 'pro', text: 'Lead with Pro' },
            req(),
            res(),
        );
        expect(items.reply).toHaveBeenCalledWith(RECIPIENT, 'item-1', {
            text: 'Lead with Pro',
            optionId: 'pro',
        });
        expect(body).toEqual({
            item: dto(2),
            routed: 'resumed',
            restart: 'resumed',
            runId: 'run-2',
        });
        // No Idempotency-Key: run directly.
        expect(idempotency.run).not.toHaveBeenCalled();
    });

    it('replays a reply under its optional Idempotency-Key', async () => {
        const { controller, idempotency } = setup();
        await controller.reply(as(RECIPIENT), 'item-1', { text: 'Yes' }, req('idem-1'), res());
        expect(idempotency.run).toHaveBeenCalledWith(
            expect.objectContaining({ integrationKeyId: 'key-1', idempotencyKey: 'idem-1' }),
            expect.any(Function),
        );
    });

    it('refuses a reply or state change without act-as, or acting as anybody but the recipient (403 act_as_forbidden)', async () => {
        const { controller, items } = setup();
        for (const user of [as(null), as(OTHER)]) {
            const reply = controller.reply(user, 'item-1', { text: 'x' }, req(), res());
            await expect(reply).rejects.toBeInstanceOf(IntegrationHttpException);
            await expect(reply).rejects.toMatchObject({ code: 'act_as_forbidden' });
            await expect(
                controller.state(user, 'item-1', { archived: true }, undefined, res()),
            ).rejects.toMatchObject({ code: 'act_as_forbidden' });
        }
        expect(items.reply).not.toHaveBeenCalled();
        expect(items.setArchived).not.toHaveBeenCalled();
    });

    it('a message outside the pinned organization is 404 before any act-as check', async () => {
        const { controller, inbox, items } = setup();
        inbox.get.mockRejectedValueOnce(new ResourceNotFoundError('inbox_item', 'item-9'));
        await expect(
            controller.reply(as(OTHER), 'item-9', { text: 'x' }, req(), res()),
        ).rejects.toBeInstanceOf(ResourceNotFoundError);
        expect(items.reply).not.toHaveBeenCalled();
    });

    // Works-security lane 3a — approval and escalation replies stay open to an
    // integration: the reply is the recipient's own decision relayed by it (Ever
    // Gauzy forwards what the person answered in the Gauzy Inbox), and acting as
    // anybody but the recipient is still refused (`act_as_forbidden` above).
    it.each([['approval'], ['escalation']])(
        "relays the recipient's answer to an %s through InboxService.reply",
        async (kind) => {
            const { controller, inbox, items } = setup();
            inbox.get.mockResolvedValue({
                dto: dto(1, { kind, proposalId: kind === 'approval' ? 'prop-1' : null }),
                etag: '"1"',
                recipientUserId: RECIPIENT,
            });
            items.reply.mockResolvedValueOnce({
                item: {},
                routed: kind === 'approval' ? 'approved' : 'escalation-resolved',
                restart: 'none',
            } as never);
            await controller.reply(as(RECIPIENT), 'item-1', { optionId: 'approve' }, req(), res());
            expect(items.reply).toHaveBeenCalledWith(RECIPIENT, 'item-1', {
                text: null,
                optionId: 'approve',
            });
            // A non-merge approval is relayed with `inbox:write` alone, and the
            // decided proposal records that an integration relayed it.
            if (kind === 'approval') {
                expect(inbox.recordRelayedDecision).toHaveBeenCalledWith('prop-1', {
                    recipientUserId: RECIPIENT,
                    integrationKeyId: 'key-1',
                    integrationKind: 'ever-gauzy',
                });
            } else {
                expect(inbox.recordRelayedDecision).not.toHaveBeenCalled();
            }
        },
    );

    // Works-security lane 3a — a MERGE approval (an agent's pull request
    // landing on a real branch, a promotion, a revert) is relayed only by a key
    // holding the separate, opt-in `merges:decide` scope.
    describe('merge approvals', () => {
        const mergeItem = () => ({
            dto: dto(1, { kind: 'approval', proposalId: 'merge-1' }),
            etag: '"1"',
            recipientUserId: RECIPIENT,
        });

        it('refuses a merge decision without merges:decide (403 scope_missing) and leaves it pending', async () => {
            const { controller, inbox, items } = setup();
            inbox.get.mockResolvedValue(mergeItem());
            inbox.isMergeApproval.mockResolvedValue(true);
            const reply = controller.reply(
                as(RECIPIENT),
                'item-1',
                { optionId: 'approve' },
                req(),
                res(),
            );
            await expect(reply).rejects.toBeInstanceOf(IntegrationHttpException);
            await expect(reply).rejects.toMatchObject({
                code: 'scope_missing',
                response: {
                    error: { details: { missing: ['merges:decide'], reason: 'merge_decision' } },
                },
            });
            // The message names the scope, and nothing was decided or recorded.
            await expect(reply).rejects.toMatchObject({
                response: { error: { message: expect.stringContaining("'merges:decide' scope") } },
            });
            expect(items.reply).not.toHaveBeenCalled();
            expect(inbox.recordRelayedDecision).not.toHaveBeenCalled();
        });

        it('relays a merge decision from a key that holds merges:decide, and records the relay', async () => {
            const { controller, inbox, items } = setup();
            inbox.get.mockResolvedValue(mergeItem());
            inbox.isMergeApproval.mockResolvedValue(true);
            items.reply.mockResolvedValueOnce({
                item: {},
                routed: 'approved',
                restart: 'none',
            } as never);
            await controller.reply(
                as(RECIPIENT, ['merges:decide']),
                'item-1',
                { optionId: 'approve' },
                req(),
                res(),
            );
            expect(items.reply).toHaveBeenCalledWith(RECIPIENT, 'item-1', {
                text: null,
                optionId: 'approve',
            });
            expect(inbox.recordRelayedDecision).toHaveBeenCalledWith('merge-1', {
                recipientUserId: RECIPIENT,
                integrationKeyId: 'key-1',
                integrationKind: 'ever-gauzy',
            });
        });

        it('still requires act-as = the recipient before the scope is even considered', async () => {
            const { controller, inbox, items } = setup();
            inbox.get.mockResolvedValue(mergeItem());
            inbox.isMergeApproval.mockResolvedValue(true);
            await expect(
                controller.reply(
                    as(OTHER, ['merges:decide']),
                    'item-1',
                    { optionId: 'approve' },
                    req(),
                    res(),
                ),
            ).rejects.toMatchObject({ code: 'act_as_forbidden' });
            expect(items.reply).not.toHaveBeenCalled();
        });
    });

    it('passes an already-answered 409 through', async () => {
        const { controller, items } = setup();
        items.reply.mockRejectedValueOnce(new ConflictException('already answered'));
        await expect(
            controller.reply(as(RECIPIENT), 'item-1', { text: 'x' }, req(), res()),
        ).rejects.toBeInstanceOf(ConflictException);
    });

    it('changes state AS the recipient (archive, then read) and answers the fresh DTO + ETag', async () => {
        const { controller, items } = setup();
        const response = res();
        const body = await controller.state(
            as(RECIPIENT),
            'item-1',
            { unread: false, archived: true },
            '"1"',
            response,
        );
        expect(items.setArchived).toHaveBeenCalledWith('item-1', RECIPIENT, true);
        expect(items.setUnread).toHaveBeenCalledWith('item-1', RECIPIENT, false);
        expect(body).toMatchObject({ version: 3 });
        expect(response.setHeader).toHaveBeenCalledWith('ETag', '"3"');
    });

    it('refuses an empty state change (400) and a stale If-Match (412)', async () => {
        const { controller, items } = setup();
        await expect(
            controller.state(as(RECIPIENT), 'item-1', {}, undefined, res()),
        ).rejects.toMatchObject({ code: 'validation_failed' });
        await expect(
            controller.state(as(RECIPIENT), 'item-1', { unread: false }, '"7"', res()),
        ).rejects.toBeInstanceOf(VersionMismatchError);
        expect(items.setUnread).not.toHaveBeenCalled();
    });
});
