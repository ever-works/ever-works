import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { GitHubAppController } from './github-app.controller';

jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/entities', () => ({}));
jest.mock('@ever-works/agent/import', () => ({}));
jest.mock('@ever-works/agent/services', () => ({}));
// Stub the auth barrel so importing AuthService doesn't pull in the full
// auth module (which transitively requires the agent runtime tree we
// can't satisfy in unit tests).
jest.mock('@src/auth', () => ({}));
jest.mock('@src/auth/decorators/public.decorator', () => ({
    Public: () => () => undefined,
}));
jest.mock('@src/auth/providers/auth-provider.abstract', () => ({}));
jest.mock('@src/auth/providers/auth-provider.constants', () => ({
    AUTH_PROVIDER: 'AUTH_PROVIDER',
}));

describe('GitHubAppController', () => {
    function createController() {
        const onboardingService = {
            beginSetup: jest.fn(),
            completeUserAuth: jest.fn(),
        };
        const syncService = {
            listInstallationsForUser: jest.fn(),
            syncInstallation: jest.fn(),
            onboardInstallationRepository: jest.fn(),
        };
        const authService = {
            getUser: jest.fn(),
        };
        const authProvider = {
            issueSession: jest.fn(),
        };

        const controller = new GitHubAppController(
            onboardingService as any,
            syncService as any,
            authService as any,
            authProvider as any,
        );

        return { controller, onboardingService, syncService, authService, authProvider };
    }

    describe('setup (GET /api/github-app/setup)', () => {
        it('forwards installation_id, setup_action, redirectTo to onboarding.beginSetup', async () => {
            const { controller, onboardingService } = createController();
            onboardingService.beginSetup.mockResolvedValue({ status: 'redirect' });

            const result = await controller.setup({
                installation_id: 'inst-1',
                setup_action: 'install',
                redirectTo: '/dashboard',
            } as any);

            expect(onboardingService.beginSetup).toHaveBeenCalledWith({
                installationId: 'inst-1',
                setupAction: 'install',
                redirectTo: '/dashboard',
            });
            expect(result).toEqual({ status: 'redirect' });
        });

        it('passes through undefined optional query params (setup_action, redirectTo)', async () => {
            const { controller, onboardingService } = createController();
            onboardingService.beginSetup.mockResolvedValue({});
            await controller.setup({ installation_id: 'inst-2' } as any);

            expect(onboardingService.beginSetup).toHaveBeenCalledWith({
                installationId: 'inst-2',
                setupAction: undefined,
                redirectTo: undefined,
            });
        });

        it('propagates errors from onboarding.beginSetup', async () => {
            const { controller, onboardingService } = createController();
            onboardingService.beginSetup.mockRejectedValue(new Error('beginSetup boom'));
            await expect(controller.setup({ installation_id: 'x' } as any)).rejects.toThrow(
                'beginSetup boom',
            );
        });
    });

    describe('callback (GET /api/github-app/callback)', () => {
        it('runs completeUserAuth → issueSession and merges installationId+redirectTo into the session payload', async () => {
            const { controller, onboardingService, authProvider } = createController();
            onboardingService.completeUserAuth.mockResolvedValue({
                user: { id: 'u1' },
                installation: { installationId: 'inst-1' },
                redirectTo: '/post-auth',
            });
            authProvider.issueSession.mockResolvedValue({
                accessToken: 'tok',
                refreshToken: 'rtok',
                user: { id: 'u1' },
            });

            const result = await controller.callback({ code: 'c', state: 's' } as any);

            expect(onboardingService.completeUserAuth).toHaveBeenCalledWith({
                code: 'c',
                state: 's',
            });
            expect(authProvider.issueSession).toHaveBeenCalledWith('u1');
            expect(result).toEqual({
                accessToken: 'tok',
                refreshToken: 'rtok',
                user: { id: 'u1' },
                installationId: 'inst-1',
                redirectTo: '/post-auth',
            });
        });

        it('does not call issueSession when completeUserAuth fails', async () => {
            const { controller, onboardingService, authProvider } = createController();
            onboardingService.completeUserAuth.mockRejectedValue(new Error('auth failed'));
            await expect(controller.callback({ code: 'c', state: 's' } as any)).rejects.toThrow(
                'auth failed',
            );
            expect(authProvider.issueSession).not.toHaveBeenCalled();
        });

        it('propagates redirectTo undefined → undefined (no default)', async () => {
            const { controller, onboardingService, authProvider } = createController();
            onboardingService.completeUserAuth.mockResolvedValue({
                user: { id: 'u1' },
                installation: { installationId: 'inst-1' },
                // redirectTo intentionally omitted
            });
            authProvider.issueSession.mockResolvedValue({ accessToken: 'a' });

            const result = await controller.callback({ code: 'c', state: 's' } as any);
            expect(result.redirectTo).toBeUndefined();
            expect(result.installationId).toBe('inst-1');
        });
    });

    describe('listInstallations (GET /api/github-app/installations)', () => {
        it('forwards req.user.userId to syncService.listInstallationsForUser', async () => {
            const { controller, syncService } = createController();
            syncService.listInstallationsForUser.mockResolvedValue([{ id: 'i1' }]);

            const result = await controller.listInstallations({
                user: { userId: 'u-42' },
            } as any);
            expect(syncService.listInstallationsForUser).toHaveBeenCalledWith('u-42');
            expect(result).toEqual([{ id: 'i1' }]);
        });
    });

    describe('syncInstallation (POST /api/github-app/installations/:installationId/sync)', () => {
        it('returns the installation when syncInstallation resolves with one', async () => {
            const { controller, syncService } = createController();
            const fake = { id: 'inst-1', repositories: [] };
            syncService.syncInstallation.mockResolvedValue(fake);

            const result = await controller.syncInstallation('inst-1', {
                user: { userId: 'u1' },
            } as any);
            expect(syncService.syncInstallation).toHaveBeenCalledWith('inst-1', 'u1');
            expect(result).toBe(fake);
        });

        it('throws UnauthorizedException when syncInstallation resolves to null', async () => {
            const { controller, syncService } = createController();
            syncService.syncInstallation.mockResolvedValue(null);

            await expect(
                controller.syncInstallation('inst-1', { user: { userId: 'u1' } } as any),
            ).rejects.toThrow(UnauthorizedException);
            await expect(
                controller.syncInstallation('inst-1', { user: { userId: 'u1' } } as any),
            ).rejects.toThrow('GitHub App installation not found for this user');
        });

        it('throws UnauthorizedException when syncInstallation resolves to undefined', async () => {
            const { controller, syncService } = createController();
            syncService.syncInstallation.mockResolvedValue(undefined);
            await expect(
                controller.syncInstallation('inst-x', { user: { userId: 'u1' } } as any),
            ).rejects.toThrow(UnauthorizedException);
        });

        it('propagates errors from syncInstallation', async () => {
            const { controller, syncService } = createController();
            syncService.syncInstallation.mockRejectedValue(new Error('sync boom'));
            await expect(
                controller.syncInstallation('inst-1', { user: { userId: 'u1' } } as any),
            ).rejects.toThrow('sync boom');
        });
    });

    describe('onboardRepository (POST .../installations/:installationId/repositories/:repositoryId/onboard)', () => {
        it('happy path: getUser then onboardInstallationRepository, returns success result', async () => {
            const { controller, authService, syncService } = createController();
            const user = { id: 'u1', email: 'u@example.com' };
            authService.getUser.mockResolvedValue(user);
            const successResult = {
                status: 'ok',
                workId: 'w1',
                repositoryId: 'r1',
            };
            syncService.onboardInstallationRepository.mockResolvedValue(successResult);

            const result = await controller.onboardRepository('inst-1', 'r1', {
                user: { userId: 'u1' },
            } as any);
            expect(authService.getUser).toHaveBeenCalledWith('u1');
            expect(syncService.onboardInstallationRepository).toHaveBeenCalledWith(
                'inst-1',
                'r1',
                user,
            );
            expect(result).toBe(successResult);
        });

        it('throws NotFoundException when onboardInstallationRepository returns falsy', async () => {
            const { controller, authService, syncService } = createController();
            authService.getUser.mockResolvedValue({ id: 'u1' });
            syncService.onboardInstallationRepository.mockResolvedValue(null);

            await expect(
                controller.onboardRepository('inst-1', 'r1', {
                    user: { userId: 'u1' },
                } as any),
            ).rejects.toThrow(NotFoundException);
            await expect(
                controller.onboardRepository('inst-1', 'r1', {
                    user: { userId: 'u1' },
                } as any),
            ).rejects.toThrow('GitHub App repository not found for this user');
        });

        it('throws BadRequestException with the error message when result.status === "error"', async () => {
            const { controller, authService, syncService } = createController();
            authService.getUser.mockResolvedValue({ id: 'u1' });
            syncService.onboardInstallationRepository.mockResolvedValue({
                status: 'error',
                message: 'repo already onboarded',
            });

            await expect(
                controller.onboardRepository('inst-1', 'r1', {
                    user: { userId: 'u1' },
                } as any),
            ).rejects.toThrow(BadRequestException);
            await expect(
                controller.onboardRepository('inst-1', 'r1', {
                    user: { userId: 'u1' },
                } as any),
            ).rejects.toThrow('repo already onboarded');
        });

        it('does not call onboardInstallationRepository if getUser fails', async () => {
            const { controller, authService, syncService } = createController();
            authService.getUser.mockRejectedValue(new Error('user lookup failed'));
            await expect(
                controller.onboardRepository('inst-1', 'r1', {
                    user: { userId: 'u1' },
                } as any),
            ).rejects.toThrow('user lookup failed');
            expect(syncService.onboardInstallationRepository).not.toHaveBeenCalled();
        });
    });
});
