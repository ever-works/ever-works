import { createHmac } from 'node:crypto';
import {
    BadRequestException,
    ConflictException,
    NotFoundException,
    UnauthorizedException,
} from '@nestjs/common';
import { InboundTriggersService } from '../inbound-triggers.service';
import { ROTATION_GRACE_MS } from '../inbound-trigger.types';
import { WebhookSubscriptionSecretService } from '../../services/webhook-subscription-secret.service';
import type { InboundTrigger } from '../../entities/inbound-trigger.entity';

/**
 * Unit spec for the Inbound Triggers service. Uses the REAL
 * `WebhookSubscriptionSecretService` — under NODE_ENV=test with no
 * PLATFORM_ENCRYPTION_KEY it passes plaintext through, so the HMAC
 * verification path exercises real crypto against the exact stored
 * secret (the documented dev/test behavior).
 */

const SCOPE = { userId: 'user-1', organizationId: null };
const ORG_SCOPE = { userId: 'user-1', organizationId: 'org-1' };

function makeRepo() {
    const rows = new Map<string, InboundTrigger>();
    let seq = 0;
    return {
        _rows: rows,
        create: jest.fn((partial: Partial<InboundTrigger>) => ({ ...partial })),
        save: jest.fn(async (row: Partial<InboundTrigger>) => {
            const id = row.id ?? `trigger-${++seq}`;
            const saved = {
                createdAt: new Date('2026-07-19T00:00:00.000Z'),
                updatedAt: new Date('2026-07-19T00:00:00.000Z'),
                ...row,
                id,
            } as InboundTrigger;
            rows.set(id, saved);
            return saved;
        }),
        find: jest.fn(async () => [...rows.values()]),
        findOne: jest.fn(async ({ where }: { where: { id: string } }) => {
            return rows.get(where.id) ?? null;
        }),
        update: jest.fn(async (id: string, patch: Record<string, unknown>) => {
            const row = rows.get(id) as unknown as Record<string, unknown> | undefined;
            if (!row) return;
            for (const [key, value] of Object.entries(patch)) {
                // A function value is a TypeORM raw expression — the service
                // uses only `"fireCount" + 1`, so model it as a +1 increment.
                row[key] = typeof value === 'function' ? ((row[key] as number) ?? 0) + 1 : value;
            }
        }),
        increment: jest.fn(async ({ id }: { id: string }, field: 'fireCount', by: number) => {
            const row = rows.get(id);
            if (row) row.fireCount = (row.fireCount ?? 0) + by;
        }),
        delete: jest.fn(async (id: string) => {
            rows.delete(id);
        }),
    };
}

function makeTasks() {
    return {
        create: jest.fn(async (_userId: string, input: { title: string }) => ({
            id: 'task-1',
            slug: 'T-1',
            title: input.title,
        })),
        addAssignee: jest.fn(async () => ({ id: 'assignee-1' })),
    };
}

function makeAgents(known: string[] = ['agent-1']) {
    return {
        findByIdAndUser: jest.fn(async (agentId: string, _userId: string) =>
            known.includes(agentId) ? { id: agentId } : null,
        ),
    };
}

function sign(secret: string, timestamp: string, body: string): string {
    return createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex');
}

function nowSeconds(): string {
    return String(Math.floor(Date.now() / 1000));
}

function makeService(overrides: { agents?: ReturnType<typeof makeAgents> } = {}) {
    const repo = makeRepo();
    const tasks = makeTasks();
    const agents = overrides.agents ?? makeAgents();
    const secrets = new WebhookSubscriptionSecretService();
    // Silence the one-time plaintext-passthrough warning in test output.
    jest.spyOn(
        (secrets as unknown as { logger: { warn: (msg: string) => void } }).logger,
        'warn',
    ).mockImplementation(() => undefined);
    const service = new InboundTriggersService(
        repo as never,
        secrets,
        tasks as never,
        agents as never,
    );
    return { service, repo, tasks, agents };
}

