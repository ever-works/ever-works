// `UploadsController` transitively imports the agent database barrel, which is
// not resolvable in an isolated jest context — mocked exactly as
// uploads.controller.spec.ts does.
jest.mock('@ever-works/agent/database', () => ({
    UserUploadRepository: class {},
    WorkRepository: class {},
    UserRepository: class {},
    OrganizationRepository: class {},
    OrganizationMemberRepository: class {},
    TenantRepository: class {},
    ownershipScopeMatches: () => true,
}));
jest.mock('@ever-works/agent/entities', () => ({}));

import { ExecutionContext } from '@nestjs/common';
import { ScopeContextService } from '../../scope/scope-context.service';
import { SessionScopeGuard } from '../../scope/session-scope.guard';
import { UploadsController } from '../uploads.controller';

/**
 * guard-roster-asymmetry — PR #2213 punch list, rated MAJOR.
 *
 * `SessionScopeGuard` and `UploadsController` each authorize an explicit
 * Organization scope, and uploads.controller.ts declares itself a mirror of the
 * guard: "Hydrate the exact scope a global SessionScopeGuard would authorize."
 * They drifted apart:
 *
 *   2026-08-23 06:29  d7425487d  roster-strictness ADDED to the guard
 *   2026-08-23 20:41  d220ee00f  the same pattern copied into uploads (PR #2152)
 *   2026-08-24 09:04  b7550481a  the guard REVERTED to tenant-wide (PR #2218)
 *                                ... uploads was never reconciled.
 *
 * Tenant-wide is the intended model, and that is not a matter of taste — the
 * roster's own entity says so:
 *   "This table is the ROSTER, not the authorization check ... because access is
 *    tenant-wide, a member of one Organization can see every Organization in
 *    that Tenant. The owner accepted this explicitly for v1."
 *   (packages/agent/src/entities/organization-member.entity.ts)
 * and its repository: "Nothing here grants access."
 *
 * This suite asserts only that the two sites AGREE. It takes no position the
 * code does not already take, so it fails for the defect rather than for a
 * design opinion. ONE fixture drives both halves: an invited Tenant member who
 * is NOT the Tenant owner and has NO roster row — which is every invited member
 * in production today, where `organization_members` has zero rows.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const OTHER_TENANT = '99999999-9999-4999-8999-999999999999';
const MEMBER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SOMEONE_ELSE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const TINY_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIAAAUAAarVyFEAAAAASUVORK5CYII=',
    'base64',
);

const mkFile = (): Express.Multer.File =>
    ({
        buffer: TINY_PNG,
        mimetype: 'image/png',
        size: TINY_PNG.length,
        originalname: 'probe.png',
        fieldname: 'file',
        encoding: '7bit',
    }) as Express.Multer.File;

/** The shared fixture, in one place so neither half can drift from the other. */
const FIXTURE = {
    user: { id: MEMBER, tenantId: TENANT, isActive: true },
    organization: { id: ORG, tenantId: TENANT },
    /** No roster row — in production nothing has ever written one. */
    member: null,
    /** Owned by somebody else, so the Tenant-owner exception cannot apply. */
    tenant: { id: TENANT, ownerUserId: SOMEONE_ELSE },
};

function makeContext(request: object): ExecutionContext {
    return {
        getType: () => 'http',
        switchToHttp: () => ({
            getRequest: <T = unknown>(): T => request as T,
            getResponse: <T = unknown>(): T => ({}) as T,
            getNext: <T = unknown>(): T => ({}) as T,
        }),
    } as unknown as ExecutionContext;
}

/** Side A — the guard, built as session-scope.guard.spec.ts builds it. */
function makeGuard(scopeContext: ScopeContextService): SessionScopeGuard {
    return new SessionScopeGuard(
        scopeContext,
        { findById: jest.fn(async () => FIXTURE.user) } as never,
        { findById: jest.fn(async () => FIXTURE.organization) } as never,
    );
}

type CtorArgs = new (...args: unknown[]) => UploadsController;

/**
 * Side B — the controller, constructed POSITIONALLY exactly as
 * uploads.controller.spec.ts does. The positional order is asserted by that
 * spec against the real DI token indices, so it must not be reordered here.
 */
function makeController(organizationTenantId: string = TENANT) {
    const members = { findByOrgAndUser: jest.fn().mockResolvedValue(FIXTURE.member) };
    const controller = new (UploadsController as unknown as CtorArgs)(
        {
            saveImage: jest.fn().mockResolvedValue({
                id: 'a'.repeat(64),
                url: '/api/uploads/probe.png',
                filename: 'probe.png',
                size: TINY_PNG.length,
                mimeType: 'image/png',
                hash: 'a'.repeat(64),
                key: 'probe.png',
            }),
            saveFile: jest.fn(),
        },
        { createAnonymousUser: jest.fn() },
        { authenticate: jest.fn().mockResolvedValue({ userId: MEMBER, isActive: true }) },
        undefined,
        undefined,
        {
            getScope: jest.fn().mockReturnValue({ tenantId: TENANT, organizationId: ORG }),
            setScope: jest.fn(),
        },
        { findById: jest.fn().mockResolvedValue(FIXTURE.user) },
        { findById: jest.fn().mockResolvedValue({ id: ORG, tenantId: organizationTenantId }) },
        members,
        { findById: jest.fn().mockResolvedValue(FIXTURE.tenant) },
        { validateKey: jest.fn().mockResolvedValue(null) },
    );
    const req = { headers: { authorization: 'Bearer token' } } as never;
    return { controller, req, members };
}

describe('SessionScopeGuard vs UploadsController — Organization authorization parity (guard-roster-asymmetry)', () => {
    it('SIDE A — the guard admits a Tenant member who has no roster row', async () => {
        const scopeContext = new ScopeContextService();
        const guard = makeGuard(scopeContext);
        const ctx = makeContext({ user: { userId: MEMBER } });

        await expect(
            scopeContext.runWith({ tenantId: TENANT, organizationId: ORG }, () =>
                guard.canActivate(ctx),
            ),
        ).resolves.toBe(true);
    });

    it('SIDE B — uploads must admit the SAME user in the SAME scope', async () => {
        const { controller, req } = makeController();

        // RED before the fix: rejects with the opaque 404 thrown by the roster
        // branch of `requireAuthenticatedOrganizationScope`, because
        // findByOrgAndUser returns null and the caller is not the Tenant owner.
        await expect(controller.uploadAnonymous(mkFile(), req, undefined)).resolves.toBeDefined();
    });

    it('the roster is still READ for provenance — it just no longer decides', async () => {
        // Pins the no-removal shape of the fix: the lookup stays, its result
        // stops gating. If it is later deleted this fails, forcing that to be a
        // deliberate choice rather than a silent one.
        const { controller, req, members } = makeController();

        await controller.uploadAnonymous(mkFile(), req, undefined);

        expect(members.findByOrgAndUser).toHaveBeenCalledWith(ORG, MEMBER);
    });

    it('CONTROL — a cross-Tenant Organization is still refused (the boundary that must NOT move)', async () => {
        // Same user, same request shape; only the Organization's Tenant differs.
        // If this ever passes, the fix has widened authorization instead of
        // aligning it, and the guard result above proves nothing.
        const { controller, req } = makeController(OTHER_TENANT);

        await expect(controller.uploadAnonymous(mkFile(), req, undefined)).rejects.toThrow();
    });
});
