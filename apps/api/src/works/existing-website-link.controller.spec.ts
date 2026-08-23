jest.mock('../auth', () => ({
    AuthSessionGuard: class AuthSessionGuard {},
    CurrentUser: () => () => undefined,
}));
jest.mock('./existing-website-link.service', () => ({
    ExistingWebsiteLinkService: class ExistingWebsiteLinkService {},
}));

import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { HttpStatus, RequestMethod } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { AuthSessionGuard } from '../auth';
import { ExistingWebsiteLinkController } from './existing-website-link.controller';

describe('ExistingWebsiteLinkController', () => {
    const workId = '00000000-0000-0000-0000-0000000000aa';

    it('exposes an authenticated additive PUT contract', () => {
        expect(Reflect.getMetadata(PATH_METADATA, ExistingWebsiteLinkController)).toBe('api');
        expect(Reflect.getMetadata(GUARDS_METADATA, ExistingWebsiteLinkController)).toContain(
            AuthSessionGuard,
        );
        expect(
            Reflect.getMetadata(PATH_METADATA, ExistingWebsiteLinkController.prototype.link),
        ).toBe('works/:id/existing-website');
        expect(
            Reflect.getMetadata(METHOD_METADATA, ExistingWebsiteLinkController.prototype.link),
        ).toBe(RequestMethod.PUT);
        expect(
            Reflect.getMetadata(HTTP_CODE_METADATA, ExistingWebsiteLinkController.prototype.link),
        ).toBe(HttpStatus.OK);
    });

    it('binds the acting user and validated request to the service', async () => {
        const response = {
            workId,
            url: 'https://ever.works',
            domain: 'ever.works',
            created: true,
            verified: false,
        };
        const service = {
            linkExistingWebsite: jest.fn().mockResolvedValue(response),
        };
        const controller = new ExistingWebsiteLinkController(service as any);

        await expect(
            controller.link({ userId: 'user-1' } as any, workId, { url: 'https://ever.works' }),
        ).resolves.toEqual(response);
        expect(service.linkExistingWebsite).toHaveBeenCalledWith(
            workId,
            'user-1',
            'https://ever.works',
        );
    });
});
