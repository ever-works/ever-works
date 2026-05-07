jest.mock('@ever-works/agent/facades', () => ({ GitFacadeService: class {} }));
jest.mock('@ever-works/agent/database', () => ({ AuthAccountRepository: class {} }));
jest.mock('../../auth/guards/auth-session.guard', () => ({ AuthSessionGuard: class {} }));

import { GitProviderController } from './git-provider.controller';
import type { GitProviderService } from './git-provider.service';

describe('GitProviderController', () => {
    let gitProviderService: {
        getAvailableProviders: jest.Mock;
        isConfigured: jest.Mock;
        checkConnection: jest.Mock;
        getOrganizations: jest.Mock;
        getRepositories: jest.Mock;
        getUser: jest.Mock;
    };
    let controller: GitProviderController;
    const req = { user: { userId: 'user-1' } } as any;

    beforeEach(() => {
        gitProviderService = {
            getAvailableProviders: jest.fn(),
            isConfigured: jest.fn(),
            checkConnection: jest.fn(),
            getOrganizations: jest.fn(),
            getRepositories: jest.fn(),
            getUser: jest.fn(),
        };
        controller = new GitProviderController(
            gitProviderService as unknown as GitProviderService,
        );
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('listProviders', () => {
        it('returns { configured, providers } envelope', async () => {
            gitProviderService.getAvailableProviders.mockReturnValue([{ id: 'github' }]);
            gitProviderService.isConfigured.mockReturnValue(true);

            const result = await controller.listProviders();

            expect(result).toEqual({ configured: true, providers: [{ id: 'github' }] });
            expect(gitProviderService.getAvailableProviders).toHaveBeenCalledTimes(1);
            expect(gitProviderService.isConfigured).toHaveBeenCalledTimes(1);
        });

        it('returns configured:false when service reports not configured', async () => {
            gitProviderService.getAvailableProviders.mockReturnValue([]);
            gitProviderService.isConfigured.mockReturnValue(false);

            const result = await controller.listProviders();

            expect(result).toEqual({ configured: false, providers: [] });
        });
    });

    describe('checkConnection', () => {
        it('forwards (req.user.userId, providerId) to service.checkConnection and returns its result verbatim', async () => {
            const info = { id: 'github', connected: true, username: 'alice' };
            gitProviderService.checkConnection.mockResolvedValue(info);

            const result = await controller.checkConnection(req, 'github');

            expect(gitProviderService.checkConnection).toHaveBeenCalledWith('user-1', 'github');
            expect(result).toBe(info);
        });

        it('propagates errors from service.checkConnection (no try/catch wrap on this endpoint)', async () => {
            const err = new Error('boom');
            gitProviderService.checkConnection.mockRejectedValue(err);

            await expect(controller.checkConnection(req, 'github')).rejects.toBe(err);
        });
    });

    describe('getOrganizations', () => {
        it('returns { success: true, organizations } on success', async () => {
            gitProviderService.getOrganizations.mockResolvedValue([{ id: 'o1' }]);

            const result = await controller.getOrganizations(req, 'github');

            expect(gitProviderService.getOrganizations).toHaveBeenCalledWith('user-1', 'github');
            expect(result).toEqual({ success: true, organizations: [{ id: 'o1' }] });
        });

        it('returns { success: false, organizations: [], error: <message> } on Error rejection', async () => {
            gitProviderService.getOrganizations.mockRejectedValue(new Error('rate limited'));

            const result = await controller.getOrganizations(req, 'github');

            expect(result).toEqual({
                success: false,
                organizations: [],
                error: 'rate limited',
            });
        });

        it('returns generic error fallback when rejection is not an Error instance', async () => {
            gitProviderService.getOrganizations.mockRejectedValue('string-thrown');

            const result = await controller.getOrganizations(req, 'github');

            expect(result).toEqual({
                success: false,
                organizations: [],
                error: 'Failed to fetch organizations',
            });
        });
    });

    describe('getRepositories', () => {
        it('parses page+perPage with parseInt(_, 10) and forwards to service', async () => {
            gitProviderService.getRepositories.mockResolvedValue([{ id: 'r1' }]);

            const result = await controller.getRepositories(req, 'github', '3', '25');

            expect(gitProviderService.getRepositories).toHaveBeenCalledWith(
                'user-1',
                'github',
                3,
                25,
            );
            expect(result).toEqual({ success: true, repositories: [{ id: 'r1' }] });
        });

        it('passes undefined when page/perPage are undefined (each independently undefined-able)', async () => {
            gitProviderService.getRepositories.mockResolvedValue([]);

            await controller.getRepositories(req, 'github');
            await controller.getRepositories(req, 'github', undefined, '10');
            await controller.getRepositories(req, 'github', '2', undefined);

            expect(gitProviderService.getRepositories.mock.calls).toEqual([
                ['user-1', 'github', undefined, undefined],
                ['user-1', 'github', undefined, 10],
                ['user-1', 'github', 2, undefined],
            ]);
        });

        it('returns { success: false, repositories: [], error: <message> } on Error rejection', async () => {
            gitProviderService.getRepositories.mockRejectedValue(new Error('forbidden'));

            const result = await controller.getRepositories(req, 'github');

            expect(result).toEqual({
                success: false,
                repositories: [],
                error: 'forbidden',
            });
        });

        it('returns generic error fallback when rejection is not an Error instance', async () => {
            gitProviderService.getRepositories.mockRejectedValue({ code: 502 });

            const result = await controller.getRepositories(req, 'github');

            expect(result).toEqual({
                success: false,
                repositories: [],
                error: 'Failed to fetch repositories',
            });
        });
    });

    describe('getUser', () => {
        it('returns { success: true, user } on success', async () => {
            gitProviderService.getUser.mockResolvedValue({ login: 'alice' });

            const result = await controller.getUser(req, 'github');

            expect(gitProviderService.getUser).toHaveBeenCalledWith('user-1', 'github');
            expect(result).toEqual({ success: true, user: { login: 'alice' } });
        });

        it('returns { success: false, user: null, error: <message> } on Error rejection', async () => {
            gitProviderService.getUser.mockRejectedValue(new Error('401'));

            const result = await controller.getUser(req, 'github');

            expect(result).toEqual({ success: false, user: null, error: '401' });
        });

        it('returns generic error fallback when rejection is not an Error instance', async () => {
            gitProviderService.getUser.mockRejectedValue(undefined);

            const result = await controller.getUser(req, 'github');

            expect(result).toEqual({
                success: false,
                user: null,
                error: 'Failed to fetch user',
            });
        });
    });
});
