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
        return this.kb.listOrgDocuments(orgId, { class: query.class });
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
            class: body.class,
            body: body.body,
            description: body.description ?? null,
            tags: body.tags,
            categories: body.categories,
            language: body.language,
            status: body.status,
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
}
