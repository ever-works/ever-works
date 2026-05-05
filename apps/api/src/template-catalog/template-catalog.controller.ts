import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { TemplateCatalogService } from '@ever-works/agent/services';
import { CurrentUser } from '@src/auth';
import { AuthenticatedUser } from '@src/auth/types/auth.types';
import {
    AddCustomTemplateDto,
    ForkTemplateDto,
    ListTemplatesQueryDto,
    SetDefaultTemplateDto,
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
}
