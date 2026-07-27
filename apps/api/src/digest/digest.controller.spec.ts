import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

jest.mock('@ever-works/agent/digest', () => ({
    DigestService: class {},
    DIGEST_PERIODS: ['daily', 'weekly'],
    DIGEST_SCOPES: ['personal', 'organization'],
}));
jest.mock('@ever-works/agent/facades', () => ({
    AiFacadeService: class {},
}));

import { DigestController } from './digest.controller';
import { GetDigestQueryDto } from './dto/get-digest.dto';
import { UpdateDigestSettingsDto } from './dto/digest-settings.dto';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';

/**
 * `GET /api/digest` — the REST operation the manifest-driven web tool
 * registry needs before `get_digest` can exist on the web side — plus
 * the org scope and the settings read/write behind it.
 */
describe('DigestController', () => {
    function createController(
        overrides: {
            organizationId?: string | null;
            ensureMember?: jest.Mock;
            ensureAdmin?: jest.Mock;
            aiConfigured?: boolean;
        } = {},
    ) {
        const digest = {
            composeDigest: jest.fn().mockResolvedValue({
                scope: 'personal',
                subjectId: 'user-1',
                period: 'daily',
                since: '2026-07-25T00:00:00.000Z',
                until: '2026-07-26T00:00:00.000Z',
                quiet: false,
                markdown: '## Today\n- 1 run completed',
                text: '1 run completed',
                counts: {
                    runsCompleted: 1,
                    runsFailed: 0,
                    tasksDone: 2,
                    tasksInReview: 0,
                    prsOpened: 1,
                    eventsBySource: { github: 3 },
                    eventsTotal: 3,
                    goalsTracked: 1,
                    escalationsOpen: 0,
                },
                narrative: { status: 'unavailable', text: null, reason: 'no provider' },
            }),
            composeOrgDigest: jest.fn().mockResolvedValue({
                scope: 'organization',
                subjectId: 'org-1',
                period: 'daily',
                since: '2026-07-25T00:00:00.000Z',
                until: '2026-07-26T00:00:00.000Z',
                quiet: false,
                markdown: '# Acme — daily digest',
                text: 'Organization daily digest: 1 agent run completed.',
                counts: {},
                narrative: { status: 'generated', text: 'A busy day.' },
            }),
            getUserDigestSettings: jest.fn().mockResolvedValue({ enabled: true, cadence: 'daily' }),
            updateUserDigestSettings: jest.fn().mockResolvedValue(undefined),
            getOrgDigestSettings: jest.fn().mockResolvedValue({
                enabled: true,
                cadence: 'weekly',
                narrative: true,
                lastRunAt: null,
            }),
            updateOrgDigestSettings: jest.fn().mockResolvedValue(undefined),
        };
        const scopeContext = {
            getOrganizationId: jest
                .fn()
                .mockReturnValue(
                    overrides.organizationId === undefined ? 'org-1' : overrides.organizationId,
                ),
        };
        const membership = {
            ensureMember:
                overrides.ensureMember ??
                jest.fn().mockResolvedValue({ id: 'org-1', displayName: 'Acme' }),
            ensureAdmin:
                overrides.ensureAdmin ??
                overrides.ensureMember ??
                jest.fn().mockResolvedValue({ id: 'org-1', displayName: 'Acme' }),
        };
        const aiFacade = {
            isConfigured: jest.fn().mockReturnValue(overrides.aiConfigured ?? true),
        };
        const controller = new DigestController(
            digest as never,
            scopeContext as never,
            membership as never,
            aiFacade as never,
        );
        return { controller, digest, scopeContext, membership, aiFacade };
    }

    const auth = { userId: 'user-1' } as never;

    describe('GET /api/digest', () => {
        it('returns the composed digest shape for the current user', async () => {
            const { controller } = createController();

            const result = await controller.getDigest(auth, { period: 'weekly' });

            expect(result).toEqual(
                expect.objectContaining({
                    period: 'daily',
                    since: expect.any(String),
                    until: expect.any(String),
                    quiet: false,
                    markdown: expect.any(String),
                    text: expect.any(String),
                    counts: expect.objectContaining({
                        runsCompleted: expect.any(Number),
                        tasksDone: expect.any(Number),
                        eventsBySource: expect.any(Object),
                        eventsTotal: expect.any(Number),
                        goalsTracked: expect.any(Number),
                    }),
                }),
            );
        });

        it('composes for the AUTHENTICATED user and never for a caller-supplied id', async () => {
            const { controller, digest } = createController();

            await controller.getDigest(auth, {
                // A hostile client cannot ask for someone else's activity:
                // the DTO has no `userId` and the controller passes only the
                // session's own id.
                userId: 'victim',
            } as never);

            expect(digest.composeDigest).toHaveBeenCalledWith('user-1', { period: 'daily' });
        });

        it('defaults the window to daily and forwards an explicit period', async () => {
            const { controller, digest } = createController();

            await controller.getDigest(auth, {});
            expect(digest.composeDigest).toHaveBeenLastCalledWith('user-1', { period: 'daily' });

            await controller.getDigest(auth, { period: 'weekly' });
            expect(digest.composeDigest).toHaveBeenLastCalledWith('user-1', { period: 'weekly' });
        });

        it('⭐ takes the organization from the SCOPE, never from the request', async () => {
            const { controller, digest, scopeContext, membership } = createController();

            await controller.getDigest(auth, {
                scope: 'organization',
                // Ignored by construction — the DTO has no such field and
                // the controller reads the scope context instead.
                organizationId: 'victim-org',
            } as never);

            expect(scopeContext.getOrganizationId).toHaveBeenCalled();
            expect(membership.ensureMember).toHaveBeenCalledWith('org-1', 'user-1');
            expect(digest.composeOrgDigest).toHaveBeenCalledWith('org-1', {
                period: 'daily',
                metricsUserId: 'user-1',
            });
        });

        it('404s an organization digest when the session has no active organization', async () => {
            const { controller, digest } = createController({ organizationId: null });

            await expect(controller.getDigest(auth, { scope: 'organization' })).rejects.toThrow(
                /No active organization/i,
            );
            expect(digest.composeOrgDigest).not.toHaveBeenCalled();
        });

        it('⭐ propagates the membership 404 instead of composing across tenants', async () => {
            const ensureMember = jest.fn().mockRejectedValue(new Error('Organization x not found'));
            const { controller, digest } = createController({ ensureMember });

            await expect(controller.getDigest(auth, { scope: 'organization' })).rejects.toThrow(
                /not found/i,
            );
            expect(digest.composeOrgDigest).not.toHaveBeenCalled();
        });

        it('leaves the personal path untouched by the org scope', async () => {
            const { controller, digest, membership } = createController();

            await controller.getDigest(auth, { scope: 'personal' });

            expect(digest.composeDigest).toHaveBeenCalledWith('user-1', { period: 'daily' });
            expect(digest.composeOrgDigest).not.toHaveBeenCalled();
            expect(membership.ensureMember).not.toHaveBeenCalled();
        });
    });

    describe('GET /api/digest/settings', () => {
        it('returns both records plus whether a narrative is possible', async () => {
            const { controller } = createController();

            const result = await controller.getSettings(auth);

            expect(result).toEqual({
                personal: { enabled: true, cadence: 'daily' },
                organization: {
                    organizationId: 'org-1',
                    displayName: 'Acme',
                    enabled: true,
                    cadence: 'weekly',
                    narrative: true,
                    lastRunAt: null,
                },
                aiConfigured: true,
            });
        });

        it('returns a null organization (never a fabricated one) with no active org', async () => {
            const { controller, digest } = createController({ organizationId: null });

            const result = await controller.getSettings(auth);

            expect(result.organization).toBeNull();
            expect(result.personal).toEqual({ enabled: true, cadence: 'daily' });
            expect(digest.getOrgDigestSettings).not.toHaveBeenCalled();
        });

        it('reports aiConfigured:false so the UI can warn before the first digest', async () => {
            const { controller } = createController({ aiConfigured: false });

            expect((await controller.getSettings(auth)).aiConfigured).toBe(false);
        });
    });

    describe('PUT /api/digest/settings', () => {
        it('writes the PERSONAL record and never the org one', async () => {
            const { controller, digest } = createController();

            await controller.updateSettings(auth, {
                scope: 'personal',
                enabled: true,
                cadence: 'weekly',
            });

            expect(digest.updateUserDigestSettings).toHaveBeenCalledWith('user-1', {
                enabled: true,
                cadence: 'weekly',
            });
            expect(digest.updateOrgDigestSettings).not.toHaveBeenCalled();
        });

        it('writes the ORG record and never the personal one', async () => {
            const { controller, digest, membership } = createController();

            await controller.updateSettings(auth, {
                scope: 'organization',
                enabled: true,
                cadence: 'daily',
                narrative: false,
            });

            expect(membership.ensureAdmin).toHaveBeenCalledWith('org-1', 'user-1');
            expect(digest.updateOrgDigestSettings).toHaveBeenCalledWith('org-1', {
                enabled: true,
                cadence: 'daily',
                narrative: false,
            });
            expect(digest.updateUserDigestSettings).not.toHaveBeenCalled();
        });

        it('omits fields the client did not send (partial save)', async () => {
            const { controller, digest } = createController();

            await controller.updateSettings(auth, { scope: 'organization', cadence: 'weekly' });

            expect(digest.updateOrgDigestSettings).toHaveBeenCalledWith('org-1', {
                cadence: 'weekly',
            });
        });

        it('refuses an org write with no active organization', async () => {
            const { controller, digest } = createController({ organizationId: null });

            await expect(
                controller.updateSettings(auth, { scope: 'organization', enabled: true }),
            ).rejects.toThrow(/No active organization/i);
            expect(digest.updateOrgDigestSettings).not.toHaveBeenCalled();
        });

        it('⭐ authorizes an org WRITE through ensureAdmin, not the read-side check', async () => {
            // `ensureAdmin` is `ensureMember` today, but the membership
            // service asks write routes to call it by name so a future
            // org-admin role is enforced in one place. A regression here
            // would silently exempt digest settings from that role.
            const ensureAdmin = jest.fn().mockResolvedValue({ id: 'org-1', displayName: 'Acme' });
            const ensureMember = jest.fn().mockResolvedValue({ id: 'org-1', displayName: 'Acme' });
            const { controller } = createController({ ensureAdmin, ensureMember });

            await controller.updateSettings(auth, { scope: 'organization', enabled: true });

            expect(ensureAdmin).toHaveBeenCalledWith('org-1', 'user-1');
        });

        it('propagates a rejected org write instead of persisting it', async () => {
            const ensureAdmin = jest.fn().mockRejectedValue(new Error('Organization not found'));
            const { controller, digest } = createController({ ensureAdmin });

            await expect(
                controller.updateSettings(auth, { scope: 'organization', enabled: true }),
            ).rejects.toThrow(/not found/i);
            expect(digest.updateOrgDigestSettings).not.toHaveBeenCalled();
        });

        it('reads back the persisted settings so the client renders truth', async () => {
            const { controller, digest } = createController();

            const result = await controller.updateSettings(auth, {
                scope: 'personal',
                enabled: false,
            });

            expect(digest.getUserDigestSettings).toHaveBeenCalled();
            expect(result.personal).toEqual({ enabled: true, cadence: 'daily' });
        });
    });

    it('is NOT @Public() — an unauthenticated call is 401ed by the global auth guard', () => {
        expect(Reflect.getMetadata(IS_PUBLIC_KEY, DigestController)).toBeUndefined();
        for (const handler of ['getDigest', 'getSettings', 'updateSettings'] as const) {
            expect(
                Reflect.getMetadata(IS_PUBLIC_KEY, DigestController.prototype[handler]),
            ).toBeUndefined();
        }
    });

    describe('GetDigestQueryDto', () => {
        it('accepts the supported periods and an omitted period', async () => {
            for (const period of [undefined, 'daily', 'weekly']) {
                const dto = plainToInstance(GetDigestQueryDto, { period });
                expect(await validate(dto)).toHaveLength(0);
            }
        });

        it('rejects an unsupported period', async () => {
            const dto = plainToInstance(GetDigestQueryDto, { period: 'hourly' });
            const errors = await validate(dto);
            expect(errors).toHaveLength(1);
            expect(errors[0].property).toBe('period');
        });

        it('accepts the supported scopes and rejects anything else', async () => {
            for (const scope of [undefined, 'personal', 'organization']) {
                const dto = plainToInstance(GetDigestQueryDto, { scope });
                expect(await validate(dto)).toHaveLength(0);
            }
            const bad = plainToInstance(GetDigestQueryDto, { scope: 'tenant' });
            const errors = await validate(bad);
            expect(errors).toHaveLength(1);
            expect(errors[0].property).toBe('scope');
        });
    });

    describe('UpdateDigestSettingsDto', () => {
        it('requires a scope', async () => {
            const dto = plainToInstance(UpdateDigestSettingsDto, { enabled: true });
            const errors = await validate(dto);
            expect(errors.map((e) => e.property)).toContain('scope');
        });

        it('accepts a full personal payload', async () => {
            const dto = plainToInstance(UpdateDigestSettingsDto, {
                scope: 'personal',
                enabled: true,
                cadence: 'daily',
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('accepts a full organization payload', async () => {
            const dto = plainToInstance(UpdateDigestSettingsDto, {
                scope: 'organization',
                enabled: false,
                cadence: 'weekly',
                narrative: true,
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects a non-boolean enable and an unsupported cadence', async () => {
            const dto = plainToInstance(UpdateDigestSettingsDto, {
                scope: 'personal',
                enabled: 'yes',
                cadence: 'hourly',
            });
            const errors = await validate(dto);
            expect(errors.map((e) => e.property).sort()).toEqual(['cadence', 'enabled']);
        });
    });
});
