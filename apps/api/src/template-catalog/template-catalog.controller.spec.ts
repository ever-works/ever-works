jest.mock('@ever-works/agent/services', () => ({
    TemplateCatalogService: class TemplateCatalogService {},
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

    beforeEach(() => {
        templateCatalogService = {
            updateCustomTemplateForUser: jest.fn(),
            archiveCustomTemplateForUser: jest.fn(),
            refreshTemplatesForUser: jest.fn(),
        };

        controller = new TemplateCatalogController(templateCatalogService as any);
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
