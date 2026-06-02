import {
    Body,
    Controller,
    ForbiddenException,
    Get,
    HttpCode,
    HttpStatus,
    NotFoundException,
    Param,
    Post,
    Query,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { KnowledgeBaseService, WorkOwnershipService } from '@ever-works/agent/services';
import { CreateKbDocumentDto, KbDocumentQueryDto } from '@ever-works/agent/dto';
import { OrganizationMembershipService } from '../organizations/organization-membership.service';
import type { KbDocumentClass, KbDocumentStatus } from '@ever-works/agent/entities';
import { AuthSessionGuard, CurrentUser } from '../auth';
import { AuthenticatedUser } from '@src/auth/types/auth.types';

/**
 * Organization-level KB administration.
 *
 * Routes only accept the inheritable classes (`legal`, `style`, `seo`)
 * per spec D2; the service-layer guard enforces that — controller
 * doesn't need a separate class filter.
 *
 * Permission gate: org-scoped routes require the caller to belong to
 * the Tenant that owns the target Organization. The tenant-ownership
 * check is delegated to the shared `OrganizationMembershipService`
 * (`ensureMember` / `ensureAdmin`) so every raw
 * `/api/organizations/:orgId/...` route platform-wide reuses ONE
 * audited implementation instead of re-deriving the comparison.
 * A future PR will tighten the write path to a true org-admin role
 * once that role concept (a schema + product decision) lands; the
 * `ensureAdmin` seam is already in place for it.
 */
@ApiTags('Knowledge Base (Organization)')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(AuthSessionGuard)
export class OrgKbController {
    constructor(
        private readonly kb: KnowledgeBaseService,
        // Security: these legacy un-prefixed `/api/organizations/:orgId/...`
        // routes are NOT scope-prefixed, so ScopeResolverMiddleware yields
        // EMPTY_SCOPE and ScopeOwnershipGuard passes trivially — i.e. the
        // global scope guards do NOT authorize the attacker-supplied
        // `:orgId`/`?orgId`. We resolve org→tenant and caller→tenant via
        // the shared membership service (mirrors OrganizationService.update
        // / upgradeFromAccount).
        private readonly membership: OrganizationMembershipService,
        private readonly ownershipService: WorkOwnershipService,
    ) {}

    /**
     * Security: the inheritable Work routes accept an attacker-controlled
     * `?orgId` query param that selects the org-scope to read from. Trust
     * the Work, not the param: gate on view-access to the Work and resolve
     * the org from the Work's real `organizationId`. Returns the org scope
     * to actually query — `null` when the Work has no org (no inheritable
     * org docs) — and rejects a supplied `orgId` that doesn't match the
     * Work's org, preventing cross-tenant KB reads via a foreign orgId.
     */
    private async resolveWorkOrgScope(
        workId: string,
        userId: string,
        suppliedOrgId: string | null | undefined,
    ): Promise<string | null> {
        const { work } = await this.ownershipService.ensureCanView(workId, userId);
        const workOrgId = work.organizationId ?? null;
        if (suppliedOrgId && suppliedOrgId !== workOrgId) {
            throw new ForbiddenException(
                'orgId does not match the organization of the requested Work',
            );
        }
        return workOrgId;
    }

    @Get('organizations/:orgId/kb/documents')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'List organization-level KB documents' })
    @ApiQuery({ name: 'class', required: false, description: 'Filter by class (legal|style|seo)' })
    @ApiResponse({ status: 200, description: 'List of org KB documents' })
    async listOrgDocuments(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('orgId') orgId: string,
        @Query() query: KbDocumentQueryDto,
    ) {
        // Security: reject cross-tenant reads of another org's KB docs.
        await this.membership.ensureMember(orgId, auth.userId);
        return this.kb.listOrgDocuments(orgId, {
            class: query.class as KbDocumentClass | undefined,
        });
    }

    @Post('organizations/:orgId/kb/documents')
    @HttpCode(HttpStatus.CREATED)
    @ApiOperation({
        summary: 'Create an organization-level KB document',
        description:
            'Restricted to inheritable classes (legal / style / seo). All Works in the org with kbConfig.inheritance.<class> != "disabled" inherit this document at the same path unless they have their own override.',
    })
    @ApiResponse({ status: 201, description: 'Org KB document created' })
    @ApiResponse({ status: 400, description: 'Class not in inheritable set' })
    async createOrgDocument(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('orgId') orgId: string,
        @Body() body: CreateKbDocumentDto,
    ) {
        // Security: reject cross-tenant writes (stored prompt-injection /
        // repo poisoning of another tenant's org via attacker-supplied orgId).
        // `ensureAdmin` is the write-side seam; today it's the same
        // tenant-ownership check as `ensureMember` (org-admin role re-deferred).
        await this.membership.ensureAdmin(orgId, auth.userId);
        return this.kb.createOrgDocument(orgId, auth.userId, {
            path: body.path,
            title: body.title,
            class: body.class as KbDocumentClass,
            body: body.body,
            description: body.description ?? null,
            tags: body.tags,
            categories: body.categories,
            language: body.language,
            status: body.status as KbDocumentStatus | undefined,
        });
    }

    @Get('works/:id/kb/inheritable')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Resolve effective inheritable documents for a Work',
        description:
            'Returns the merged set of org-level + Work-override documents for the legal/style/seo classes. Used by agent context formatting and by the workbench overlay tab.',
    })
    @ApiQuery({ name: 'orgId', required: true })
    @ApiResponse({ status: 200, description: 'Effective inheritable documents' })
    async resolveInheritable(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') workId: string,
        @Query('orgId') orgId: string,
    ) {
        // Security: `resolveInheritableDocuments` has no internal access
        // gate, and the `orgId` query param is attacker-controlled. Gate on
        // view-access to the Work and derive the org scope from the Work
        // itself so a foreign `orgId` can't leak another tenant's org docs.
        const orgScope = await this.resolveWorkOrgScope(workId, auth.userId, orgId ?? null);
        return this.kb.resolveInheritableDocuments(workId, orgScope);
    }

    /**
     * EW-639 Phase 2/e row 38c-2 — inherited-doc body endpoint.
     *
     * The catch-all segment uses `*idOrPath` instead of the legacy
     * `:idOrPath(*)` syntax: `path-to-regexp@8` (shipped with
     * NestJS 11.x via Express 5) rejects the legacy form at module-
     * init time and the API crashes on boot — the failure surfaced
     * on every push to develop's e2e workflow after row 38c-2 landed
     * (PR #998). The new syntax binds the joined remainder of the
     * URL (e.g. `legal/privacy.md`) to the `idOrPath` request param.
     * Express 5 exposes catch-all segments as an array on `req.params`;
     * we rejoin with `/` below so the service-layer heuristic still
     * resolves either a UUID or a slash-separated path.
     */
    @Get('works/:id/kb/inheritable/*idOrPath')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Read the body of one inherited (org-scope) KB document',
        description:
            'Returns the org-scope KbDocumentBodyDto rendered by the workbench detail page when the user navigates to an inherited row from the row-38a tree. Accepts either a UUID or a slash-separated path (e.g. `legal/privacy.md`). Permission gate is `ensureCanView(workId)` — anyone who can see the Work can read its inherited org docs (consistent with `resolveInheritable`).',
    })
    @ApiQuery({ name: 'orgId', required: true })
    @ApiResponse({ status: 200, description: 'Inherited KB document body' })
    @ApiResponse({ status: 404, description: 'No org-scope row at that path/id' })
    async getInheritedDocument(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') workId: string,
        @Param('idOrPath') idOrPath: string | string[],
        @Query('orgId') orgId: string,
    ) {
        const joinedIdOrPath = Array.isArray(idOrPath) ? idOrPath.join('/') : idOrPath;
        // Security: the service gates on `ensureCanView(workId)` but trusts
        // the caller-supplied `orgId`. Validate it against the Work's real
        // org so a foreign `orgId` can't read another tenant's org doc.
        const orgScope = await this.resolveWorkOrgScope(workId, auth.userId, orgId ?? null);
        if (!orgScope) {
            // Work belongs to no organization ⇒ no inheritable org doc exists.
            throw new NotFoundException(`KB inherited document not found: ${joinedIdOrPath}`);
        }
        return this.kb.getInheritedDocument(workId, orgScope, joinedIdOrPath, auth.userId);
    }
}
