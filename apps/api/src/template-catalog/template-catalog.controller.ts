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
import {
    TemplateCatalogService,
    TemplateCustomizationService,
} from '@ever-works/agent/template-catalog';
import { CodeEditFacadeService } from '@ever-works/agent/facades';
import { ActivityLogService } from '@ever-works/agent/activity-log';
import { ActivityActionType, ActivityStatus } from '@ever-works/agent/entities';
import { CurrentUser } from '@src/auth';
import { AuthenticatedUser } from '@src/auth/types/auth.types';
import {
    AddCustomTemplateDto,
    ArchiveCustomTemplateDto,
    CustomizeTemplateFromBaseDto,
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
    constructor(
        private readonly templateCatalogService: TemplateCatalogService,
        private readonly templateCustomizationService: TemplateCustomizationService,
        private readonly codeEditFacade: CodeEditFacadeService,
        private readonly activityLogService: ActivityLogService,
    ) {}

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

        this.activityLogService
            .log({
                userId: auth.userId,
                actionType: ActivityActionType.TEMPLATE_ADDED,
                action: 'template.added',
                status: ActivityStatus.COMPLETED,
                summary: `Added ${body.kind} template: ${template.name}`,
                metadata: { templateId: template.id, kind: body.kind },
            })
            .catch(() => {});

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

        this.activityLogService
            .log({
                userId: auth.userId,
                actionType: ActivityActionType.TEMPLATE_UPDATED,
                action: 'template.updated',
                status: ActivityStatus.COMPLETED,
                summary: `Updated ${body.kind} template: ${template.name}`,
                metadata: { templateId: template.id, kind: body.kind },
            })
            .catch(() => {});

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

        this.activityLogService
            .log({
                userId: auth.userId,
                actionType: ActivityActionType.TEMPLATE_ARCHIVED,
                action: 'template.archived',
                status: ActivityStatus.COMPLETED,
                summary: `Archived ${body.kind} template`,
                metadata: { templateId: result.templateId, kind: body.kind },
            })
            .catch(() => {});

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

        this.activityLogService
            .log({
                userId: auth.userId,
                actionType: ActivityActionType.TEMPLATE_DEFAULT_SET,
                action: 'template.default_set',
                status: ActivityStatus.COMPLETED,
                summary: `Set default ${body.kind} template`,
                metadata: { templateId: result.defaultTemplateId, kind: body.kind },
            })
            .catch(() => {});

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

        if (result.created) {
            this.activityLogService
                .log({
                    userId: auth.userId,
                    actionType: ActivityActionType.TEMPLATE_FORKED,
                    action: 'template.forked',
                    status: ActivityStatus.COMPLETED,
                    summary: `Forked ${body.kind} template to ${result.repository.fullName}`,
                    metadata: {
                        templateId: result.template.id,
                        kind: body.kind,
                        targetOwner: body.targetOwner,
                        repositoryFullName: result.repository.fullName,
                    },
                })
                .catch(() => {});
        }

        return {
            status: 'success',
            kind: body.kind,
            ...result,
        };
    }

    @Get('templates/customization-providers')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'List installed code-edit providers usable for template customization',
    })
    @ApiResponse({ status: 200, description: 'Providers' })
    async listCustomizationProviders() {
        return { status: 'success', providers: this.codeEditFacade.listProviders() };
    }

    @Post('templates/custom-from-base')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Create a new custom template from a base + agent UI customization' })
    @ApiResponse({ status: 200, description: 'Customization scheduled' })
    async customizeTemplateFromBase(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: CustomizeTemplateFromBaseDto,
    ) {
        const result = await this.templateCustomizationService.createAndStart(auth.userId, body);

        this.activityLogService
            .log({
                userId: auth.userId,
                actionType: ActivityActionType.TEMPLATE_ADDED,
                action: 'template.customize_requested',
                status: ActivityStatus.IN_PROGRESS,
                summary: `Customize template ${result.template.name} from base ${body.baseTemplateId}`,
                metadata: {
                    templateId: result.template.id,
                    baseTemplateId: body.baseTemplateId,
                    customizationId: result.customization.id,
                    providerId: body.providerId,
                },
            })
            .catch(() => {});

        return {
            status: 'success',
            customizationId: result.customization.id,
            template: {
                id: result.template.id,
                name: result.template.name,
                repositoryOwner: result.template.repositoryOwner,
                repositoryName: result.template.repositoryName,
                repositoryUrl: result.template.repositoryUrl,
            },
            customization: this.serializeCustomization(result.customization),
        };
    }

    @Get('templates/customizations/:customizationId')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Get template customization status' })
    @ApiResponse({ status: 200, description: 'Customization status' })
    async getCustomization(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('customizationId') customizationId: string,
    ) {
        const customization = await this.templateCustomizationService.getByIdForUser(
            customizationId,
            auth.userId,
        );
        if (!customization) return { status: 'error', message: 'Customization not found' };
        return { status: 'success', customization: this.serializeCustomization(customization) };
    }

    @Get('templates/:templateId/customizations')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'List customization runs for a custom template' })
    @ApiResponse({ status: 200, description: 'Customization list' })
    async listCustomizationsForTemplate(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('templateId') templateId: string,
    ) {
        const customizations = await this.templateCustomizationService.listForTemplate(
            templateId,
            auth.userId,
        );
        return {
            status: 'success',
            customizations: customizations.map((c) => this.serializeCustomization(c)),
        };
    }

    private serializeCustomization(c: {
        id: string;
        templateId: string;
        baseTemplateId: string;
        prompt: string;
        status: string;
        branch?: string | null;
        commitSha?: string | null;
        providerId?: string | null;
        errorMessage?: string | null;
        startedAt?: Date | null;
        completedAt?: Date | null;
        createdAt: Date;
        updatedAt: Date;
    }) {
        return {
            id: c.id,
            templateId: c.templateId,
            baseTemplateId: c.baseTemplateId,
            prompt: c.prompt,
            status: c.status,
            branch: c.branch ?? null,
            commitSha: c.commitSha ?? null,
            providerId: c.providerId ?? null,
            errorMessage: c.errorMessage ?? null,
            startedAt: c.startedAt ? c.startedAt.toISOString() : null,
            completedAt: c.completedAt ? c.completedAt.toISOString() : null,
            createdAt: c.createdAt.toISOString(),
            updatedAt: c.updatedAt.toISOString(),
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
