import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    NotFoundException,
    Optional,
    Put,
    Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { DigestService, type ComposedDigest } from '@ever-works/agent/digest';
import { AiFacadeService } from '@ever-works/agent/facades';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { ScopeContextService } from '../scope/scope-context.service';
import { OrganizationMembershipService } from '../organizations/organization-membership.service';
import { GetDigestQueryDto } from './dto/get-digest.dto';
import { UpdateDigestSettingsDto, type DigestSettingsResponse } from './dto/digest-settings.dto';

/**
 * Digest surface:
 *
 *   GET /api/digest?period=daily|weekly&scope=personal|organization
 *     → the composed digest for the CURRENT user, or for the current
 *       session's ACTIVE organization
 *   GET /api/digest/settings
 *     → both settings records (personal + org) in one read
 *   PUT /api/digest/settings
 *     → write ONE of them, chosen by `scope`
 *
 * **Security — no caller-supplied subject, in either scope.**
 * There is deliberately no `userId` query parameter: a digest is an
 * aggregate over the caller's runs, tasks, PRs, ingested events and
 * goals, so an accepted "compose for user X" parameter would be a
 * ready-made cross-tenant activity oracle.
 *
 * The organization scope keeps the same posture. The org id is NEVER
 * read from the request; it comes from the request SCOPE CONTEXT
 * (`ScopeContextService.getOrganizationId()`), which `SessionScopeGuard`
 * seeds from the authenticated user's validated last-active Org on
 * these legacy un-prefixed routes. As defense in depth every org access
 * is then re-authorized through the shared
 * `OrganizationMembershipService`, which 404s (never 403s) on a
 * cross-tenant mismatch so foreign org ids stay opaque. Mirrors
 * `OrgMemoryController` next door.
 *
 * Delivery to OTHER users stays where it was, behind the cron's
 * internal RPC. The GET is read-only: composition never writes, so
 * calling it does not consume a scheduled digest or change delivery
 * state.
 */
@ApiTags('digest')
@Controller('api/digest')
export class DigestController {
    constructor(
        private readonly digest: DigestService,
        private readonly scopeContext: ScopeContextService,
        private readonly membership: OrganizationMembershipService,
        // Only used to tell the settings UI whether a narrative will be
        // produced at all. @Optional() so an install without the facade
        // still serves settings (reporting `aiConfigured: false`, which
        // is the honest answer there).
        @Optional() private readonly aiFacade?: AiFacadeService,
    ) {}

    @Get()
    @ApiOperation({
        summary:
            'Get my composed activity digest (runs, tasks, PRs, ingested events, goal progress) for the daily or weekly window, personally scoped or scoped to my active organization.',
    })
    @HttpCode(HttpStatus.OK)
    async getDigest(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: GetDigestQueryDto,
    ): Promise<ComposedDigest> {
        const period = query.period ?? 'daily';

        if (query.scope === 'organization') {
            const organizationId = await this.resolveActiveOrganizationId(auth.userId);
            return this.digest.composeOrgDigest(organizationId, {
                period,
                // The narrative is metered against the caller — the
                // person who asked for it — not against the org owner.
                metricsUserId: auth.userId,
            });
        }

        return this.digest.composeDigest(auth.userId, { period });
    }

    @Get('settings')
    @ApiOperation({
        summary:
            'Read my digest settings: the personal cadence plus, when a session organization is active, that organization`s digest settings.',
    })
    @HttpCode(HttpStatus.OK)
    async getSettings(@CurrentUser() auth: AuthenticatedUser): Promise<DigestSettingsResponse> {
        const personal = await this.digest.getUserDigestSettings(auth.userId);

        const organizationId = this.scopeContext.getOrganizationId();
        if (!organizationId) {
            // No active Organization ⇒ report the personal record only.
            // Never a cross-tenant lookup, and never a fabricated org.
            return { personal, organization: null, aiConfigured: this.isAiConfigured() };
        }

        const org = await this.membership.ensureMember(organizationId, auth.userId);
        const settings = await this.digest.getOrgDigestSettings(organizationId);

        return {
            personal,
            organization: {
                organizationId,
                displayName: org.displayName,
                enabled: settings.enabled,
                cadence: settings.cadence,
                narrative: settings.narrative,
                lastRunAt: settings.lastRunAt,
            },
            aiConfigured: this.isAiConfigured(),
        };
    }

    @Put('settings')
    @ApiOperation({
        summary:
            'Update my digest settings. `scope: personal` writes my own cadence; `scope: organization` writes the active organization`s settings.',
    })
    @HttpCode(HttpStatus.OK)
    async updateSettings(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: UpdateDigestSettingsDto,
    ): Promise<DigestSettingsResponse> {
        if (body.scope === 'organization') {
            // WRITE side ⇒ `ensureAdmin`, not `ensureMember`. The two are
            // the same check today (there is no org-admin role in the
            // schema yet), but the membership service asks call sites to
            // keep them distinct so the future role is enforced in ONE
            // place instead of being retrofitted across every write route.
            const organizationId = await this.resolveActiveOrganizationId(auth.userId, 'write');
            await this.digest.updateOrgDigestSettings(organizationId, {
                ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
                ...(body.cadence !== undefined ? { cadence: body.cadence } : {}),
                ...(body.narrative !== undefined ? { narrative: body.narrative } : {}),
            });
        } else {
            await this.digest.updateUserDigestSettings(auth.userId, {
                ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
                ...(body.cadence !== undefined ? { cadence: body.cadence } : {}),
            });
        }

        // Read back through the same projection the GET uses, so the
        // client always renders the persisted truth rather than its own
        // optimistic guess.
        return this.getSettings(auth);
    }

    private isAiConfigured(): boolean {
        try {
            return this.aiFacade?.isConfigured() ?? false;
        } catch {
            return false;
        }
    }

    /**
     * The session's active Organization, re-authorized against the
     * caller's Tenant.
     *
     * `access` picks which authorization the shared membership service
     * applies: `read` → `ensureMember`, `write` → `ensureAdmin`. They
     * resolve identically today, and the whole point of routing through
     * both names is that the day they stop being identical, this route
     * follows automatically.
     *
     * Throws `NotFoundException` when there is no active Organization —
     * the same response a foreign org id gets, so "you have no org" and
     * "that org isn't yours" are indistinguishable from the outside.
     */
    private async resolveActiveOrganizationId(
        userId: string,
        access: 'read' | 'write' = 'read',
    ): Promise<string> {
        const organizationId = this.scopeContext.getOrganizationId();
        if (!organizationId) {
            throw new NotFoundException('No active organization for this session');
        }
        if (access === 'write') {
            await this.membership.ensureAdmin(organizationId, userId);
        } else {
            await this.membership.ensureMember(organizationId, userId);
        }
        return organizationId;
    }
}
