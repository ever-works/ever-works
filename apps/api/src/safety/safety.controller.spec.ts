import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { THROTTLER_LIMIT, THROTTLER_TTL } from '@nestjs/throttler/dist/throttler.constants';
import {
    ACTION_CATEGORIES,
    LADDERED_CATEGORIES,
    READINESS_WINDOW_DAYS,
    SAFETY_RUNG_WRITES_PER_MINUTE,
} from '@ever-works/contracts';
import { SafetyController } from './safety.controller';
import { HUMAN_ONLY_KEY } from './decorators/human-only.decorator';

/**
 * Safety rails (AW-24) — the `/api/safety` surface.
 *
 * The controller itself holds almost no logic on purpose: the resolution, the
 * narrow-only merge and the validation all live in the agent-side services
 * that have their own specs. What is asserted here is the part that can only
 * be wrong HERE, and that no other spec can see:
 *
 *   - the closed category list is published verbatim, so the screen and the
 *     enforcement point cannot drift from it;
 *   - each overview panel degrades on its own — one failed read never blanks
 *     the one screen about safety (FR-73);
 *   - a caller who is not the workspace owner gets **404, not 403** (FR-79),
 *     because a 403 confirms the row exists;
 *   - the two writes carry `@HumanOnly()` and a throttle (FR-31, FR-78);
 *   - a write invalidates the local cache, so the rung takes effect on this
 *     replica at once rather than after the cache window (FR-37).
 */
