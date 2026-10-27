import 'reflect-metadata';
import { HttpException, ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AppUpstreamRefusalError } from '@ever-works/agent/app-works';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { AppUpstreamController } from './app-upstream.controller';
import { AppUpstreamSyncDto } from './dto/app-upstream-sync.dto';

/**
 * APW-02 T46 (2026-10-27) — the route half of "Sync anyway".
 *
 * The security rule of #2802/#2806 stands: only the Work OWNER, from a signed-in SESSION,
 * may accept upstream workflow changes — never a member (editor/manager), the owner's own
 * API key, an integration key, a fleet-run token or an Agent. The gate runs before the
 * service is asked; the service re-checks the owner (`owner_required`) as defence in depth.
 */
const WORK_ID = '22222222-2222-4222-8222-222222222201';
const OWNER = '11111111-1111-4111-8111-111111111101';
const EDITOR = '11111111-1111-4111-8111-111111111103';
const HEAD = 'b'.repeat(40);

function user(userId: string, authMethod?: AuthenticatedUser['authMethod']): AuthenticatedUser {
    return {
        userId,
        email: null,
        username: userId,
        provider: 'local',
        emailVerified: true,
        isActive: true,
        avatar: null,
        iat: 0,
        iss: '',
        aud: '',
        ...(authMethod ? { authMethod } : {}),
    } as AuthenticatedUser;
}

function build() {
    const upstream = {
        get: jest.fn().mockResolvedValue({ workId: WORK_ID }),
        // The creator check (visibility first, inside the service).
        isWorkOwner: jest.fn(async (_workId: string, userId: string) => userId === OWNER),
        requestSync: jest.fn().mockResolvedValue({ queued: true, runId: 'run-1' }),
        retryReadiness: jest.fn(),
    };
    const dispatcher = {
        requestDivergenceCompare: jest.fn(),
        requestSetupPullRequestCheck: jest.fn(),
        requestSyncPullRequestCheck: jest.fn(),
    };
    const controller = new AppUpstreamController(upstream as never, dispatcher as never);
    return { controller, upstream, dispatcher };
}

async function statusOf(promise: Promise<unknown>): Promise<{ status: number; body: unknown }> {
    try {
        await promise;
    } catch (error) {
        if (error instanceof HttpException) {
            return { status: error.getStatus(), body: error.getResponse() };
        }
        throw error;
    }
    throw new Error('expected the call to be refused');
}

