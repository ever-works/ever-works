import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    Post,
    Put,
    Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { TemplateCatalogService } from '@ever-works/agent/services';
import { CurrentUser } from '@src/auth';
import { AuthenticatedUser } from '@src/auth/types/auth.types';
import {
    AddCustomTemplateDto,
    ArchiveCustomTemplateDto,
    ForkTemplateDto,
    ListTemplatesQueryDto,
    RefreshTemplatesDto,
    SetDefaultTemplateDto,
    UpdateCustomTemplateDto,
} from './dto/list-templates.dto';

@ApiTags('Templates')
@ApiBearerAuth('JWT-auth')
@Controller('api')
export class TemplateCatalogController {
    constructor(private readonly templateCatalogService: TemplateCatalogService) {}

    @Get('templates')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'List templates',
        description: 'Get templates visible to the current user for a given template kind.',
    })
    @ApiResponse({ status: 200, description: 'Visible templates for the current user' })
    async listTemplates(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: ListTemplatesQueryDto,
    ) {
        const result = await this.templateCatalogService.listTemplatesForUser(
            query.kind,
            auth.userId,
        );

        return {
            status: 'success',
            kind: query.kind,
            defaultTemplateId: result.defaultTemplateId,
            templates: result.templates,
        };
    }

    @Post('templates/custom')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Add custom template',
        description: 'Add a custom template from a repository URL for the current user.',
    })
    @ApiResponse({ status: 200, description: 'Custom template added' })
    async addCustomTemplate(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: AddCustomTemplateDto,
    ) {
        const template = await this.templateCatalogService.addCustomTemplate(body, auth.userId);

        return {
            status: 'success',
            template,
        };
    }

    @Put('templates/custom/:templateId')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Update custom template',
        description: 'Update editable metadata for a custom template owned by the current user.',
    })
    @ApiResponse({ status: 200, description: 'Custom template updated' })
    async updateCustomTemplate(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('templateId') templateId: string,
        @Body() body: UpdateCustomTemplateDto,
    ) {
        const template = await this.templateCatalogService.updateCustomTemplateForUser(
            {
                ...body,
                templateId,
            },
            auth.userId,
        );

        return {
            status: 'success',
            template,
        };
    }

    @Post('templates/custom/:templateId/archive')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Archive custom template',
        description: 'Archive a custom template owned by the current user.',
    })
    @ApiResponse({ status: 200, description: 'Custom template archived' })
    async archiveCustomTemplate(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('templateId') templateId: string,
        @Body() body: ArchiveCustomTemplateDto,
    ) {
        const result = await this.templateCatalogService.archiveCustomTemplateForUser(
            {
                ...body,
                templateId,
            },
            auth.userId,
        );

        return {
            status: 'success',
            ...result,
        };
    }

    @Put('templates/default')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Set default template',
        description: 'Set the default template for the current user and template kind.',
    })
    @ApiResponse({ status: 200, description: 'Default template updated' })
    async setDefaultTemplate(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: SetDefaultTemplateDto,
    ) {
        const result = await this.templateCatalogService.setDefaultTemplateForUser(
            body.kind,
            body.templateId,
            auth.userId,
        );

        return {
            status: 'success',
            kind: body.kind,
            ...result,
        };
    }

    @Post('templates/fork')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Fork a standard template',
        description:
            'Fork a standard template to the current user GitHub account or organization and set it as default.',
    })
    @ApiResponse({ status: 200, description: 'Template forked and set as default' })
    async forkTemplate(@CurrentUser() auth: AuthenticatedUser, @Body() body: ForkTemplateDto) {
        const result = await this.templateCatalogService.forkTemplateForUser(body, auth.userId);

        return {
            status: 'success',
            kind: body.kind,
            ...result,
        };
    }

    @Post('templates/refresh')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Refresh templates catalog',
        description:
            'Refresh discovered templates and return the latest catalog for the current user.',
    })
    @ApiResponse({ status: 200, description: 'Templates refreshed' })
    async refreshTemplates(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: RefreshTemplatesDto,
    ) {
        const result = await this.templateCatalogService.refreshTemplatesForUser(
            body.kind,
            auth.userId,
        );

        return {
            status: 'success',
            kind: body.kind,
            defaultTemplateId: result.defaultTemplateId,
            templates: result.templates,
        };
    }
}