describe('SafetyController', () => {
    const OWNER = 'user-owner';

    type Mocks = {
        grants: { resolve: jest.Mock; write: jest.Mock; revert: jest.Mock };
        refusals: { counts: jest.Mock; list: jest.Mock; expand: jest.Mock };
        pauses: { state: jest.Mock };
        readiness: { forWorkspace: jest.Mock };
        gate: { invalidate: jest.Mock };
        scope: { getOrganizationId: jest.Mock; getTenantId: jest.Mock };
        tenants: { findById: jest.Mock };
    };

    const ladder = (overrides: Record<string, unknown> = {}) => ({
        entries: [],
        safeMode: false,
        ...overrides,
    });

    const build = (overrides: Partial<Mocks> = {}) => {
        const mocks: Mocks = {
            grants: {
                resolve: jest.fn().mockResolvedValue(ladder()),
                write: jest.fn().mockResolvedValue(ladder()),
                revert: jest.fn().mockResolvedValue(ladder()),
            },
            refusals: {
                counts: jest.fn().mockResolvedValue({ windowDays: 30, total: 0 }),
                list: jest.fn().mockResolvedValue({ items: [], groups: [], nextCursor: null }),
                expand: jest.fn().mockResolvedValue([]),
            },
            pauses: { state: jest.fn().mockResolvedValue({ paused: false, unverified: false }) },
            readiness: { forWorkspace: jest.fn().mockResolvedValue([]) },
            gate: { invalidate: jest.fn() },
            scope: {
                getOrganizationId: jest.fn().mockReturnValue('org-1'),
                getTenantId: jest.fn().mockReturnValue('tenant-1'),
            },
            tenants: { findById: jest.fn().mockResolvedValue({ ownerUserId: OWNER }) },
            ...overrides,
        };
        const controller = new SafetyController(
            mocks.grants as never,
            mocks.refusals as never,
            mocks.pauses as never,
            mocks.readiness as never,
            mocks.gate as never,
            mocks.scope as never,
            mocks.tenants as never,
        );
        return { controller, mocks };
    };

    const auth = (userId = OWNER) =>
        ({ userId, tenantId: 'tenant-1', authMethod: 'session' }) as never;

    describe('GET /categories', () => {
        it('publishes all thirteen kinds of work, in the order the spec fixes', () => {
            const { controller } = build();
            const { categories } = controller.categories();
            expect(categories.map((c) => c.id)).toEqual([...ACTION_CATEGORIES]);
        });

        it('marks read.internal as the one category that carries no rung', () => {
            const { controller } = build();
            const read = controller.categories().categories.find((c) => c.id === 'read.internal');
            // FR-2: what an agent may read inside the workspace is decided by
            // connections and tool grants. A ceiling here would be a second
            // way to express it.
            expect(read).toMatchObject({ laddered: false, ceiling: null, defaultRung: null });
        });

        it('never lets money off the bottom rung', () => {
            const { controller } = build();
            const money = controller
                .categories()
                .categories.find((c) => c.id === 'spend.commitment');
            // FR-12: the platform exposes no mechanism by which an agent
            // executes a purchase, so its ceiling IS its default.
            expect(money).toMatchObject({ ceiling: 'off', defaultRung: 'off' });
        });

        it('gives every category a dot-free camelCase i18n leaf', () => {
            // Every category id contains a literal '.', and a next-intl leaf
            // key may never contain one — it throws at runtime.
            const { controller } = build();
            for (const category of controller.categories().categories) {
                expect(category.i18nKey).not.toContain('.');
                expect(category.i18nKey).toMatch(/^[a-z][A-Za-z]*$/);
            }
        });

        it('offers Draft only where there is an artefact to review', () => {
            const { controller } = build();
            const draftable = controller
                .categories()
                .categories.filter((c) => c.draftable)
                .map((c) => c.id);
            // FR-8: for a category with nothing to show, Draft would be Ask
            // wearing a different label.
            expect(draftable).toEqual([
                'write.internal',
                'write.destructive',
                'message.external',
                'publish.external',
                'machine.run',
                'machine.admin',
            ]);
        });
    });

    describe('GET /overview', () => {
        it('reads the three panels independently and reports which one failed', async () => {
            const { controller, mocks } = build();
            mocks.refusals.counts.mockRejectedValue(new Error('log unavailable'));

            const overview = await controller.overview(auth());

            // FR-73: the ladder and the pause still render. Only the log says
            // it could not load.
            expect(overview.ladder).toEqual({ data: ladder(), error: false });
            expect(overview.pause.error).toBe(false);
            expect(overview.refusalCounts).toEqual({ data: null, error: true });
        });

        it('treats an unreadable ladder as safe mode rather than as a running workspace', async () => {
            const { controller, mocks } = build();
            mocks.grants.resolve.mockRejectedValue(new Error('store down'));

            const overview = await controller.overview(auth());

            // FR-18: a safety control that fails open is not one.
            expect(overview.safeMode).toBe(true);
            expect(overview.ladder).toEqual({ data: null, error: true });
        });

        it('reports safe mode when the pause state could not be verified', async () => {
            const { controller, mocks } = build();
            mocks.pauses.state.mockResolvedValue({ paused: true, unverified: true });

            expect((await controller.overview(auth())).safeMode).toBe(true);
        });

        it('counts refusals over the readiness window so both surfaces agree', async () => {
            const { controller, mocks } = build();
            await controller.overview(auth());
            expect(mocks.refusals.counts).toHaveBeenCalledWith(OWNER, READINESS_WINDOW_DAYS);
        });

        it('tells the screen to render read-only for a member who is not the owner', async () => {
            const { controller } = build();
            const overview = await controller.overview(auth('user-teammate'));
            // U10 / FR-39: a teammate sees everything, and can change nothing.
            expect(overview.canEdit).toBe(false);
        });

        it('renders read-only rather than 500ing when the owner check itself fails', async () => {
            const { controller, mocks } = build();
            mocks.tenants.findById.mockRejectedValue(new Error('tenant read failed'));
            await expect(controller.overview(auth())).resolves.toMatchObject({ canEdit: false });
        });
    });

    describe('GET /ladder', () => {
        it('resolves the workspace ladder from the scope in context, not from the query', async () => {
            const { controller, mocks } = build();
            await controller.ladder(auth(), {});
            expect(mocks.grants.resolve).toHaveBeenCalledWith(OWNER, {
                workspaceScopeId: 'org-1',
                agentId: null,
            });
        });

        it('falls back to the tenant for a bare-tenant workspace', async () => {
            const { controller, mocks } = build();
            mocks.scope.getOrganizationId.mockReturnValue(null);
            await controller.ladder(auth(), {});
            expect(mocks.grants.resolve).toHaveBeenCalledWith(
                OWNER,
                expect.objectContaining({ workspaceScopeId: 'tenant-1' }),
            );
        });

        it('narrows to one agent when asked', async () => {
            const { controller, mocks } = build();
            await controller.ladder(auth(), { agentId: 'agent-7' });
            expect(mocks.grants.resolve).toHaveBeenCalledWith(
                OWNER,
                expect.objectContaining({ agentId: 'agent-7' }),
            );
        });
    });

    describe('PUT /ladder', () => {
        const body = {
            scopeType: 'workspace' as const,
            scopeId: 'org-1',
            category: 'message.external' as const,
            rung: 'ask' as const,
        };

        it('writes as a human actor the caller could not have fabricated', async () => {
            const { controller, mocks } = build();
            await controller.putLadder(auth(), { ...body });
            // FR-31: `isHuman: true` is a literal on the actor type, so the
            // only way to reach the write path is through the guard.
            expect(mocks.grants.write).toHaveBeenCalledWith(
                { userId: OWNER, isHuman: true },
                expect.objectContaining({
                    ownerUserId: OWNER,
                    workspaceScopeId: 'org-1',
                    category: 'message.external',
                    rung: 'ask',
                    note: null,
                }),
            );
        });

        it('carries the agent id when the rung is narrowed on one agent', async () => {
            const { controller, mocks } = build();
            await controller.putLadder(auth(), {
                ...body,
                scopeType: 'agent',
                scopeId: 'agent-7',
            });
            expect(mocks.grants.write).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({ scopeType: 'agent', agentId: 'agent-7' }),
            );
        });

        it('invalidates the local cache so the rung takes effect at once', async () => {
            const { controller, mocks } = build();
            await controller.putLadder(auth(), { ...body });
            // FR-37: this replica is immediate; the others expire inside the
            // ten-second window.
            expect(mocks.gate.invalidate).toHaveBeenCalledWith(OWNER, 'org-1');
        });

        it('refuses a non-owner with 404, never 403', async () => {
            const { controller, mocks } = build();
            await expect(controller.putLadder(auth('user-teammate'), { ...body })).rejects.toThrow(
                NotFoundException,
            );
            // FR-79: a 403 would confirm the rung exists. Nothing is written.
            expect(mocks.grants.write).not.toHaveBeenCalled();
            expect(mocks.gate.invalidate).not.toHaveBeenCalled();
        });

        it('lets the ladder rules refuse the write rather than second-guessing them', async () => {
            const { controller, mocks } = build();
            mocks.grants.write.mockRejectedValue(new Error('One rung at a time.'));
            // The one-rung and ceiling rules live in `trust-ladder.ts` and are
            // validated against the ladder as it stands, so a stale screen
            // cannot skip a rung by sending an out-of-date current value.
            await expect(controller.putLadder(auth(), { ...body })).rejects.toThrow(
                'One rung at a time.',
            );
            expect(mocks.gate.invalidate).not.toHaveBeenCalled();
        });
    });

    describe('DELETE /ladder/:id', () => {
        it('reverts one rung to inherit and invalidates the cache', async () => {
            const { controller, mocks } = build();
            await controller.deleteLadder(auth(), 'grant-1', {});
            expect(mocks.grants.revert).toHaveBeenCalledWith(
                { userId: OWNER, isHuman: true },
                OWNER,
                'grant-1',
                { workspaceScopeId: 'org-1', agentId: null },
            );
            expect(mocks.gate.invalidate).toHaveBeenCalledWith(OWNER, 'org-1');
        });

        it('refuses a non-owner with 404 and reverts nothing', async () => {
            const { controller, mocks } = build();
            await expect(
                controller.deleteLadder(auth('user-teammate'), 'grant-1', {}),
            ).rejects.toThrow(NotFoundException);
            expect(mocks.grants.revert).not.toHaveBeenCalled();
        });
    });

    describe('GET /refusals', () => {
        it('defaults to the readiness window when no range is given', async () => {
            const { controller, mocks } = build();
            const before = Date.now();
            await controller.listRefusals(auth(), {});
            const filter = mocks.refusals.list.mock.calls[0][0];

            const spanDays = (filter.to.getTime() - filter.from.getTime()) / 86_400_000;
            expect(Math.round(spanDays)).toBe(READINESS_WINDOW_DAYS);
            expect(filter.to.getTime()).toBeGreaterThanOrEqual(before);
        });

        it('passes every filter through, owner-scoped', async () => {
            const { controller, mocks } = build();
            await controller.listRefusals(auth(), {
                railId: 'ladder',
                category: 'message.external',
                agentId: 'agent-7',
                from: '2026-01-01T00:00:00.000Z',
                to: '2026-01-31T00:00:00.000Z',
                cursor: '2026-01-15T00:00:00.000Z',
            });
            expect(mocks.refusals.list).toHaveBeenCalledWith({
                userId: OWNER,
                railId: 'ladder',
                category: 'message.external',
                agentId: 'agent-7',
                from: new Date('2026-01-01T00:00:00.000Z'),
                to: new Date('2026-01-31T00:00:00.000Z'),
                cursor: '2026-01-15T00:00:00.000Z',
            });
        });

        it('is readable by a member who is not the owner', async () => {
            const { controller } = build();
            // U10: the log is read-only for a teammate, but it IS readable —
            // otherwise "the work just did not happen" is the only available
            // explanation.
            await expect(controller.listRefusals(auth('user-teammate'), {})).resolves.toMatchObject(
                { items: [] },
            );
        });
    });

    describe('GET /refusals/:collapseKey', () => {
        it('expands one collapsed day, owner-scoped', async () => {
            const { controller, mocks } = build();
            await controller.expandRefusals(auth(), 'collapse-abc', {});
            expect(mocks.refusals.expand).toHaveBeenCalledWith(OWNER, 'collapse-abc');
        });
    });

    describe('GET /readiness', () => {
        it('computes readiness against the resolved ladder and never writes a rung', async () => {
            const { controller, mocks } = build();
            const result = await controller.readinessFor(auth(), {});
            // FR-35: the product computes readiness and NEVER applies it.
            expect(mocks.readiness.forWorkspace).toHaveBeenCalledWith(OWNER, ladder());
            expect(mocks.grants.write).not.toHaveBeenCalled();
            expect(result).toEqual({ readiness: [] });
        });
    });

    describe('route metadata', () => {
        const proto = SafetyController.prototype as unknown as Record<string, object>;

        it.each(['putLadder', 'deleteLadder'])(
            'marks %s human-only — nothing graduates itself',
            (method) => {
                // FR-31: an API key, an agent, a schedule or a webhook that
                // tries to move a rung is refused and recorded.
                expect(Reflect.getMetadata(HUMAN_ONLY_KEY, proto[method])).toBe(true);
            },
        );

        it.each(['categories', 'overview', 'ladder', 'readinessFor', 'listRefusals'])(
            'leaves %s readable by any member',
            (method) => {
                expect(Reflect.getMetadata(HUMAN_ONLY_KEY, proto[method])).toBeUndefined();
            },
        );

        it.each(['putLadder', 'deleteLadder'])('rate-limits %s per FR-78', (method) => {
            expect(Reflect.getMetadata(THROTTLER_LIMIT + 'long', proto[method])).toBe(
                SAFETY_RUNG_WRITES_PER_MINUTE,
            );
            expect(Reflect.getMetadata(THROTTLER_TTL + 'long', proto[method])).toBe(60_000);
        });
    });

    describe('the closed lists this controller publishes', () => {
        it('ladders exactly twelve of the thirteen categories', () => {
            expect(LADDERED_CATEGORIES).toHaveLength(ACTION_CATEGORIES.length - 1);
            expect(LADDERED_CATEGORIES).not.toContain('read.internal');
        });
    });
});
