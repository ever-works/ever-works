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
        // Post-deploy verification (slice AJ). Present on the fixture
        // because they are present on the entity: a fixture that omitted
        // them let the whole `verification` projection be deleted from the
        // controller with the suite still green.
        verifyState: 'failed',
        verifyExpectedSha: 'b'.repeat(40),
        verifyTargetUrl: 'https://app.ever.works/api/health',
        verifyAttempts: 7,
        verifyCheckedAt: new Date('2026-09-06T04:00:00Z'),
        verifyDetail: 'The app failed 3 consecutive checks.',
        revertTaskId: 'task-99',
        revertOfferedAt: new Date('2026-09-06T04:01:00Z'),
        createdAt: new Date('2026-09-06T00:00:00Z'),
    };

    /** A promotion nobody has verified — the shape the field must not hide. */
    const unverified = {
        ...promotion,
        verifyState: null,
        verifyExpectedSha: null,
        verifyTargetUrl: null,
        verifyAttempts: 0,
        verifyCheckedAt: null,
        verifyDetail: null,
        revertTaskId: null,
        revertOfferedAt: null,
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

    it('exposes no merge, no cascade and no revert route', () => {
        // Landing a promotion is an Inbox approval (slice AE), and the next
        // rung is a separate deliberate act. Neither is reachable here.
        //
        // `getVerificationTargets` / `setVerificationTargets` were added by
        // slice AJ (EW-809) and are the same KIND of route as the ladder
        // pair: they declare PLATFORM STATE — which URLs a deployment may
        // be checked against — deliberately and separately from asking for
        // a promotion, so that no promotion or verification request can
        // ever name its own URL. They start nothing, retry nothing and
        // force nothing.
        //
        // What is still absent, and must stay absent: anything that reverts.
        // A failed verification files an inert Task offering one; there is
        // no endpoint a caller can hit to undo a deployment.
        const routes = Object.getOwnPropertyNames(ReleasePromotionsController.prototype).filter(
            (name) => name !== 'constructor',
        );
        expect(routes.sort()).toEqual([
            'getLadder',
            'getVerificationTargets',
            'list',
            'open',
            'setLadder',
            'setVerificationTargets',
        ]);
        expect(routes.some((name) => /merge|approve|cascade|promoteAll/i.test(name))).toBe(false);
        expect(routes.some((name) => /revert|rollback|undo|redeploy/i.test(name))).toBe(false);
        // Nor may a caller drive the verification lane by hand: starting,
        // retrying or forcing a check is how a human would talk a green
        // verdict out of a lane whose whole job is to withhold one.
        expect(routes.some((name) => /verify|recheck|forceCheck/i.test(name))).toBe(false);
    });

    it('takes the verification target from the Work, and echoes back the SANITISED value', async () => {
        // Slice AJ. A caller that could name the URL a verification loads
        // could point a green verdict at a page it controls.
        const { controller, works } = build();

        const result = await controller.setVerificationTargets(USER, WORK, {
            production: {
                versionUrl: 'https://api.ever.works/api/version',
                appUrl: 'https://app.ever.works/api/health',
                appExpectText: '"status":"OK"',
            },
        } as never);

        expect(works.update).toHaveBeenCalledWith(WORK, {
            releaseVerification: {
                production: {
                    versionUrl: 'https://api.ever.works/api/version',
                    appUrl: 'https://app.ever.works/api/health',
                    appExpectText: '"status":"OK"',
                },
            },
        });
        expect(result.releaseVerification).toEqual({
            production: expect.objectContaining({
                versionUrl: 'https://api.ever.works/api/version',
            }),
        });
    });

    it.each([
        ['plain http', 'http://api.ever.works/api/version'],
        ['an IP literal', 'https://169.254.169.254/api/version'],
        ['localhost', 'https://localhost/api/version'],
    ])('refuses a verification target on %s', async (_label, versionUrl) => {
        const { controller, works } = build();

        await expect(
            controller.setVerificationTargets(USER, WORK, {
                production: {
                    versionUrl,
                    appUrl: 'https://app.ever.works/api/health',
                    appExpectText: '"status":"OK"',
                },
            } as never),
        ).rejects.toThrow(BadRequestException);
        expect(works.update).not.toHaveBeenCalled();
    });

    it('answers 404 identically for a Work that is not yours', async () => {
        const { controller, works } = build();

        await expect(
            controller.setVerificationTargets(OTHER, WORK, {
                production: {
                    versionUrl: 'https://api.ever.works/api/version',
                    appUrl: 'https://app.ever.works/api/health',
                    appExpectText: '"status":"OK"',
                },
            } as never),
        ).rejects.toThrow(NotFoundException);
        expect(works.update).not.toHaveBeenCalled();
    });

    it('reads a stored verification target back through the sanitiser, not raw', async () => {
        // The column is `simple-json` and therefore holds whatever was last
        // written to it — including by a migration, a console, or an older
        // build. A read that trusted it would hand a caller a URL the lane
        // would refuse to use.
        const { controller } = build({
            work: {
                releaseVerification: {
                    production: {
                        versionUrl: 'http://api.ever.works/api/version',
                        appUrl: 'https://app.ever.works/api/health',
                        appExpectText: '"status":"OK"',
                    },
                },
            },
        });

        const result = await controller.getVerificationTargets(USER, WORK);

        expect(result.releaseVerification).toBeNull();
    });

    // ── The verdict, on the promotion ────────────────────────────────

    it('reports the post-deploy verification on every promotion it returns', async () => {
        // Requirement 2 of slice AJ — "make the verdict visible on the
        // promotion". The whole block had no test: deleting it left the
        // entire apps/api release suite green, so renaming `state`,
        // omitting it when null, or dropping `revertOffer` entirely all
        // shipped silently.
        const { controller } = build();

        const result = (await controller.open(USER, WORK, {
            rung: 'develop-to-stage',
            agentId: 'agent-1',
        })) as unknown as { promotion: Record<string, Record<string, unknown>> };

        expect(result.promotion.verification).toEqual({
            state: 'failed',
            // NOT `headSha`: the merge produced a new commit, and this is
            // the base branch's tip read straight afterwards.
            expectedSha: 'b'.repeat(40),
            lastUrl: 'https://app.ever.works/api/health',
            attempts: 7,
            checkedAt: new Date('2026-09-06T04:00:00Z'),
            detail: 'The app failed 3 consecutive checks.',
        });
        expect(result.promotion.verification.expectedSha).not.toBe(promotion.headSha);
    });

    it('always carries `verification.state`, so "never checked" cannot read as fine', async () => {
        // The safety property the controller comment states: `state: null`
        // means the deployment was never checked, which a reader must not
        // round up to "fine" — so the field is present rather than omitted.
        const { controller, promotions } = build();
        promotions.openPromotion.mockResolvedValue({
            outcome: 'opened',
            promotion: unverified,
            task: { id: 'task-1', slug: 'T-9' },
        });

        const result = (await controller.open(USER, WORK, {
            rung: 'develop-to-stage',
            agentId: 'agent-1',
        })) as unknown as { promotion: Record<string, Record<string, unknown>> };

        expect(result.promotion).toHaveProperty('verification');
        expect(result.promotion.verification).toHaveProperty('state');
        expect(result.promotion.verification.state).toBeNull();
        expect(result.promotion.verification.attempts).toBe(0);
    });

    it('exposes a revert that was OFFERED, and never one that was taken', async () => {
        // There is deliberately no field saying a revert HAPPENED, because
        // nothing in this platform reverts. What a caller gets is a Task id
        // a human may act on.
        const { controller } = build();

        const rows = (await controller.list(USER, WORK, undefined)) as {
            promotions: Array<Record<string, unknown>>;
        };

        expect(rows.promotions[0].revertOffer).toEqual({
            taskId: 'task-99',
            offeredAt: new Date('2026-09-06T04:01:00Z'),
        });
        expect(JSON.stringify(rows.promotions[0])).not.toMatch(/reverted/i);
    });

    it('answers `revertOffer: null` — not an empty object — when none was filed', async () => {
        const { controller, promotions } = build();
        promotions.listForWork.mockResolvedValue([unverified]);

        const rows = (await controller.list(USER, WORK, undefined)) as {
            promotions: Array<Record<string, unknown>>;
        };

        expect(rows.promotions[0].revertOffer).toBeNull();
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
