import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    Post,
    Query,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { KnowledgeBaseService } from '@ever-works/agent/services';
import { CreateKbDocumentDto, KbDocumentQueryDto } from '@ever-works/agent/dto';
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
 * Permission gate: in this PR, access is restricted by membership in
 * the organization. A future PR will tighten this to an
 * `OrganizationAdminGuard` once the org-admin role concept lands
 * platform-wide.
 */
@ApiTags('Knowledge Base (Organization)')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(AuthSessionGuard)
export class OrgKbController {
    constructor(private readonly kb: KnowledgeBaseService) {}

    @Get('organizations/:orgId/kb/documents')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'List organization-level KB documents' })
    @ApiQuery({ name: 'class', required: false, description: 'Filter by class (legal|style|seo)' })
    @ApiResponse({ status: 200, description: 'List of org KB documents' })
    async listOrgDocuments(
        @CurrentUser() _auth: AuthenticatedUser,
        @Param('orgId') orgId: string,
        @Query() query: KbDocumentQueryDto,
    ) {
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
        @CurrentUser() _auth: AuthenticatedUser,
        @Param('id') workId: string,
        @Query('orgId') orgId: string,
    ) {
        return this.kb.resolveInheritableDocuments(workId, orgId ?? null);
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
        return this.kb.getInheritedDocument(workId, orgId, joinedIdOrPath, auth.userId);
    }
}
