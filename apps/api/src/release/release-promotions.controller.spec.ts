import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ReleasePromotionsController } from './release-promotions.controller';
import { ReleaseModule } from './release.module';

/**
 * Release promotion lane (self-build slice AI, EW-808) — the operator
 * surface.
 *
 * The assertions worth having here are about what the surface CANNOT do:
 * it cannot merge, it cannot cascade, it cannot name its own branches, and
 * it cannot read or write another owner's Work. The happy path is one
 * test.
 */
describe('ReleasePromotionsController', () => {
    const USER = { userId: 'user-1' } as never;
    const OTHER = { userId: 'someone-else' } as never;
    const WORK = '11111111-1111-4111-8111-111111111111';

    const promotion = {
        id: 'rp-1',
        rung: 'develop-to-stage',
        state: 'open',
        headBranch: 'develop',
        baseBranch: 'stage',
        headSha: 'a'.repeat(40),
        prNumber: 42,
        prUrl: 'https://github.com/ever-works/ever-works/pull/42',
        taskId: 'task-1',
        gateWorkflow: 'promotion-gate.yml',
        gateVerdict: 'pending',
        gateVerdictSha: 'a'.repeat(40),
        gateCheckedAt: new Date('2026-09-06T00:00:00Z'),
        gateRunUrl: null,
        refusalCode: null,
        laneKey: 'open',
        createdAt: new Date('2026-09-06T00:00:00Z'),
    };

    function build(over: { work?: Record<string, unknown> | null; open?: unknown } = {}) {
        const works = {
            findById: jest.fn().mockResolvedValue(
                over.work === null
                    ? null
                    : {
                          id: WORK,
                          userId: 'user-1',
                          releaseLadder: {
                              integration: 'develop',
                              staging: 'stage',
                              production: 'main',
                          },
                          ...over.work,
                      },
            ),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const promotions = {
            openPromotion: jest.fn().mockResolvedValue(
                over.open ?? {
                    outcome: 'opened',
                    promotion,
                    task: { id: 'task-1', slug: 'T-9' },
                },
            ),
            listForWork: jest.fn().mockResolvedValue([promotion]),
        };
        return {
            controller: new ReleasePromotionsController(promotions as never, works as never),
            works,
            promotions,
        };
    }

    // ── Opening ───────────────────────────────────────────────────────

    it('passes the RUNG through and nothing else — no branches, no repository, no owner', async () => {
        const { controller, promotions } = build();

        const result = await controller.open(USER, WORK, {
            rung: 'develop-to-stage',
            agentId: 'agent-1',
        });

        expect(promotions.openPromotion).toHaveBeenCalledWith({
            userId: 'user-1',
            workId: WORK,
            rung: 'develop-to-stage',
            agentId: 'agent-1',
        });
        expect(result).toMatchObject({ outcome: 'opened', taskId: 'task-1' });
    });

    it('reports an already-open lane as a CONFLICT, not a success', async () => {
        // Making this a 200 is how a UI ends up reporting "promoted" twice
        // for one pull request.
        const { controller } = build({ open: { outcome: 'already-open', promotion } });

        await expect(
            controller.open(USER, WORK, { rung: 'develop-to-stage', agentId: 'agent-1' }),
        ).rejects.toBeInstanceOf(ConflictException);
    });

    it('surfaces a refusal as a 400 carrying the code the operator needs', async () => {
        const { controller } = build({
            open: {
                outcome: 'refused',
                code: 'ladder-not-configured',
                reason: 'Work has no usable release ladder.',
            },
        });

        await expect(
            controller.open(USER, WORK, { rung: 'stage-to-main', agentId: 'agent-1' }),
        ).rejects.toMatchObject({
            response: { code: 'ladder-not-configured' },
        });
    });

    it('surfaces an unreachable Work as a 404', async () => {
        const { controller } = build({
            open: { outcome: 'refused', code: 'work-not-found', reason: 'Work not found.' },
        });

        await expect(
            controller.open(USER, WORK, { rung: 'develop-to-stage', agentId: 'agent-1' }),
        ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('never exposes the lane key, which is an index implementation detail', async () => {
        const { controller } = build();
        const result = (await controller.open(USER, WORK, {
            rung: 'develop-to-stage',
            agentId: 'agent-1',
        })) as { promotion: Record<string, unknown> };
        expect(result.promotion).not.toHaveProperty('laneKey');
        expect(result.promotion.gate).toMatchObject({
            workflow: 'promotion-gate.yml',
            verdict: 'pending',
            forCommit: 'a'.repeat(40),
        });
    });

    // ── The ladder ────────────────────────────────────────────────────

    it('stores a sanitised ladder as platform state', async () => {
        const { controller, works } = build();

        await controller.setLadder(USER, WORK, {
            integration: ' develop ',
            staging: 'stage',
            production: 'main',
        });

        expect(works.update).toHaveBeenCalledWith(WORK, {
            releaseLadder: { integration: 'develop', staging: 'stage', production: 'main' },
        });
    });

    it.each([
        ['a repeated branch', { integration: 'develop', staging: 'develop', production: 'main' }],
        ['a path escape', { integration: '../main', staging: 'stage', production: 'main' }],
        ['an option-shaped name', { integration: '--force', staging: 'stage', production: 'main' }],
        ['a refspec', { integration: 'develop', staging: 'stage:stage', production: 'main' }],
    ])('refuses %s and writes nothing', async (_label, body) => {
        const { controller, works } = build();

        await expect(controller.setLadder(USER, WORK, body as never)).rejects.toBeInstanceOf(
            BadRequestException,
        );
        expect(works.update).not.toHaveBeenCalled();
    });

    it('refuses to read or write another owner’s ladder, with the same words as a missing Work', async () => {
        const { controller, works } = build({ work: { userId: 'someone-else' } });

        await expect(controller.getLadder(USER, WORK)).rejects.toBeInstanceOf(NotFoundException);
        await expect(
            controller.setLadder(USER, WORK, {
                integration: 'develop',
                staging: 'stage',
                production: 'main',
            }),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(works.update).not.toHaveBeenCalled();
    });

    it('reads a stored ladder back through the sanitiser, not raw', async () => {
        // The column is `simple-json` and holds whatever was written to it;
        // the branch names end up in a pull request's head/base.
        const { controller } = build({ work: { releaseLadder: { integration: '../evil' } } });
        await expect(controller.getLadder(USER, WORK)).resolves.toEqual({
            workId: WORK,
            releaseLadder: null,
        });
    });

    // ── The listing ───────────────────────────────────────────────────

    it('scopes the listing to the caller', async () => {
        const { controller, promotions } = build();
        await controller.list(OTHER, WORK, '5');
        expect(promotions.listForWork).toHaveBeenCalledWith(WORK, 'someone-else', 5);
    });

    it('ignores a non-numeric limit rather than passing NaN to the store', async () => {
        const { controller, promotions } = build();
        await controller.list(USER, WORK, 'all');
        expect(promotions.listForWork).toHaveBeenCalledWith(WORK, 'user-1', undefined);
    });

    // ── What the surface deliberately lacks ───────────────────────────

    it('exposes no merge and no cascade route', () => {
        // Landing a promotion is an Inbox approval (slice AE), and the next
        // rung is a separate deliberate act. Neither is reachable here.
        const routes = Object.getOwnPropertyNames(ReleasePromotionsController.prototype).filter(
            (name) => name !== 'constructor',
        );
        expect(routes.sort()).toEqual(['getLadder', 'list', 'open', 'setLadder']);
        expect(routes.some((name) => /merge|approve|cascade|promoteAll/i.test(name))).toBe(false);
    });

    it('is mounted by a module that binds the promotion tokens app-wide', () => {
        const imports = (Reflect.getMetadata('imports', ReleaseModule) ?? []).map(
            (entry: { name?: string }) => entry?.name,
        );
        // Dropping this import does not open a hole — the merge gate
        // refuses a promotion Task whose guard is unbound — but it does
        // silently disable the lane, so it is pinned.
        expect(imports).toContain('ReleasePromotionModule');
        expect(Reflect.getMetadata('controllers', ReleaseModule)).toEqual([
            ReleasePromotionsController,
        ]);
    });
});
