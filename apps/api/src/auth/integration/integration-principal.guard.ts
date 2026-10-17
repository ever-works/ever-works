import { CanActivate, ExecutionContext, Injectable, Logger, Optional } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
    OrganizationMemberRepository,
    OrganizationRepository,
    TenantRepository,
    UserRepository,
} from '@ever-works/agent/database';
import { INTEGRATION_HEADERS, type IntegrationScope } from '@ever-works/contracts';
import { ScopeContextService } from '../../scope/scope-context.service';
import type { AuthenticatedUser, IntegrationPrincipal } from '../types/auth.types';
import { INTEGRATION_ORG_OPTIONAL_KEY, REQUIRE_SCOPES_KEY } from './integration.decorators';
import { IntegrationHttpException } from './integration-http.exception';
import { isWriteMethod } from './integration-limits';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type IntegrationRequest = {
    method?: string;
    params?: Record<string, string | undefined>;
    headers?: Record<string, string | string[] | undefined>;
    user?: AuthenticatedUser;
};

/**
 * EW-P1-2 — the global guard that turns an authenticated integration key
 * (`ew_int_…`) into a request it may make. Registered as an `APP_GUARD` AFTER
 * `SessionScopeGuard` (so the scope a slug resolved is visible) and BEFORE
 * `ScopeOwnershipGuard`. A no-op for every other credential.
 *
 * In order:
 *
 * 1. **The route must opt in** with `@RequireScopes(...)`. Integration keys
 *    are denied by default: a route without the decorator answers
 *    `403 scope_missing` (`reason: route_not_integration_enabled`). Today's
 *    routes therefore stay exactly as closed to integrations as they were
 *    before integration keys existed.
 * 2. **Scopes:** every scope the route lists must be granted → else
 *    `403 scope_missing` with `details.missing`.
 * 3. **Org pin:** the request must name a pinned Organization in
 *    `X-Scope-Slug` or `X-Organization-Id` (both, if sent, must agree) →
 *    else `403 org_not_pinned`. `X-Organization-Id` is resolved here and
 *    seeded into the request scope. Routes marked `@IntegrationOrgOptional()`
 *    may omit it, but a header that IS sent must still be a pin.
 * 4. **Act-as (writes only):** `X-Act-As-User: <userId>` must name an active
 *    user of the key's Tenant who is on the target Organization's roster →
 *    else `403 act_as_forbidden`. On success the request runs as that user
 *    (`request.user.userId`), so ownership, `createdBy` and `authorId` are the
 *    person's, and `integration.actAsUserId` records it for the audit row.
 *    Without the header the request runs as the key's owner. On reads the
 *    header is ignored: act-as never widens what an integration may READ.
 *
 * **Roster:** `organization_members` is not yet an authorization input in
 * Ever Works — access is Tenant-wide (`OrganizationMembershipService.
 * ensureMember`, `SessionScopeGuard.requireActiveOrganization`). Act-as uses
 * the same rule: the user's Tenant must own the Organization. EW-P1-3 makes
 * the roster authoritative; `isOnOrganizationRoster` is the one place to
 * tighten then.
 */
@Injectable()
export class IntegrationPrincipalGuard implements CanActivate {
    private readonly logger = new Logger(IntegrationPrincipalGuard.name);

    constructor(
        private readonly reflector: Reflector,
        private readonly scopeContext: ScopeContextService,
        private readonly organizationRepository: OrganizationRepository,
        private readonly userRepository: UserRepository,
        // EW-P2-6 — who an Organization admin's key may act as. Both @Optional(): a
        // graph without them keeps today's rule (any active user of the Tenant).
        @Optional() private readonly tenants?: TenantRepository,
        @Optional() private readonly members?: OrganizationMemberRepository,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        if (context.getType() !== 'http') return true;
        const request = context.switchToHttp().getRequest<IntegrationRequest>();
        const user = request.user;
        if (!user || user.authMethod !== 'integration') return true;

        const principal = user.integration;
        if (!principal) {
            // `AuthSessionGuard` always attaches the principal with the stamp; a
            // stamp without one took a path this guard does not know. Fail closed.
            throw new IntegrationHttpException(401, 'invalid_key', 'Invalid integration key.');
        }

        const targets = [context.getHandler(), context.getClass()];
        const required = this.reflector.getAllAndOverride<IntegrationScope[] | undefined>(
            REQUIRE_SCOPES_KEY,
            targets,
        );
        if (!Array.isArray(required)) {
            throw new IntegrationHttpException(
                403,
                'scope_missing',
                'This route is not available to integration keys.',
                { reason: 'route_not_integration_enabled' },
            );
        }
        const missing = required.filter((scope) => !principal.scopes.includes(scope));
        if (missing.length > 0) {
            throw new IntegrationHttpException(
                403,
                'scope_missing',
                `The integration key is missing the scope${missing.length > 1 ? 's' : ''} ${missing.join(', ')}.`,
                { required, missing },
            );
        }

        const orgOptional =
            this.reflector.getAllAndOverride<boolean>(INTEGRATION_ORG_OPTIONAL_KEY, targets) ===
            true;
        const organizationId = await this.resolvePinnedOrganization(
            request,
            principal,
            orgOptional,
        );

        if (isWriteMethod(request.method)) {
            await this.applyActAs(request, user, principal, organizationId);
        }
        return true;
    }

