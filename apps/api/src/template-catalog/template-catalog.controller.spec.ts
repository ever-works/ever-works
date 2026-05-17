jest.mock('@ever-works/agent/template-catalog', () => ({
    TemplateCatalogService: class TemplateCatalogService {},
    TemplateCustomizationService: class TemplateCustomizationService {},
}));
jest.mock('@ever-works/agent/facades', () => ({
    CodeEditFacadeService: class CodeEditFacadeService {},
}));
jest.mock('@ever-works/agent/activity-log', () => ({
    ActivityLogService: class ActivityLogService {},
}));
jest.mock('@ever-works/agent/entities', () => ({
    ActivityActionType: {
        TEMPLATE_ADDED: 'template_added',
        TEMPLATE_UPDATED: 'template_updated',
        TEMPLATE_ARCHIVED: 'template_archived',
        TEMPLATE_FORKED: 'template_forked',
        TEMPLATE_DEFAULT_SET: 'template_default_set',
    },
    ActivityStatus: {
        COMPLETED: 'completed',
    },
}));
jest.mock('@src/auth', () => ({
    CurrentUser: () => () => {},
}));

import { TemplateCatalogController } from './template-catalog.controller';

describe('TemplateCatalogController', () => {
    let controller: TemplateCatalogController;
    let templateCatalogService: {
        updateCustomTemplateForUser: jest.Mock;
        archiveCustomTemplateForUser: jest.Mock;
        refreshTemplatesForUser: jest.Mock;
    };
    let templateCustomizationService: {
        createAndStart: jest.Mock;
        getByIdForUser: jest.Mock;
        listForTemplate: jest.Mock;
    };
    let codeEditFacade: { listProviders: jest.Mock };
    let activityLogService: { log: jest.Mock };

    beforeEach(() => {
        templateCatalogService = {
            updateCustomTemplateForUser: jest.fn(),
            archiveCustomTemplateForUser: jest.fn(),
            refreshTemplatesForUser: jest.fn(),
        };
        templateCustomizationService = {
            createAndStart: jest.fn(),
            getByIdForUser: jest.fn(),
            listForTemplate: jest.fn(),
        };
        codeEditFacade = { listProviders: jest.fn().mockReturnValue([]) };
        activityLogService = {
            log: jest.fn().mockResolvedValue(undefined),
        };

        controller = new TemplateCatalogController(
            templateCatalogService as any,
            templateCustomizationService as any,
            codeEditFacade as any,
            activityLogService as any,
        );
    });

    it('forwards custom template updates to the service', async () => {
        templateCatalogService.updateCustomTemplateForUser.mockResolvedValue({
            id: 'custom-1',
            name: 'New Name',
        });

        const result = await controller.updateCustomTemplate(
            { userId: 'user-1' } as any,
            'custom-1',
            {
                kind: 'website',
                name: 'New Name',
                previewImageUrl: 'https://example.com/preview.png',
            },
        );

        expect(templateCatalogService.updateCustomTemplateForUser).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'website',
                templateId: 'custom-1',
                name: 'New Name',
            }),
            'user-1',
        );
        expect(result).toEqual({
            status: 'success',
            template: {
                id: 'custom-1',
                name: 'New Name',
            },
        });
    });

    it('forwards custom template archive requests to the service', async () => {
        templateCatalogService.archiveCustomTemplateForUser.mockResolvedValue({
            templateId: 'custom-1',
            archived: true,
        });

        const result = await controller.archiveCustomTemplate(
            { userId: 'user-1' } as any,
            'custom-1',
            {
                kind: 'website',
            },
        );

        expect(templateCatalogService.archiveCustomTemplateForUser).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'website',
                templateId: 'custom-1',
            }),
            'user-1',
        );
        expect(result).toEqual({
            status: 'success',
            templateId: 'custom-1',
            archived: true,
        });
    });

    it('returns refreshed templates from the service', async () => {
        templateCatalogService.refreshTemplatesForUser.mockResolvedValue({
            defaultTemplateId: 'classic',
            templates: [{ id: 'classic', name: 'Classic' }],
        });

        const result = await controller.refreshTemplates({ userId: 'user-1' } as any, {
            kind: 'website',
        });

        expect(templateCatalogService.refreshTemplatesForUser).toHaveBeenCalledWith(
            'website',
            'user-1',
        );
        expect(result).toEqual({
            status: 'success',
            kind: 'website',
            defaultTemplateId: 'classic',
            templates: [{ id: 'classic', name: 'Classic' }],
        });
    });
});
