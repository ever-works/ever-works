import { ConflictException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ResourceNotFoundError, VersionMismatchError } from '@ever-works/agent/integrations-api';
import { IntegrationHttpException } from '../../../auth/integration/integration-http.exception';
import {
    IntegrationCreateInboxItemDto,
    IntegrationInboxController,
    IntegrationUpdateInboxItemDto,
} from '../inbox.controller';

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
            // Works-security lane 3a — merge approvals need `merges:decide`; the
            // integration API gates lane — the other individual decisions need
            // `decisions:individual` (or `merges:decide`).
            decisionScopeOf: jest.fn().mockResolvedValue(null),
            recordRelayedDecision: jest.fn().mockResolvedValue(true),
            // Integration inbox push.
            createExternal: jest.fn(async () => ({
                item: {
                    dto: dto(1, { origin: 'integration' }),
                    etag: '"1"',
                    recipientUserId: RECIPIENT,
                },
                created: true,
            })),
            updateExternal: jest.fn(async () => ({
                dto: dto(3, { origin: 'integration' }),
                etag: '"3"',
                recipientUserId: RECIPIENT,
            })),
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
        for (const query of [{ status: 'closed' }, { kind: 'memo' }, { recipientUserId: 'ada' }]) {
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
            inbox.decisionScopeOf.mockResolvedValue('merge');
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
            inbox.decisionScopeOf.mockResolvedValue('merge');
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
            inbox.decisionScopeOf.mockResolvedValue('merge');
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

    // Works-security lane (integration API gates, finding 6) — the approvals the
    // platform never decides in bulk besides merges (an email-draft release, an
    // agent's identity-file edit, an agent-proposed escalation closure) are
    // relayed only by a key holding the opt-in `decisions:individual` scope (or
    // `merges:decide`). `inbox:write` + act-as (a header the key sets) is not enough.
    describe('individual-decision approvals', () => {
        const fileEditItem = () => ({
            dto: dto(1, { kind: 'approval', proposalId: 'file-edit-1' }),
            etag: '"1"',
            recipientUserId: RECIPIENT,
        });

        it('refuses an identity-file edit approval without decisions:individual (403) and decides nothing', async () => {
            const { controller, inbox, items } = setup();
            inbox.get.mockResolvedValue(fileEditItem());
            inbox.decisionScopeOf.mockResolvedValue('individual');
            const reply = controller.reply(
                as(RECIPIENT),
                'item-1',
                { optionId: 'approve' },
                req(),
                res(),
            );
            await expect(reply).rejects.toMatchObject({
                code: 'scope_missing',
                response: {
                    error: {
                        details: {
                            missing: ['decisions:individual'],
                            reason: 'individual_decision',
                        },
                    },
                },
            });
            expect(items.reply).not.toHaveBeenCalled();
            expect(inbox.recordRelayedDecision).not.toHaveBeenCalled();
        });

        it('relays it from a key holding decisions:individual, or merges:decide', async () => {
            for (const scope of ['decisions:individual', 'merges:decide']) {
                const { controller, inbox, items } = setup();
                inbox.get.mockResolvedValue(fileEditItem());
                inbox.decisionScopeOf.mockResolvedValue('individual');
                items.reply.mockResolvedValueOnce({
                    item: {},
                    routed: 'approved',
                    restart: 'none',
                } as never);
                await controller.reply(
                    as(RECIPIENT, [scope]),
                    'item-1',
                    { optionId: 'approve' },
                    req(),
                    res(),
                );
                expect(items.reply).toHaveBeenCalled();
                expect(inbox.recordRelayedDecision).toHaveBeenCalledWith(
                    'file-edit-1',
                    expect.objectContaining({ recipientUserId: RECIPIENT }),
                );
            }
        });

        it('decisions:individual does not stand in for merges:decide on a merge approval', async () => {
            const { controller, inbox, items } = setup();
            inbox.get.mockResolvedValue(fileEditItem());
            inbox.decisionScopeOf.mockResolvedValue('merge');
            await expect(
                controller.reply(
                    as(RECIPIENT, ['decisions:individual']),
                    'item-1',
                    { optionId: 'approve' },
                    req(),
                    res(),
                ),
            ).rejects.toMatchObject({ code: 'scope_missing' });
            expect(items.reply).not.toHaveBeenCalled();
        });

        it('an ordinary approval, a question or an escalation still needs inbox:write only', async () => {
            const { controller, inbox, items } = setup();
            inbox.decisionScopeOf.mockResolvedValue(null);
            await controller.reply(as(RECIPIENT), 'item-1', { text: 'go ahead' }, req(), res());
            expect(items.reply).toHaveBeenCalled();
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

    // ── integration inbox push (CR-15) ────────────────────────────────

    const createBody = {
        externalId: 'gauzy-1',
        recipientUserId: RECIPIENT,
        kind: 'notice',
        title: 'Timesheet approved',
        sourceUrl: 'https://app.gauzy.co/#/pages/inbox/1',
    };
    const createReq = (key?: string) => ({
        method: 'POST',
        originalUrl: '/api/integrations/v1/inbox/items',
        body: createBody,
        headers: key ? { 'idempotency-key': key } : {},
    });

    it('files the key’s own item in the pinned organization: 201 + ETag, the key as the writer', async () => {
        const { controller, inbox, idempotency } = setup();
        const response = res();
        const body = await controller.create(as(null), createBody, createReq(), response);
        expect(inbox.createExternal).toHaveBeenCalledWith(
            {
                organizationId: ORG,
                tenantId: 'tenant-1',
                integrationKeyId: 'key-1',
                defaultSourceLabel: 'Ever Gauzy',
            },
            expect.objectContaining({
                externalId: 'gauzy-1',
                recipientUserId: RECIPIENT,
                kind: 'notice',
            }),
        );
        expect(response.status).toHaveBeenCalledWith(201);
        expect(response.setHeader).toHaveBeenCalledWith('ETag', '"1"');
        expect(body).toMatchObject({ id: 'item-1', origin: 'integration' });
        expect(idempotency.run).not.toHaveBeenCalled();
    });

    it('a replayed externalId answers 200 with the existing item; an Idempotency-Key goes through the replay store', async () => {
        const { controller, inbox, idempotency } = setup();
        inbox.createExternal.mockResolvedValueOnce({
            item: { dto: dto(4), etag: '"4"', recipientUserId: RECIPIENT },
            created: false,
        });
        const replay = res();
        await expect(
            controller.create(as(null), createBody, createReq(), replay),
        ).resolves.toMatchObject({
            version: 4,
        });
        expect(replay.status).toHaveBeenCalledWith(200);

        const keyed = res();
        await controller.create(as(null), createBody, createReq('idem-7'), keyed);
        expect(idempotency.run).toHaveBeenCalledWith(
            expect.objectContaining({ integrationKeyId: 'key-1', idempotencyKey: 'idem-7' }),
            expect.any(Function),
        );
        expect(keyed.status).toHaveBeenCalledWith(201);
    });

    it('a generic key’s items default to the key name as their badge', async () => {
        const { controller, inbox } = setup();
        const generic = {
            userId: 'owner-1',
            authMethod: 'integration',
            integration: { ...principal(null), integrationKind: 'generic', keyName: 'Acme Sync' },
        } as never;
        await controller.create(generic, createBody, createReq(), res());
        expect(inbox.createExternal).toHaveBeenCalledWith(
            expect.objectContaining({ defaultSourceLabel: 'Acme Sync' }),
            expect.anything(),
        );
    });

    it('PATCH needs If-Match (400 without it) and passes the version and only the sent fields', async () => {
        const { controller, inbox } = setup();
        for (const ifMatch of [undefined, '*', '']) {
            await expect(
                controller.update(as(null), 'item-1', { title: 'x' }, ifMatch, res()),
            ).rejects.toMatchObject({ code: 'validation_failed' });
        }
        await expect(
            controller.update(as(null), 'item-1', { title: 'x' }, 'not-a-version', res()),
        ).rejects.toMatchObject({ code: 'validation_failed' });
        expect(inbox.updateExternal).not.toHaveBeenCalled();

        const response = res();
        const body = await controller.update(
            as(null),
            'item-1',
            { state: 'resolved', resolution: { choiceId: 'yes' } },
            '"2"',
            response,
        );
        expect(inbox.updateExternal).toHaveBeenCalledWith(
            expect.objectContaining({ organizationId: ORG, integrationKeyId: 'key-1' }),
            'item-1',
            2,
            { state: 'resolved', resolution: { choiceId: 'yes' } },
        );
        expect(body).toMatchObject({ version: 3 });
        expect(response.setHeader).toHaveBeenCalledWith('ETag', '"3"');
    });

    it('a stale If-Match (412) and someone else’s item (404) pass through from the service', async () => {
        const { controller, inbox } = setup();
        inbox.updateExternal.mockRejectedValueOnce(new VersionMismatchError(2, 5));
        await expect(
            controller.update(as(null), 'item-1', { title: 'x' }, '"2"', res()),
        ).rejects.toBeInstanceOf(VersionMismatchError);
        inbox.updateExternal.mockRejectedValueOnce(
            new ResourceNotFoundError('inbox_item', 'item-1'),
        );
        await expect(
            controller.update(as(null), 'item-1', { title: 'x' }, '"2"', res()),
        ).rejects.toBeInstanceOf(ResourceNotFoundError);
    });
});

/**
 * The create / update bodies under the global ValidationPipe's rules
 * (`whitelist` + `forbidNonWhitelisted` + `transform`): each refusal is a
 * gate that answers `400 validation_failed` before the route runs.
 */
describe('integration inbox push request bodies', () => {
    const RECIPIENT = '2b6d4e8f-0a3c-4d5e-9f71-8b9c0d1e2f30';
    const valid = {
        externalId: 'gauzy-1',
        recipientUserId: RECIPIENT,
        kind: 'question',
        title: 'Approve the leave request?',
        body: '**Ada** asked for 3 days off.',
        sourceUrl: 'https://app.gauzy.co/#/pages/inbox/1',
        sourceLabel: 'Ever Gauzy',
        related: { taskId: '3c7e5f90-1b4d-4e6f-8a82-9c0d1e2f3a41' },
        choices: [
            { id: 'yes', label: 'Approve' },
            { id: 'no', label: 'Decline' },
        ],
        occurredAt: '2026-10-28T09:00:00.000Z',
    };
    const errorsOf = async (cls: new () => object, body: Record<string, unknown>) =>
        validate(plainToInstance(cls, body), { whitelist: true, forbidNonWhitelisted: true });
    const properties = async (cls: new () => object, body: Record<string, unknown>) =>
        (await errorsOf(cls, body)).map((error) => error.property);

    it('accepts a full create body and a full email body', async () => {
        expect(await errorsOf(IntegrationCreateInboxItemDto, valid)).toEqual([]);
        expect(
            await errorsOf(IntegrationCreateInboxItemDto, {
                ...valid,
                kind: 'email',
                choices: undefined,
                email: {
                    from: 'Billing <billing@example.com>',
                    to: 'ada@example.com',
                    subject: 'Invoice #42',
                    receivedAt: '2026-10-28T09:00:00Z',
                },
            }),
        ).toEqual([]);
    });

    it('GATE http sourceUrl: refuses http, javascript:, data:, relative and credentialed URLs', async () => {
        for (const sourceUrl of [
            'http://app.gauzy.co/inbox/1',
            'javascript:alert(1)',
            'data:text/html,<b>x</b>',
            '/pages/inbox/1',
            'https://user:pass@app.gauzy.co/',
            `https://app.gauzy.co/${'a'.repeat(2000)}`,
        ]) {
            expect([
                sourceUrl,
                await properties(IntegrationCreateInboxItemDto, { ...valid, sourceUrl }),
            ]).toEqual([sourceUrl, ['sourceUrl']]);
        }
    });

    it('GATE oversize body: 20 000 characters pass, 20 001 are refused', async () => {
        expect(
            await properties(IntegrationCreateInboxItemDto, { ...valid, body: 'x'.repeat(20_000) }),
        ).toEqual([]);
        expect(
            await properties(IntegrationCreateInboxItemDto, { ...valid, body: 'x'.repeat(20_001) }),
        ).toEqual(['body']);
        expect(
            await properties(IntegrationUpdateInboxItemDto, { body: 'x'.repeat(20_001) }),
        ).toEqual(['body']);
    });

    it('refuses the other caps, an unknown kind or property, and a bad nested value', async () => {
        const cases: Array<[Record<string, unknown>, string]> = [
            [{ externalId: 'x'.repeat(129) }, 'externalId'],
            [{ externalId: '' }, 'externalId'],
            [{ recipientUserId: 'ada' }, 'recipientUserId'],
            [{ kind: 'escalation' }, 'kind'],
            [{ title: 'x'.repeat(301) }, 'title'],
            [{ sourceLabel: 'x'.repeat(81) }, 'sourceLabel'],
            [{ occurredAt: 'yesterday' }, 'occurredAt'],
            [{ related: { taskId: 'not-a-uuid' } }, 'related'],
            [{ related: { projectId: '3c7e5f90-1b4d-4e6f-8a82-9c0d1e2f3a41' } }, 'related'],
            [
                { choices: Array.from({ length: 11 }, (_, i) => ({ id: `c${i}`, label: 'C' })) },
                'choices',
            ],
            [{ choices: [{ id: 'x'.repeat(65), label: 'A' }] }, 'choices'],
            [{ email: { from: 'a@b.c', subject: 'S', receivedAt: 'soon' } }, 'email'],
            [{ html: '<script>alert(1)</script>' }, 'html'],
        ];
        for (const [patch, property] of cases) {
            expect([
                patch,
                await properties(IntegrationCreateInboxItemDto, { ...valid, ...patch }),
            ]).toEqual([patch, [property]]);
        }
        expect(await properties(IntegrationUpdateInboxItemDto, { state: 'closed' })).toEqual([
            'state',
        ]);
        expect(await properties(IntegrationUpdateInboxItemDto, { title: null })).toEqual(['title']);
    });
});