    /**
     * Enforce the org pin and return the Organization the request acts in
     * (`null` only on an org-optional route that named none).
     */
    private async resolvePinnedOrganization(
        request: IntegrationRequest,
        principal: IntegrationPrincipal,
        orgOptional: boolean,
    ): Promise<string | null> {
        const headerOrgId = firstHeader(request.headers?.[INTEGRATION_HEADERS.organizationId]);
        const scope = this.scopeContext.getScope();

        // A slug the caller SUPPLIED must have resolved to a pinned organization.
        // A person's slug (or the `@personal` sentinel) resolves to no
        // organization at all; it is a wrong selector, not an omitted one, so
        // it is refused on every route — org-optional ones and next to
        // `X-Organization-Id` included.
        const suppliedSlug =
            (typeof request.params?.slug === 'string' && request.params.slug.trim()) ||
            firstHeader(request.headers?.[INTEGRATION_HEADERS.scopeSlug]);
        if (suppliedSlug && scope.organizationId === null) {
            throw this.notPinned(
                'X-Scope-Slug does not name an organization this key is pinned to.',
            );
        }

        if (headerOrgId) {
            if (
                !UUID_RE.test(headerOrgId) ||
                !principal.allowedOrganizationIds.includes(headerOrgId)
            ) {
                throw this.notPinned(
                    'X-Organization-Id does not name an organization this key is pinned to.',
                );
            }
            if (scope.organizationId !== null && scope.organizationId !== headerOrgId) {
                throw this.notPinned(
                    'X-Scope-Slug and X-Organization-Id name different organizations.',
                );
            }
            const organization = await this.organizationRepository.findById(headerOrgId);
            if (!organization || organization.tenantId !== principal.tenantId) {
                throw this.notPinned(
                    'X-Organization-Id does not name an organization this key is pinned to.',
                );
            }
            this.scopeContext.setScope({
                tenantId: organization.tenantId,
                organizationId: organization.id,
            });
            return organization.id;
        }

        if (scope.organizationId !== null) {
            if (
                scope.tenantId !== principal.tenantId ||
                !principal.allowedOrganizationIds.includes(scope.organizationId)
            ) {
                throw this.notPinned(
                    'X-Scope-Slug does not name an organization this key is pinned to.',
                );
            }
            return scope.organizationId;
        }

        if (!orgOptional) {
            throw this.notPinned(
                'Name one of the organizations this key is pinned to in X-Scope-Slug (or X-Organization-Id).',
            );
        }
        return null;
    }

    private async applyActAs(
        request: IntegrationRequest,
        user: AuthenticatedUser,
        principal: IntegrationPrincipal,
        organizationId: string | null,
    ): Promise<void> {
        const raw = firstHeader(request.headers?.[INTEGRATION_HEADERS.actAsUser]);
        if (!raw) {
            principal.actAsUserId = null;
            return;
        }
        if (!UUID_RE.test(raw)) {
            throw this.actAsForbidden();
        }
        const target = await this.userRepository.findById(raw);
        if (
            !target ||
            !target.isActive ||
            !target.tenantId ||
            target.tenantId !== principal.tenantId
        ) {
            throw this.actAsForbidden();
        }
        if (
            organizationId &&
            !(await this.isOnOrganizationRoster(target.tenantId, organizationId))
        ) {
            throw this.actAsForbidden();
        }
        if (!(await this.mayActAs(principal, target.id, organizationId))) {
            throw this.actAsForbidden();
        }

        principal.actAsUserId = target.id;
        // The write runs as the person: every ownership check, `createdBy` and
        // `authorId` downstream reads `userId`. The integration stays on the
        // request (`authMethod`, `integration`) for the scope checks and the audit row.
        request.user = {
            ...user,
            userId: target.id,
            email: target.email ?? null,
            username: target.username,
            provider: target.registrationProvider,
            emailVerified: target.emailVerified,
            isActive: target.isActive,
            avatar: target.avatar || null,
            tenantId: target.tenantId,
            authMethod: 'integration',
            integration: principal,
        };
    }

    /**
     * Is a user of `tenantId` on the roster of `organizationId`? Today:
     * Tenant-wide membership (see the class doc). EW-P1-3 (authoritative
     * `organization_members`) tightens this one method.
     */
    /**
     * EW-P2-6 — a key the Tenant owner created may act as any active user of the Tenant
     * (today's rule). A key an Organization admin created may act only as itself or as a
     * plain `member` of the pinned Organization: never as the Tenant owner or another
     * admin, whose records the admin cannot write in the app either, and never on an
     * org-optional route. Fails closed on a lookup error.
     */
    private async mayActAs(
        principal: IntegrationPrincipal,
        targetUserId: string,
        organizationId: string | null,
    ): Promise<boolean> {
        if (!this.tenants) return true;
        try {
            const tenant = await this.tenants.findById(principal.tenantId);
            if (!tenant) return false;
            if (tenant.ownerUserId === principal.ownerUserId) return true;
            if (targetUserId === tenant.ownerUserId) return false;
            if (targetUserId === principal.ownerUserId) return true;
            if (!organizationId || !this.members) return false;
            const row = await this.members.findByOrgAndUser(organizationId, targetUserId);
            return row?.role === 'member';
        } catch (error) {
            this.logger.warn(`X-Act-As-User check failed: ${String(error)}`);
            return false;
        }
    }

    private async isOnOrganizationRoster(
        tenantId: string,
        organizationId: string,
    ): Promise<boolean> {
        const organization = await this.organizationRepository.findById(organizationId);
        return !!organization && organization.tenantId === tenantId;
    }

    private notPinned(message: string): IntegrationHttpException {
        return new IntegrationHttpException(403, 'org_not_pinned', message);
    }

    private actAsForbidden(): IntegrationHttpException {
        this.logger.debug('X-Act-As-User refused.');
        return new IntegrationHttpException(
            403,
            'act_as_forbidden',
            'X-Act-As-User must name an active member of the target organization.',
        );
    }
}

function firstHeader(value: string | string[] | undefined): string | null {
    const raw = Array.isArray(value) ? value.find((v) => typeof v === 'string' && v.trim()) : value;
    return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
}
