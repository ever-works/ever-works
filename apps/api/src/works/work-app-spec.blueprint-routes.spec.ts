// The auth barrel pulls `better-auth` (ESM) — stubbed as every controller spec here does.
jest.mock('../auth', () => ({
    AuthService: class AuthService {},
    AuthSessionGuard: class AuthSessionGuard {},
    CurrentUser: () => () => undefined,
}));
// The services barrel pulls an ESM-only dependency; the controller needs the class as a token only.
jest.mock('@ever-works/agent/services', () => ({
    WorkOwnershipService: class WorkOwnershipService {},
}));
jest.mock('@ever-works/agent/facades', () => ({
    GitFacadeService: class GitFacadeService {},
}));

import 'reflect-metadata';
import { ForbiddenException, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { BLUEPRINT_APPLY_PER_HOUR } from '@ever-works/contracts';
import { WorkAppSpecController } from './work-app-spec.controller';

/**
 * APW-03 T29 (lane aw-blueprints) — `POST /api/works/:id/app-spec/blueprint`,
 * `/blueprint/upgrade` and `/blueprint/dismiss` (plan §4.1:554-556, §4.2; ACC-03-41).
 *
 * What the controller owns, and only that: **edit** access (a viewer and a stranger are
 * the same `404` as every App spec route), `422 notAnAppWork`, the service's refusal
 * mapped to its status and §4.2's body, `202` for a queued run and `200` for an open
 * proposal, and the shared 5-per-hour-per-Work allowance.
 */

const WORK = '00000000-0000-4000-8000-0000000000e1';
const USER = 'user-e1';

function response() {
    return {
        code: 0 as number,
        status(code: number) {
            this.code = code;
            return this;
        },
    };
}

function build(
    options: { kind?: string; access?: 'ok' | 'forbidden' | 'missing'; withService?: boolean } = {},
) {
    const work = { id: WORK, kind: options.kind ?? 'app', tenantId: null, organizationId: null };
    const deny = (): never => {
        if (options.access === 'forbidden') throw new ForbiddenException('not a member');
        throw new NotFoundException('missing');
    };
    const ownership = {
        ensureCanEdit: jest.fn(async () =>
            options.access && options.access !== 'ok' ? deny() : { work },
        ),
        ensureCanView: jest.fn(async () => ({ work })),
    };
    const blueprints = {
        request: jest.fn(
            async (input: { mode: string; blueprintId?: string; version?: string | null }) => ({
                status: 'queued' as const,
                mode: input.mode,
                blueprintId: input.blueprintId ?? 'umami',
                version: input.version ?? '0.2.0',
                runId: 'run_1',
                inProcess: false,
            }),
        ),
        dismiss: jest.fn(async (input: { version: string }) => ({
            status: 'dismissed' as const,
            version: input.version,
        })),
    };
    const controller = new WorkAppSpecController(
        ownership as never,
        {} as never,
        {} as never,
        undefined,
        options.withService === false ? undefined : (blueprints as never),
    );
    return { controller, ownership, blueprints };
}

const AUTH = { userId: USER } as never;

async function refusal(
    promise: Promise<unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
    try {
        await promise;
    } catch (error) {
        if (error instanceof HttpException) {
            return {
                status: error.getStatus(),
                body: error.getResponse() as Record<string, unknown>,
            };
        }
        throw error;
    }
    throw new Error('expected a refusal');
}

describe('APW-03 T29 — the Blueprint routes', () => {
    it('apply queues the run with the caller as actor and answers 202 { applyStatus: applying }', async () => {
        const { controller, ownership, blueprints } = build();
        const res = response();
        const body = await controller.applyBlueprint(AUTH, WORK, { blueprintId: 'umami' }, res);
        expect(ownership.ensureCanEdit).toHaveBeenCalledWith(WORK, USER);
        expect(ownership.ensureCanView).not.toHaveBeenCalled();
        expect(blueprints.request).toHaveBeenCalledWith({
            workId: WORK,
            userId: USER,
            mode: 'apply',
            blueprintId: 'umami',
            version: null,
        });
        expect(res.code).toBe(HttpStatus.ACCEPTED);
        expect(body).toEqual({
            status: 'queued',
            mode: 'apply',
            blueprintId: 'umami',
            version: '0.2.0',
            runId: 'run_1',
            applyStatus: 'applying',
        });
    });

    it('a viewer or a stranger gets the same 404 as every App spec route (ACC-03-41), and the service is never asked', async () => {
        for (const access of ['forbidden', 'missing'] as const) {
            const { controller, blueprints } = build({ access });
            const answer = await refusal(
                controller.upgradeBlueprint(AUTH, WORK, { version: '0.2.0' }, response()),
            );
            expect(answer).toEqual({
                status: 404,
                body: { status: 'error', code: 'not_found', message: `Work ${WORK} not found.` },
            });
            expect(blueprints.request).not.toHaveBeenCalled();
        }
    });

    it('refuses a Work that is not an App Work with 422 notAnAppWork', async () => {
        const { controller } = build({ kind: 'directory' });
        const answer = await refusal(
            controller.dismissBlueprintUpgrade(AUTH, WORK, { version: '0.2.0' }, response()),
        );
        expect(answer.status).toBe(422);
        expect(answer.body.code).toBe('notAnAppWork');
    });

    it('maps the service refusal to its status and §4.2 body', async () => {
        const { controller, blueprints } = build();
        blueprints.request.mockResolvedValueOnce({
            status: 'refused',
            code: 'applyInProgress',
            httpStatus: 409,
            message: 'A Blueprint run for this App Work is already in progress.',
        } as never);
        const answer = await refusal(
            controller.upgradeBlueprint(AUTH, WORK, { version: '0.2.0' }, response()),
        );
        expect(answer).toEqual({
            status: 409,
            body: {
                status: 'error',
                code: 'applyInProgress',
                message: 'A Blueprint run for this App Work is already in progress.',
            },
        });
    });

    it('answers 200 with the open pull request when one already proposes the version', async () => {
        const { controller, blueprints } = build();
        const pullRequest = {
            number: 41,
            url: 'https://github.com/m/r/pull/41',
            version: '0.2.0',
            breaking: false,
        };
        blueprints.request.mockResolvedValueOnce({
            status: 'existing',
            mode: 'upgrade',
            blueprintId: 'umami',
            version: '0.2.0',
            pullRequest,
        } as never);
        const res = response();
        await expect(
            controller.upgradeBlueprint(AUTH, WORK, { version: 'v0.2.0' }, res),
        ).resolves.toEqual({
            status: 'existing',
            mode: 'upgrade',
            blueprintId: 'umami',
            version: '0.2.0',
            pullRequest,
        });
        expect(res.code).toBe(HttpStatus.OK);
        // A `v` prefix is the tag spelling, not part of the version.
        expect(blueprints.request).toHaveBeenCalledWith(
            expect.objectContaining({ mode: 'upgrade', version: '0.2.0' }),
        );
    });

    it('apply and upgrade share ONE bucket of 5 per Work per hour', async () => {
        const { controller } = build();
        for (let index = 0; index < BLUEPRINT_APPLY_PER_HOUR; index += 1) {
            const call =
                index % 2 === 0
                    ? controller.applyBlueprint(AUTH, WORK, { blueprintId: 'umami' }, response())
                    : controller.upgradeBlueprint(AUTH, WORK, {}, response());
            await expect(call).resolves.toBeDefined();
        }
        await expect(
            controller.upgradeBlueprint(AUTH, WORK, {}, response()),
        ).rejects.toBeInstanceOf(ThrottlerException);
        expect(BLUEPRINT_APPLY_PER_HOUR).toBe(5);
    });

    it('dismiss answers 200 with the version and audits through the service', async () => {
        const { controller, blueprints } = build();
        const res = response();
        await expect(
            controller.dismissBlueprintUpgrade(AUTH, WORK, { version: '0.2.0' }, res),
        ).resolves.toEqual({
            status: 'dismissed',
            version: '0.2.0',
        });
        expect(res.code).toBe(HttpStatus.OK);
        expect(blueprints.dismiss).toHaveBeenCalledWith({
            workId: WORK,
            userId: USER,
            version: '0.2.0',
        });
    });

    it('answers 503 dependenciesUnavailable when the service is not bound', async () => {
        const { controller } = build({ withService: false });
        const answer = await refusal(
            controller.applyBlueprint(AUTH, WORK, { blueprintId: 'umami' }, response()),
        );
        expect(answer.status).toBe(503);
        expect(answer.body.code).toBe('dependenciesUnavailable');
    });

    it('declares the three routes under api/works with the plan §4.1 paths', () => {
        const paths = ['applyBlueprint', 'upgradeBlueprint', 'dismissBlueprintUpgrade'].map(
            (name) =>
                Reflect.getMetadata(
                    'path',
                    (WorkAppSpecController.prototype as unknown as Record<string, object>)[name],
                ),
        );
        expect(paths).toEqual([
            ':id/app-spec/blueprint',
            ':id/app-spec/blueprint/upgrade',
            ':id/app-spec/blueprint/dismiss',
        ]);
        expect(Reflect.getMetadata('path', WorkAppSpecController)).toBe('api/works');
    });
});