describe('InboundTriggersService', () => {
    const ORIGINAL_KEY = process.env.PLATFORM_ENCRYPTION_KEY;

    beforeEach(() => {
        // Force the documented plaintext passthrough so signatures can be
        // computed from the returned raw secret without envelope logic.
        delete process.env.PLATFORM_ENCRYPTION_KEY;
    });

    afterEach(() => {
        if (ORIGINAL_KEY === undefined) {
            delete process.env.PLATFORM_ENCRYPTION_KEY;
        } else {
            process.env.PLATFORM_ENCRYPTION_KEY = ORIGINAL_KEY;
        }
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    describe('create', () => {
        it('returns the plaintext secret once and persists it encrypted-at-rest (envelope in row, never in view)', async () => {
            const { service, repo } = makeService();
            const { trigger, secret } = await service.create(SCOPE, { name: 'CRM hook' });

            expect(secret).toHaveLength(43); // 32 random bytes, base64url
            expect(trigger.status).toBe('active');
            expect(trigger.fireCount).toBe(0);
            // The view never carries secret material.
            expect(JSON.stringify(trigger)).not.toContain(secret);
            // The row stores the (test-env passthrough) envelope, not a view field.
            const row = repo._rows.get(trigger.id) as InboundTrigger;
            expect(row.secretEncrypted).toBe(secret);
            expect(row.previousSecretEncrypted).toBeNull();
        });

        it('rejects a target agent that is not reachable for the caller (400)', async () => {
            const { service } = makeService({ agents: makeAgents([]) });
            await expect(
                service.create(SCOPE, { name: 'X', targetAgentId: 'agent-foreign' }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });
    });

    describe('fire', () => {
        it('happy path: verified fire spawns a Task, assigns the agent, bumps counters', async () => {
            const { service, repo, tasks } = makeService();
            const { trigger, secret } = await service.create(SCOPE, {
                name: 'CRM hook',
                targetAgentId: 'agent-1',
                taskTitleTemplate: 'Lead in: {name}',
            });

            const body = JSON.stringify({ lead: 'ada@example.com' });
            const ts = nowSeconds();
            const result = await service.fire(trigger.id, {
                rawBody: body,
                signatureHeader: sign(secret, ts, body),
                timestampHeader: ts,
                contentType: 'application/json',
            });

            expect(result).toEqual({ ok: true, taskId: 'task-1', taskSlug: 'T-1' });
            expect(tasks.create).toHaveBeenCalledWith(
                'user-1',
                expect.objectContaining({
                    title: 'Lead in: CRM hook',
                    createdByType: 'user',
                    createdById: 'user-1',
                    description: expect.stringContaining('ada@example.com'),
                }),
            );
            expect(tasks.addAssignee).toHaveBeenCalledWith('user-1', 'task-1', 'agent', 'agent-1');
            const row = repo._rows.get(trigger.id) as InboundTrigger;
            expect(row.fireCount).toBe(1);
            expect(row.lastFiredAt).toBeInstanceOf(Date);
        });

        it('accepts a sha256=-prefixed signature and defaults the task title template', async () => {
            const { service, tasks } = makeService();
            const { trigger, secret } = await service.create(SCOPE, { name: 'Plain hook' });

            const body = '{"ok":true}';
            const ts = nowSeconds();
            await service.fire(trigger.id, {
                rawBody: body,
                signatureHeader: `sha256=${sign(secret, ts, body)}`,
                timestampHeader: ts,
                contentType: 'application/json',
            });
            expect(tasks.create).toHaveBeenCalledWith(
                'user-1',
                expect.objectContaining({ title: 'Trigger: Plain hook' }),
            );
        });

        it('401s on a bad signature without creating a Task', async () => {
            const { service, tasks } = makeService();
            const { trigger } = await service.create(SCOPE, { name: 'X' });

            const ts = nowSeconds();
            await expect(
                service.fire(trigger.id, {
                    rawBody: '{}',
                    signatureHeader: sign('wrong-secret', ts, '{}'),
                    timestampHeader: ts,
                    contentType: 'application/json',
                }),
            ).rejects.toBeInstanceOf(UnauthorizedException);
            expect(tasks.create).not.toHaveBeenCalled();
        });

        it('401s on a stale timestamp even with a valid signature (replay window)', async () => {
            const { service, tasks } = makeService();
            const { trigger, secret } = await service.create(SCOPE, { name: 'X' });

            const stale = String(Math.floor(Date.now() / 1000) - 6 * 60); // 6 min ago
            await expect(
                service.fire(trigger.id, {
                    rawBody: '{}',
                    signatureHeader: sign(secret, stale, '{}'),
                    timestampHeader: stale,
                    contentType: 'application/json',
                }),
            ).rejects.toBeInstanceOf(UnauthorizedException);
            expect(tasks.create).not.toHaveBeenCalled();
        });

        it('401s on a missing/garbage timestamp header', async () => {
            const { service } = makeService();
            const { trigger, secret } = await service.create(SCOPE, { name: 'X' });
            await expect(
                service.fire(trigger.id, {
                    rawBody: '{}',
                    signatureHeader: sign(secret, 'not-a-number', '{}'),
                    timestampHeader: 'not-a-number',
                    contentType: 'application/json',
                }),
            ).rejects.toBeInstanceOf(UnauthorizedException);
        });

        it('accepts the previous secret within the rotation grace window', async () => {
            const { service } = makeService();
            const { trigger, secret: oldSecret } = await service.create(SCOPE, { name: 'X' });
            await service.rotateSecret(SCOPE, trigger.id);

            const body = '{}';
            const ts = nowSeconds();
            const result = await service.fire(trigger.id, {
                rawBody: body,
                signatureHeader: sign(oldSecret, ts, body),
                timestampHeader: ts,
                contentType: 'application/json',
            });
            expect(result.ok).toBe(true);
        });

        it('rejects the previous secret after the grace window expires', async () => {
            const { service, repo } = makeService();
            const { trigger, secret: oldSecret } = await service.create(SCOPE, { name: 'X' });
            await service.rotateSecret(SCOPE, trigger.id);
            // Age the rotation past the 24h grace.
            const row = repo._rows.get(trigger.id) as InboundTrigger;
            row.rotatedAt = new Date(Date.now() - ROTATION_GRACE_MS - 60_000);

            const body = '{}';
            const ts = nowSeconds();
            await expect(
                service.fire(trigger.id, {
                    rawBody: body,
                    signatureHeader: sign(oldSecret, ts, body),
                    timestampHeader: ts,
                    contentType: 'application/json',
                }),
            ).rejects.toBeInstanceOf(UnauthorizedException);
        });

        it('409s (after passing signature checks) when the trigger is paused', async () => {
            const { service } = makeService();
            const { trigger, secret } = await service.create(SCOPE, { name: 'X' });
            await service.pause(SCOPE, trigger.id);

            const body = '{}';
            const ts = nowSeconds();
            await expect(
                service.fire(trigger.id, {
                    rawBody: body,
                    signatureHeader: sign(secret, ts, body),
                    timestampHeader: ts,
                    contentType: 'application/json',
                }),
            ).rejects.toBeInstanceOf(ConflictException);
        });

        it('404s for an unknown trigger id', async () => {
            const { service } = makeService();
            await expect(
                service.fire('nope', {
                    rawBody: '{}',
                    signatureHeader: 'x',
                    timestampHeader: nowSeconds(),
                    contentType: 'application/json',
                }),
            ).rejects.toBeInstanceOf(NotFoundException);
        });

        it('400s on oversized (>64 KB) and invalid-JSON payloads — only after the signature verifies', async () => {
            const { service } = makeService();
            const { trigger, secret } = await service.create(SCOPE, { name: 'X' });

            const big = '{"pad":"' + 'x'.repeat(64 * 1024) + '"}';
            const ts = nowSeconds();
            await expect(
                service.fire(trigger.id, {
                    rawBody: big,
                    signatureHeader: sign(secret, ts, big),
                    timestampHeader: ts,
                    contentType: 'application/json',
                }),
            ).rejects.toBeInstanceOf(BadRequestException);

            const invalid = '{not json';
            await expect(
                service.fire(trigger.id, {
                    rawBody: invalid,
                    signatureHeader: sign(secret, ts, invalid),
                    timestampHeader: ts,
                    contentType: 'application/json',
                }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('still creates the Task when agent assignment fails (best-effort)', async () => {
            const { service, tasks } = makeService();
            const { trigger, secret } = await service.create(SCOPE, {
                name: 'X',
                targetAgentId: 'agent-1',
            });
            tasks.addAssignee.mockRejectedValueOnce(new BadRequestException('gone'));

            const body = '{}';
            const ts = nowSeconds();
            const result = await service.fire(trigger.id, {
                rawBody: body,
                signatureHeader: sign(secret, ts, body),
                timestampHeader: ts,
                contentType: 'application/json',
            });
            expect(result.ok).toBe(true);
            expect(tasks.create).toHaveBeenCalledTimes(1);
        });
    });

    describe('rotateSecret', () => {
        it('returns a fresh plaintext once, moves current → previous, stamps rotatedAt', async () => {
            const { service, repo } = makeService();
            const { trigger, secret: first } = await service.create(SCOPE, { name: 'X' });

            const { secret: second } = await service.rotateSecret(SCOPE, trigger.id);
            expect(second).not.toBe(first);
            const row = repo._rows.get(trigger.id) as InboundTrigger;
            expect(row.secretEncrypted).toBe(second);
            expect(row.previousSecretEncrypted).toBe(first);
            expect(row.rotatedAt).toBeInstanceOf(Date);

            // New secret verifies immediately.
            const body = '{}';
            const ts = nowSeconds();
            const result = await service.fire(trigger.id, {
                rawBody: body,
                signatureHeader: sign(second, ts, body),
                timestampHeader: ts,
                contentType: 'application/json',
            });
            expect(result.ok).toBe(true);
        });
    });

    describe('ownership (404-never-403)', () => {
        it('cross-user access surfaces as 404', async () => {
            const { service } = makeService();
            const { trigger } = await service.create(SCOPE, { name: 'Mine' });

            await expect(
                service.getOne({ userId: 'user-2', organizationId: null }, trigger.id),
            ).rejects.toBeInstanceOf(NotFoundException);
            await expect(
                service.pause({ userId: 'user-2', organizationId: null }, trigger.id),
            ).rejects.toBeInstanceOf(NotFoundException);
        });

        it('cross-org access surfaces as 404 (same user, different active org)', async () => {
            const { service } = makeService();
            const { trigger } = await service.create(SCOPE, { name: 'Personal-scope trigger' });

            await expect(service.getOne(ORG_SCOPE, trigger.id)).rejects.toBeInstanceOf(
                NotFoundException,
            );
            await expect(service.rotateSecret(ORG_SCOPE, trigger.id)).rejects.toBeInstanceOf(
                NotFoundException,
            );
            // The owning scope still reaches it.
            const view = await service.getOne(SCOPE, trigger.id);
            expect(view.id).toBe(trigger.id);
        });
    });

    describe('pause / resume', () => {
        it('round-trips the status', async () => {
            const { service } = makeService();
            const { trigger } = await service.create(SCOPE, { name: 'X' });

            const paused = await service.pause(SCOPE, trigger.id);
            expect(paused.status).toBe('paused');
            const resumed = await service.resume(SCOPE, trigger.id);
            expect(resumed.status).toBe('active');
        });
    });
});