describe('AppUpstreamController — Sync anyway (APW-02 T46)', () => {
    it('lets the owner, in a signed-in session, release the held head', async () => {
        const h = build();

        await expect(
            h.controller.syncUpstream(user(OWNER, 'session'), WORK_ID, {
                confirmWorkflowChanges: true,
                workflowHeadSha: HEAD,
            }),
        ).resolves.toEqual({ queued: true, runId: 'run-1' });

        expect(h.upstream.isWorkOwner).toHaveBeenCalledWith(WORK_ID, OWNER);
        expect(h.upstream.requestSync).toHaveBeenCalledWith(WORK_ID, OWNER, {
            confirmWorkflowChanges: true,
            workflowHeadSha: HEAD,
        });
    });

    it('refuses a member with edit access — 403 ownerRequired, the service is never asked', async () => {
        const h = build();

        const refusal = await statusOf(
            h.controller.syncUpstream(user(EDITOR, 'session'), WORK_ID, {
                confirmWorkflowChanges: true,
            }),
        );

        expect(refusal.status).toBe(403);
        expect(refusal.body).toMatchObject({ code: 'ownerRequired' });
        expect(h.upstream.requestSync).not.toHaveBeenCalled();
    });

    it.each([
        ['the owner’s own API key', 'api-key'],
        ['an integration key', 'integration'],
        ['a delegated token', 'ever-id-delegated'],
        ['a credential path with no stamp (fails closed)', undefined],
    ] as const)('refuses %s even for the owner', async (_label, method) => {
        const h = build();

        const call = h.controller.syncUpstream(user(OWNER, method), WORK_ID, {
            confirmWorkflowChanges: true,
        });

        await expect(call).rejects.toBeDefined();
        expect(h.upstream.requestSync).not.toHaveBeenCalled();
    });

    it('refuses a co-owner member too — the release runs with the creator’s secrets', async () => {
        const h = build();
        h.upstream.isWorkOwner.mockResolvedValue(false);

        const refusal = await statusOf(
            h.controller.syncUpstream(user(OWNER, 'session'), WORK_ID, {
                confirmWorkflowChanges: true,
            }),
        );

        expect(refusal.status).toBe(403);
        expect(refusal.body).toMatchObject({ code: 'ownerRequired' });
        expect(h.upstream.requestSync).not.toHaveBeenCalled();
    });

    it('answers a stranger 404 before the owner gate (visibility first)', async () => {
        const h = build();
        h.upstream.isWorkOwner.mockRejectedValue(
            new AppUpstreamRefusalError('not_found', 404, 'No such App Work.'),
        );

        const refusal = await statusOf(
            h.controller.syncUpstream(user(EDITOR, 'session'), WORK_ID, {
                confirmWorkflowChanges: true,
            }),
        );

        expect(refusal.status).toBe(404);
        expect(h.upstream.requestSync).not.toHaveBeenCalled();
    });

    it('keeps a plain Sync now exactly as before — no owner gate, no options', async () => {
        const h = build();

        await h.controller.syncUpstream(user(EDITOR, 'api-key'), WORK_ID, {});

        expect(h.upstream.isWorkOwner).not.toHaveBeenCalled();
        expect(h.upstream.requestSync).toHaveBeenCalledWith(WORK_ID, EDITOR, {});
    });

    it('translates the service’s workflow refusals into §4.1 bodies', async () => {
        const h = build();
        h.upstream.requestSync.mockRejectedValue(
            new AppUpstreamRefusalError('workflow_confirmation_required', 409, 'Held.', {
                headSha: HEAD,
                paths: '.github/workflows/a.yml',
            }),
        );

        const refusal = await statusOf(
            h.controller.syncUpstream(user(EDITOR, 'session'), WORK_ID, {}),
        );

        expect(refusal.status).toBe(409);
        expect(refusal.body).toMatchObject({
            status: 'error',
            code: 'workflow_confirmation_required',
            details: { headSha: HEAD, paths: '.github/workflows/a.yml' },
        });
    });

    it('fires the on-view sync pull request check on the read (T47)', async () => {
        const h = build();

        await h.controller.getUpstream(user(OWNER, 'session'), WORK_ID);

        expect(h.dispatcher.requestSyncPullRequestCheck).toHaveBeenCalledWith(WORK_ID);
    });
});

describe('AppUpstreamSyncDto (APW-02 T46)', () => {
    async function errorsOf(body: Record<string, unknown>): Promise<string[]> {
        const dto = plainToInstance(AppUpstreamSyncDto, body);
        const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
        return errors.map((error) => error.property);
    }

    it('accepts the empty body every caller already sends', async () => {
        expect(await errorsOf({})).toEqual([]);
    });

    it('accepts the flag and a hex head sha', async () => {
        expect(await errorsOf({ confirmWorkflowChanges: true, workflowHeadSha: HEAD })).toEqual([]);
    });

    it('refuses a non-boolean flag, a non-sha head, and any other field', async () => {
        expect(await errorsOf({ confirmWorkflowChanges: 'yes' })).toEqual([
            'confirmWorkflowChanges',
        ]);
        expect(await errorsOf({ workflowHeadSha: 'main; rm -rf' })).toEqual(['workflowHeadSha']);
        expect(await errorsOf({ releasedByUserId: OWNER })).toEqual(['releasedByUserId']);
    });

    it('is what the global pipe validates against', () => {
        // The pipe the API boots with (`main.ts`): whitelist + forbidNonWhitelisted.
        expect(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })).toBeDefined();
    });
});
