jest.mock('@ever-works/agent/database', () => ({ WorkRepository: class {} }));
jest.mock('@ever-works/agent/entities', () => ({
    Work: class {},
    User: class {},
    ActivityActionType: { DEPLOYMENT: 'deployment' },
    ActivityStatus: { COMPLETED: 'completed' },
}));
jest.mock('@ever-works/agent/plugins', () => ({ PluginRegistryService: class {} }));
jest.mock('@ever-works/agent/facades', () => ({
    DeployFacadeService: class {},
    GitFacadeService: class {},
}));
jest.mock('@ever-works/agent/services', () => ({
    WorkOwnershipService: class {},
    WorkModule: class {},
}));
jest.mock('@ever-works/agent/activity-log', () => ({ ActivityLogService: class {} }));
jest.mock('@ever-works/agent/generators', () => ({
    WebsiteUpdateService: class {},
    WebsiteGeneratorModule: class {},
}));
jest.mock('@ever-works/agent/events', () => ({
    DeploymentDispatchedEvent: class {
        static EVENT_NAME = 'deployment.dispatched';
        constructor(public readonly payload: unknown) {}
    },
}));
jest.mock('../../auth', () => ({
    AuthSessionGuard: class {},
    CurrentUser: () => () => undefined,
}));

import { BadRequestException } from '@nestjs/common';
import { DeployController } from './deploy.controller';
import type { DeployFacadeService } from '@ever-works/agent/facades';
import type { WorkOwnershipService } from '@ever-works/agent/services';
import type { ActivityLogService } from '@ever-works/agent/activity-log';
import type { DeployService } from './deploy.service';
import type { DeploymentVerifierService } from './tasks/deployment-verifier.service';
import type { AuthenticatedUser } from '../../auth/types/auth.types';

describe('DeployController', () => {
    const auth: AuthenticatedUser = { userId: 'caller-1' } as any;
    let deployService: {
        deploy: jest.Mock;
        deployBatch: jest.Mock;
    };
    let deployFacade: {
        getAvailableProviders: jest.Mock;
        getAvailableProvidersForUser: jest.Mock;
        isProviderConfigured: jest.Mock;
        isConfigured: jest.Mock;
        validateToken: jest.Mock;
        getTeams: jest.Mock;
        getDomains: jest.Mock;
        addDomain: jest.Mock;
        removeDomain: jest.Mock;
        verifyDomain: jest.Mock;
    };
    let ownershipService: {
        ensureCanEdit: jest.Mock;
        ensureCanView: jest.Mock;
    };
    let deploymentVerifier: {
        startVerification: jest.Mock;
        lookupExistingDeployment: jest.Mock;
    };
    let activityLogService: { log: jest.Mock };
    let controller: DeployController;

    const buildWork = (overrides: Record<string, unknown> = {}) => ({
        id: 'work-1',
        slug: 'my-site',
        name: 'My Site',
        deployProvider: 'vercel',
        website: 'https://my-site.example',
        deploymentState: { status: 'IDLE' },
        user: { id: 'owner-1' },
        getRepoOwner: jest.fn().mockReturnValue('acme'),
        getWebsiteRepo: jest.fn().mockReturnValue('acme-site'),
        ...overrides,
    });

    beforeEach(() => {
        deployService = {
            deploy: jest.fn(),
            deployBatch: jest.fn(),
        };
        deployFacade = {
            getAvailableProviders: jest.fn(),
            getAvailableProvidersForUser: jest.fn(),
            isProviderConfigured: jest.fn(),
            isConfigured: jest.fn(),
            validateToken: jest.fn(),
            getTeams: jest.fn(),
            getDomains: jest.fn(),
            addDomain: jest.fn(),
            removeDomain: jest.fn(),
            verifyDomain: jest.fn(),
        };
        ownershipService = {
            ensureCanEdit: jest.fn(),
            ensureCanView: jest.fn(),
        };
        deploymentVerifier = {
            startVerification: jest.fn(),
            lookupExistingDeployment: jest.fn(),
        };
        activityLogService = { log: jest.fn().mockResolvedValue(undefined) };

        controller = new DeployController(
            deployService as unknown as DeployService,
            deployFacade as unknown as DeployFacadeService,
            ownershipService as unknown as WorkOwnershipService,
            deploymentVerifier as unknown as DeploymentVerifierService,
            activityLogService as unknown as ActivityLogService,
        );
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('listProviders', () => {
        it('returns user-scoped providers in success envelope', async () => {
            const providers = [{ id: 'vercel', name: 'Vercel', enabled: true }];
            deployFacade.getAvailableProvidersForUser.mockResolvedValue(providers);

            const result = await controller.listProviders(auth);

            expect(deployFacade.getAvailableProvidersForUser).toHaveBeenCalledWith('caller-1');
            expect(result).toEqual({ status: 'success', providers });
        });

        it('preserves an empty providers array verbatim (no fallback)', async () => {
            deployFacade.getAvailableProvidersForUser.mockResolvedValue([]);
            const result = await controller.listProviders(auth);
            expect(result).toEqual({ status: 'success', providers: [] });
        });
    });

    describe('isProviderConfigured', () => {
        it('returns the unavailable envelope when provider id not in available list', async () => {
            deployFacade.getAvailableProviders.mockReturnValue([
                { id: 'vercel', name: 'Vercel', enabled: true },
            ]);

            const result = await controller.isProviderConfigured(auth, 'netlify');

            expect(deployFacade.isProviderConfigured).not.toHaveBeenCalled();
            expect(result).toEqual({
                status: 'success',
                configured: false,
                available: false,
                message: "Provider 'netlify' is not available",
            });
        });

        it('returns the disabled envelope when provider exists but is not enabled', async () => {
            deployFacade.getAvailableProviders.mockReturnValue([
                { id: 'vercel', name: 'Vercel', enabled: false },
            ]);

            const result = await controller.isProviderConfigured(auth, 'vercel');

            expect(deployFacade.isProviderConfigured).not.toHaveBeenCalled();
            expect(result).toEqual({
                status: 'success',
                configured: false,
                available: true,
                enabled: false,
                message: "Provider 'vercel' is not enabled",
            });
        });

        it('returns configured:true with the configured-message when enabled and configured', async () => {
            deployFacade.getAvailableProviders.mockReturnValue([
                { id: 'vercel', name: 'Vercel', enabled: true },
            ]);
            deployFacade.isProviderConfigured.mockResolvedValue(true);

            const result = await controller.isProviderConfigured(auth, 'vercel');

            expect(deployFacade.isProviderConfigured).toHaveBeenCalledWith('vercel', 'caller-1');
            expect(result).toEqual({
                status: 'success',
                configured: true,
                available: true,
                enabled: true,
                message: "Provider 'vercel' is configured.",
            });
        });

        it('returns configured:false with the not-configured-message when enabled but unconfigured', async () => {
            deployFacade.getAvailableProviders.mockReturnValue([
                { id: 'vercel', name: 'Vercel', enabled: true },
            ]);
            deployFacade.isProviderConfigured.mockResolvedValue(false);

            const result = await controller.isProviderConfigured(auth, 'vercel');

            expect(result).toEqual({
                status: 'success',
                configured: false,
                available: true,
                enabled: true,
                message: "Provider 'vercel' is available but not configured.",
            });
        });
    });

    describe('deploy', () => {
        const dto = { teamScope: 'team-x' } as any;

        it('rejects with provider-token-required when caller is creator and not configured', async () => {
            const work = buildWork({ user: { id: 'caller-1' }, deployProvider: 'vercel' });
            ownershipService.ensureCanEdit.mockResolvedValue({ work, isCreator: true });
            deployFacade.getAvailableProviders.mockReturnValue([
                { id: 'vercel', name: 'Vercel', enabled: true },
            ]);
            deployFacade.isConfigured.mockResolvedValue(false);

            await expect(controller.deploy(auth, dto, 'work-1')).rejects.toBeInstanceOf(
                BadRequestException,
            );

            expect(deployFacade.isConfigured).toHaveBeenCalledWith({
                userId: 'caller-1',
                workId: 'work-1',
            });
            expect(deployFacade.validateToken).not.toHaveBeenCalled();
            expect(deployService.deploy).not.toHaveBeenCalled();
            expect(deploymentVerifier.startVerification).not.toHaveBeenCalled();
            expect(activityLogService.log).not.toHaveBeenCalled();
        });

        it('rejects with owner-not-configured message when caller is NOT creator', async () => {
            const work = buildWork({ user: { id: 'owner-1' }, deployProvider: 'vercel' });
            ownershipService.ensureCanEdit.mockResolvedValue({ work, isCreator: false });
            deployFacade.getAvailableProviders.mockReturnValue([
                { id: 'vercel', name: 'Vercel', enabled: true },
            ]);
            deployFacade.isConfigured.mockResolvedValue(false);

            await expect(controller.deploy(auth, dto, 'work-1')).rejects.toMatchObject({
                response: {
                    status: 'error',
                    message: 'The work owner has not configured Vercel credentials.',
                },
            });

            // shared-work falls back to owner's userId for the check
            expect(deployFacade.isConfigured).toHaveBeenCalledWith({
                userId: 'owner-1',
                workId: 'work-1',
            });
        });

        it('falls back to deploy-provider id verbatim when getAvailableProviders has no match for that id', async () => {
            const work = buildWork({ user: { id: 'caller-1' }, deployProvider: 'mystery' });
            ownershipService.ensureCanEdit.mockResolvedValue({ work, isCreator: true });
            // available providers does NOT include 'mystery' — controller falls
            // back to the literal id in the error message.
            deployFacade.getAvailableProviders.mockReturnValue([
                { id: 'vercel', name: 'Vercel', enabled: true },
            ]);
            deployFacade.isConfigured.mockResolvedValue(false);

            await expect(controller.deploy(auth, dto, 'work-1')).rejects.toMatchObject({
                response: {
                    message: 'mystery token is required. Please configure it in Plugin Settings.',
                },
            });
        });

        it('uses the literal "Deployment" label when work.deployProvider is undefined', async () => {
            const work = buildWork({ user: { id: 'caller-1' }, deployProvider: undefined });
            ownershipService.ensureCanEdit.mockResolvedValue({ work, isCreator: true });
            deployFacade.isConfigured.mockResolvedValue(false);

            await expect(controller.deploy(auth, dto, 'work-1')).rejects.toMatchObject({
                response: {
                    message:
                        'Deployment token is required. Please configure it in Plugin Settings.',
                },
            });

            // getAvailableProviders is short-circuited before being called (no provider id to look up)
            expect(deployFacade.getAvailableProviders).not.toHaveBeenCalled();
        });

        it('rejects with invalid-token message when token validation fails', async () => {
            const work = buildWork({ user: { id: 'caller-1' }, deployProvider: 'vercel' });
            ownershipService.ensureCanEdit.mockResolvedValue({ work, isCreator: true });
            deployFacade.getAvailableProviders.mockReturnValue([
                { id: 'vercel', name: 'Vercel', enabled: true },
            ]);
            deployFacade.isConfigured.mockResolvedValue(true);
            deployFacade.validateToken.mockResolvedValue(false);

            await expect(controller.deploy(auth, dto, 'work-1')).rejects.toMatchObject({
                response: {
                    status: 'error',
                    message: 'Invalid Vercel token. Please check your token in Plugin Settings.',
                },
            });

            expect(deployService.deploy).not.toHaveBeenCalled();
            expect(deploymentVerifier.startVerification).not.toHaveBeenCalled();
            expect(activityLogService.log).not.toHaveBeenCalled();
        });

        it('rejects with failed-to-initiate message when deployService returns falsy', async () => {
            const work = buildWork({ user: { id: 'caller-1' }, deployProvider: 'vercel' });
            ownershipService.ensureCanEdit.mockResolvedValue({ work, isCreator: true });
            deployFacade.getAvailableProviders.mockReturnValue([
                { id: 'vercel', name: 'Vercel', enabled: true },
            ]);
            deployFacade.isConfigured.mockResolvedValue(true);
            deployFacade.validateToken.mockResolvedValue(true);
            deployService.deploy.mockResolvedValue(false);

            await expect(controller.deploy(auth, dto, 'work-1')).rejects.toMatchObject({
                response: {
                    message:
                        'Failed to initiate Vercel deployment. Check that the repository has the provider workflow configured.',
                },
            });

            expect(deploymentVerifier.startVerification).not.toHaveBeenCalled();
            expect(activityLogService.log).not.toHaveBeenCalled();
        });

        it('happy path runs ensureCanEdit → isConfigured → validateToken → deploy → startVerification → log in order', async () => {
            const work = buildWork({ user: { id: 'caller-1' }, deployProvider: 'vercel' });
            ownershipService.ensureCanEdit.mockResolvedValue({ work, isCreator: true });
            deployFacade.getAvailableProviders.mockReturnValue([
                { id: 'vercel', name: 'Vercel', enabled: true },
            ]);
            deployFacade.isConfigured.mockResolvedValue(true);
            deployFacade.validateToken.mockResolvedValue(true);
            deployService.deploy.mockResolvedValue(true);

            const order: string[] = [];
            ownershipService.ensureCanEdit.mockImplementation(async () => {
                order.push('ensureCanEdit');
                return { work, isCreator: true };
            });
            deployFacade.isConfigured.mockImplementation(async () => {
                order.push('isConfigured');
                return true;
            });
            deployFacade.validateToken.mockImplementation(async () => {
                order.push('validateToken');
                return true;
            });
            deployService.deploy.mockImplementation(async () => {
                order.push('deploy');
                return true;
            });
            deploymentVerifier.startVerification.mockImplementation(() => {
                order.push('startVerification');
            });
            activityLogService.log.mockImplementation(async () => {
                order.push('log');
            });

            const result = await controller.deploy(auth, dto, 'work-1');

            expect(order).toEqual([
                'ensureCanEdit',
                'isConfigured',
                'validateToken',
                'deploy',
                'startVerification',
                'log',
            ]);

            expect(deployService.deploy).toHaveBeenCalledWith('work-1', 'caller-1', {
                teamScope: 'team-x',
            });
            expect(deploymentVerifier.startVerification).toHaveBeenCalledWith(
                work,
                'caller-1',
                'team-x',
            );
            expect(activityLogService.log).toHaveBeenCalledWith({
                userId: 'caller-1',
                workId: 'work-1',
                actionType: 'deployment',
                action: 'work.deployed',
                status: 'completed',
                summary: 'Triggered deployment for My Site via Vercel',
            });

            expect(result).toEqual({
                status: 'pending',
                slug: 'my-site',
                owner: 'acme',
                repository: 'acme/acme-site',
                message: 'Deployment started',
            });
        });

        it('non-creator path forwards owner.userId to deploy + startVerification', async () => {
            const work = buildWork({ user: { id: 'owner-1' }, deployProvider: 'vercel' });
            ownershipService.ensureCanEdit.mockResolvedValue({ work, isCreator: false });
            deployFacade.getAvailableProviders.mockReturnValue([
                { id: 'vercel', name: 'Vercel', enabled: true },
            ]);
            deployFacade.isConfigured.mockResolvedValue(true);
            deployFacade.validateToken.mockResolvedValue(true);
            deployService.deploy.mockResolvedValue(true);

            await controller.deploy(auth, dto, 'work-1');

            expect(deployService.deploy).toHaveBeenCalledWith('work-1', 'owner-1', {
                teamScope: 'team-x',
            });
            expect(deploymentVerifier.startVerification).toHaveBeenCalledWith(
                work,
                'owner-1',
                'team-x',
            );
            // log payload userId is ALWAYS the caller, not the owner — pinned
            expect(activityLogService.log).toHaveBeenCalledWith(
                expect.objectContaining({ userId: 'caller-1' }),
            );
        });

        it('swallows fire-and-forget activity-log rejection without breaking the response', async () => {
            const work = buildWork({ user: { id: 'caller-1' }, deployProvider: 'vercel' });
            ownershipService.ensureCanEdit.mockResolvedValue({ work, isCreator: true });
            deployFacade.getAvailableProviders.mockReturnValue([
                { id: 'vercel', name: 'Vercel', enabled: true },
            ]);
            deployFacade.isConfigured.mockResolvedValue(true);
            deployFacade.validateToken.mockResolvedValue(true);
            deployService.deploy.mockResolvedValue(true);
            activityLogService.log.mockRejectedValue(new Error('log down'));

            const result = await controller.deploy(auth, dto, 'work-1');

            expect(result.status).toBe('pending');
        });
    });

    describe('validateToken', () => {
        it('returns valid:true when at least one configured + enabled provider exists', async () => {
            deployFacade.getAvailableProvidersForUser.mockResolvedValue([
                { id: 'vercel', enabled: true, configured: true, name: 'Vercel' },
                { id: 'netlify', enabled: false, configured: true, name: 'Netlify' },
            ]);

            const result = await controller.validateToken(auth);

            expect(deployFacade.getAvailableProvidersForUser).toHaveBeenCalledWith('caller-1');
            expect(result).toEqual({
                status: 'success',
                valid: true,
                userInfo: null,
                message:
                    'Deployment provider is available. Token will be validated during deployment.',
            });
        });

        it('returns valid:false with the no-provider message when no provider matches both flags', async () => {
            deployFacade.getAvailableProvidersForUser.mockResolvedValue([
                { id: 'vercel', enabled: true, configured: false, name: 'Vercel' },
                { id: 'netlify', enabled: false, configured: true, name: 'Netlify' },
            ]);

            const result = await controller.validateToken(auth);

            expect(result).toEqual({
                status: 'success',
                valid: false,
                userInfo: null,
                message: 'No deployment provider is available.',
            });
        });

        it('returns valid:false on empty provider list', async () => {
            deployFacade.getAvailableProvidersForUser.mockResolvedValue([]);
            const result = await controller.validateToken(auth);
            expect(result.valid).toBe(false);
        });
    });

    describe('getDeploymentTeams', () => {
        it('returns the placeholder envelope (the endpoint is a stub awaiting work-context migration)', async () => {
            const result = await controller.getDeploymentTeams(auth);
            expect(result).toEqual({
                status: 'success',
                teams: [],
                message:
                    'To fetch teams, use the work-specific endpoint or configure your token in Plugin Settings.',
            });
        });
    });

    describe('getTeamsForWork', () => {
        it('forwards effective userId (creator) to facade.getTeams and returns success envelope', async () => {
            const work = buildWork({ user: { id: 'caller-1' } });
            ownershipService.ensureCanView.mockResolvedValue({ work, isCreator: true });
            deployFacade.getAvailableProviders.mockReturnValue([
                { id: 'vercel', name: 'Vercel', enabled: true },
            ]);
            const teams = [{ id: 't-1', name: 'Team 1' }];
            deployFacade.getTeams.mockResolvedValue(teams);

            const result = await controller.getTeamsForWork(auth, 'work-1');

            expect(deployFacade.getTeams).toHaveBeenCalledWith({
                userId: 'caller-1',
                workId: 'work-1',
            });
            expect(result).toEqual({ status: 'success', teams });
        });

        it('falls back to owner.userId when caller is shared (isCreator:false)', async () => {
            const work = buildWork({ user: { id: 'owner-1' } });
            ownershipService.ensureCanView.mockResolvedValue({ work, isCreator: false });
            deployFacade.getAvailableProviders.mockReturnValue([
                { id: 'vercel', name: 'Vercel', enabled: true },
            ]);
            deployFacade.getTeams.mockResolvedValue([]);

            await controller.getTeamsForWork(auth, 'work-1');

            expect(deployFacade.getTeams).toHaveBeenCalledWith({
                userId: 'owner-1',
                workId: 'work-1',
            });
        });

        it('wraps facade Errors into BadRequestException carrying the original message', async () => {
            const work = buildWork({ user: { id: 'caller-1' }, deployProvider: 'vercel' });
            ownershipService.ensureCanView.mockResolvedValue({ work, isCreator: true });
            deployFacade.getAvailableProviders.mockReturnValue([
                { id: 'vercel', name: 'Vercel', enabled: true },
            ]);
            deployFacade.getTeams.mockRejectedValue(new Error('teams api down'));

            await expect(controller.getTeamsForWork(auth, 'work-1')).rejects.toMatchObject({
                response: { status: 'error', message: 'teams api down' },
            });
        });

        it('falls back to provider-name-based message when error has no message', async () => {
            const work = buildWork({ user: { id: 'caller-1' }, deployProvider: 'vercel' });
            ownershipService.ensureCanView.mockResolvedValue({ work, isCreator: true });
            deployFacade.getAvailableProviders.mockReturnValue([
                { id: 'vercel', name: 'Vercel', enabled: true },
            ]);
            // truthy non-Error rejection without a `.message` property
            deployFacade.getTeams.mockRejectedValue({});

            await expect(controller.getTeamsForWork(auth, 'work-1')).rejects.toMatchObject({
                response: {
                    message:
                        'Failed to get teams. Please configure your Vercel token in Plugin Settings.',
                },
            });
        });
    });

    describe('checkDeploymentCapability', () => {
        it('returns canDeploy + isShared (false) + ownerHasToken + userHasToken when caller is creator', async () => {
            const work = buildWork({ user: { id: 'caller-1' } });
            ownershipService.ensureCanView.mockResolvedValue({ work, isCreator: true });
            // sequence: canDeploy (caller), ownerHasToken (owner), userHasToken (caller)
            deployFacade.isConfigured
                .mockResolvedValueOnce(true)
                .mockResolvedValueOnce(true)
                .mockResolvedValueOnce(true);

            const result = await controller.checkDeploymentCapability(auth, 'work-1');

            expect(deployFacade.isConfigured).toHaveBeenCalledTimes(3);
            expect(deployFacade.isConfigured).toHaveBeenNthCalledWith(1, {
                userId: 'caller-1',
                workId: 'work-1',
            });
            expect(deployFacade.isConfigured).toHaveBeenNthCalledWith(2, {
                userId: 'caller-1',
                workId: 'work-1',
            });
            expect(deployFacade.isConfigured).toHaveBeenNthCalledWith(3, {
                userId: 'caller-1',
                workId: 'work-1',
            });
            expect(result).toEqual({
                status: 'success',
                canDeploy: true,
                isShared: false,
                ownerHasToken: true,
                userHasToken: true,
            });
        });

        it('isShared:true and canDeploy uses owner.userId when caller is NOT creator', async () => {
            const work = buildWork({ user: { id: 'owner-1' } });
            ownershipService.ensureCanView.mockResolvedValue({ work, isCreator: false });
            deployFacade.isConfigured
                .mockResolvedValueOnce(false) // canDeploy (owner — falls back when not creator)
                .mockResolvedValueOnce(true) // ownerHasToken
                .mockResolvedValueOnce(false); // userHasToken (caller)

            const result = await controller.checkDeploymentCapability(auth, 'work-1');

            expect(deployFacade.isConfigured).toHaveBeenNthCalledWith(1, {
                userId: 'owner-1',
                workId: 'work-1',
            });
            expect(deployFacade.isConfigured).toHaveBeenNthCalledWith(2, {
                userId: 'owner-1',
                workId: 'work-1',
            });
            expect(deployFacade.isConfigured).toHaveBeenNthCalledWith(3, {
                userId: 'caller-1',
                workId: 'work-1',
            });
            expect(result).toEqual({
                status: 'success',
                canDeploy: false,
                isShared: true,
                ownerHasToken: true,
                userHasToken: false,
            });
        });
    });

    describe('lookupExistingDeployment', () => {
        it('short-circuits with found:true when work.website is already populated', async () => {
            const work = buildWork({
                user: { id: 'caller-1' },
                website: 'https://existing.example',
                deploymentState: { status: 'COMPLETED' },
            });
            ownershipService.ensureCanView.mockResolvedValue({ work, isCreator: true });

            const result = await controller.lookupExistingDeployment(auth, 'work-1');

            expect(deployFacade.isConfigured).not.toHaveBeenCalled();
            expect(deploymentVerifier.lookupExistingDeployment).not.toHaveBeenCalled();
            expect(result).toEqual({
                status: 'success',
                website: 'https://existing.example',
                deploymentState: { status: 'COMPLETED' },
                found: true,
            });
        });

        it('rejects with provider-token message when caller-creator and not configured (no website yet)', async () => {
            const work = buildWork({
                user: { id: 'caller-1' },
                website: null,
                deployProvider: 'vercel',
            });
            ownershipService.ensureCanView.mockResolvedValue({ work, isCreator: true });
            deployFacade.getAvailableProviders.mockReturnValue([
                { id: 'vercel', name: 'Vercel', enabled: true },
            ]);
            deployFacade.isConfigured.mockResolvedValue(false);

            await expect(controller.lookupExistingDeployment(auth, 'work-1')).rejects.toMatchObject(
                {
                    response: {
                        message:
                            'Vercel token is required to lookup deployments. Configure it in Plugin Settings.',
                    },
                },
            );
        });

        it('rejects with owner-not-configured message when caller is shared and owner missing token', async () => {
            const work = buildWork({
                user: { id: 'owner-1' },
                website: null,
                deployProvider: 'vercel',
            });
            ownershipService.ensureCanView.mockResolvedValue({ work, isCreator: false });
            deployFacade.getAvailableProviders.mockReturnValue([
                { id: 'vercel', name: 'Vercel', enabled: true },
            ]);
            deployFacade.isConfigured.mockResolvedValue(false);

            await expect(controller.lookupExistingDeployment(auth, 'work-1')).rejects.toMatchObject(
                {
                    response: {
                        message: 'The work owner has not configured Vercel credentials.',
                    },
                },
            );

            expect(deployFacade.isConfigured).toHaveBeenCalledWith({
                userId: 'owner-1',
                workId: 'work-1',
            });
        });

        it('forwards verifier result fields verbatim (website, deploymentState, found)', async () => {
            const work = buildWork({
                user: { id: 'caller-1' },
                website: null,
                deployProvider: 'vercel',
            });
            ownershipService.ensureCanView.mockResolvedValue({ work, isCreator: true });
            deployFacade.getAvailableProviders.mockReturnValue([
                { id: 'vercel', name: 'Vercel', enabled: true },
            ]);
            deployFacade.isConfigured.mockResolvedValue(true);
            deploymentVerifier.lookupExistingDeployment.mockResolvedValue({
                website: 'https://found.example',
                deploymentState: { status: 'COMPLETED' },
                found: true,
            });

            const result = await controller.lookupExistingDeployment(auth, 'work-1');

            expect(deploymentVerifier.lookupExistingDeployment).toHaveBeenCalledWith(
                work,
                'caller-1',
            );
            expect(result).toEqual({
                status: 'success',
                website: 'https://found.example',
                deploymentState: { status: 'COMPLETED' },
                found: true,
            });
        });

        it('uses owner userId when caller is shared and verifier is consulted', async () => {
            const work = buildWork({
                user: { id: 'owner-1' },
                website: null,
                deployProvider: 'vercel',
            });
            ownershipService.ensureCanView.mockResolvedValue({ work, isCreator: false });
            deployFacade.getAvailableProviders.mockReturnValue([
                { id: 'vercel', name: 'Vercel', enabled: true },
            ]);
            deployFacade.isConfigured.mockResolvedValue(true);
            deploymentVerifier.lookupExistingDeployment.mockResolvedValue({
                website: null,
                deploymentState: null,
                found: false,
            });

            await controller.lookupExistingDeployment(auth, 'work-1');

            expect(deploymentVerifier.lookupExistingDeployment).toHaveBeenCalledWith(
                work,
                'owner-1',
            );
        });
    });

    describe('batchDeploy', () => {
        it('runs ensureCanEdit for every item up-front (before deployBatch)', async () => {
            const dto = {
                works: [{ workId: 'a' }, { workId: 'b' }, { workId: 'c' }],
                teamScope: 'team-x',
            } as any;
            const order: string[] = [];
            ownershipService.ensureCanEdit.mockImplementation(async (id: string) => {
                order.push(`ensureCanEdit:${id}`);
                return { work: buildWork({ id }), isCreator: true };
            });
            deployService.deployBatch.mockImplementation(async () => {
                order.push('deployBatch');
                return {
                    totalRequested: 3,
                    successfullyStarted: 0,
                    failed: 0,
                    results: [],
                };
            });

            await controller.batchDeploy(auth, dto);

            expect(order.slice(0, 3)).toEqual([
                'ensureCanEdit:a',
                'ensureCanEdit:b',
                'ensureCanEdit:c',
            ]);
            expect(order[3]).toBe('deployBatch');
            expect(deployService.deployBatch).toHaveBeenCalledWith(dto.works, 'caller-1', 'team-x');
        });

        it('coerces status to "success" when failed === 0', async () => {
            ownershipService.ensureCanEdit.mockResolvedValue({
                work: buildWork(),
                isCreator: true,
            });
            deployService.deployBatch.mockResolvedValue({
                totalRequested: 2,
                successfullyStarted: 2,
                failed: 0,
                results: [
                    { workId: 'a', slug: 'a', status: 'pending', message: 'ok' },
                    { workId: 'b', slug: 'b', status: 'pending', message: 'ok' },
                ],
            });

            const result = await controller.batchDeploy(auth, {
                works: [{ workId: 'a' }, { workId: 'b' }],
            } as any);

            expect(result.status).toBe('success');
            expect(result.message).toBe('Batch deployment: 2 started, 0 failed');
        });

        it('coerces status to "partial" when failed>0 AND successfullyStarted>0', async () => {
            ownershipService.ensureCanEdit.mockResolvedValue({
                work: buildWork(),
                isCreator: true,
            });
            deployService.deployBatch.mockResolvedValue({
                totalRequested: 2,
                successfullyStarted: 1,
                failed: 1,
                results: [
                    { workId: 'a', slug: 'a', status: 'pending', message: 'ok' },
                    { workId: 'b', slug: 'b', status: 'error', message: 'boom' },
                ],
            });

            const result = await controller.batchDeploy(auth, {
                works: [{ workId: 'a' }, { workId: 'b' }],
            } as any);

            expect(result.status).toBe('partial');
        });

        it('coerces status to "error" when successfullyStarted === 0 AND failed > 0', async () => {
            ownershipService.ensureCanEdit.mockResolvedValue({
                work: buildWork(),
                isCreator: true,
            });
            deployService.deployBatch.mockResolvedValue({
                totalRequested: 1,
                successfullyStarted: 0,
                failed: 1,
                results: [{ workId: 'a', slug: 'a', status: 'error', message: 'boom' }],
            });

            const result = await controller.batchDeploy(auth, {
                works: [{ workId: 'a' }],
            } as any);

            expect(result.status).toBe('error');
        });

        it('starts verification ONLY for results with status === "pending" AND a workId', async () => {
            ownershipService.ensureCanEdit.mockResolvedValue({
                work: buildWork(),
                isCreator: true,
            });
            deployService.deployBatch.mockResolvedValue({
                totalRequested: 3,
                successfullyStarted: 2,
                failed: 1,
                results: [
                    { workId: 'a', slug: 'a', status: 'pending', message: 'ok' },
                    { workId: 'b', slug: 'b', status: 'pending', message: 'ok' },
                    { workId: 'c', slug: 'c', status: 'error', message: 'boom' },
                ],
            });

            await controller.batchDeploy(auth, {
                works: [{ workId: 'a' }, { workId: 'b' }, { workId: 'c' }],
                teamScope: 'team-x',
            } as any);

            expect(deploymentVerifier.startVerification).toHaveBeenCalledTimes(2);
            expect(deploymentVerifier.startVerification).toHaveBeenCalledWith(
                expect.anything(),
                'caller-1',
                'team-x',
            );
        });

        it('does NOT start verification for pending results with missing workId (defensive)', async () => {
            ownershipService.ensureCanEdit.mockResolvedValue({
                work: buildWork(),
                isCreator: true,
            });
            deployService.deployBatch.mockResolvedValue({
                totalRequested: 1,
                successfullyStarted: 1,
                failed: 0,
                results: [{ workId: undefined, slug: 'a', status: 'pending', message: 'ok' }],
            });

            await controller.batchDeploy(auth, { works: [{ workId: 'a' }] } as any);

            expect(deploymentVerifier.startVerification).not.toHaveBeenCalled();
        });

        it('emits BATCH activity log with workIds list and swallows log rejection', async () => {
            ownershipService.ensureCanEdit.mockResolvedValue({
                work: buildWork(),
                isCreator: true,
            });
            deployService.deployBatch.mockResolvedValue({
                totalRequested: 2,
                successfullyStarted: 2,
                failed: 0,
                results: [],
            });
            activityLogService.log.mockRejectedValue(new Error('log down'));

            const result = await controller.batchDeploy(auth, {
                works: [{ workId: 'a' }, { workId: 'b' }],
            } as any);

            expect(activityLogService.log).toHaveBeenCalledWith({
                userId: 'caller-1',
                actionType: 'deployment',
                action: 'deployment.batch_started',
                status: 'completed',
                summary: 'Triggered batch deploy for 2 works',
                details: { workIds: ['a', 'b'] },
            });
            // log rejection swallowed via .catch(() => {}) — controller still returns the envelope
            expect(result.status).toBe('success');
        });
    });

    describe('listDomains', () => {
        it('rejects when work has no website', async () => {
            const work = buildWork({ user: { id: 'caller-1' }, website: null });
            ownershipService.ensureCanView.mockResolvedValue({ work, isCreator: true });

            await expect(controller.listDomains(auth, 'work-1')).rejects.toMatchObject({
                response: {
                    message:
                        'No deployment exists for this work. Deploy first before managing domains.',
                },
            });

            expect(deployFacade.getDomains).not.toHaveBeenCalled();
        });

        it('returns domains via facade when website exists (creator)', async () => {
            const work = buildWork({ user: { id: 'caller-1' } });
            ownershipService.ensureCanView.mockResolvedValue({ work, isCreator: true });
            deployFacade.getDomains.mockResolvedValue([{ name: 'foo.example' }]);

            const result = await controller.listDomains(auth, 'work-1');

            expect(deployFacade.getDomains).toHaveBeenCalledWith({
                userId: 'caller-1',
                workId: 'work-1',
            });
            expect(result).toEqual({ status: 'success', domains: [{ name: 'foo.example' }] });
        });

        it('forwards owner.userId when caller is shared (isCreator:false)', async () => {
            const work = buildWork({ user: { id: 'owner-1' } });
            ownershipService.ensureCanView.mockResolvedValue({ work, isCreator: false });
            deployFacade.getDomains.mockResolvedValue([]);

            await controller.listDomains(auth, 'work-1');

            expect(deployFacade.getDomains).toHaveBeenCalledWith({
                userId: 'owner-1',
                workId: 'work-1',
            });
        });

        it('wraps facade error into BadRequestException w/ verbatim message', async () => {
            const work = buildWork({ user: { id: 'caller-1' } });
            ownershipService.ensureCanView.mockResolvedValue({ work, isCreator: true });
            deployFacade.getDomains.mockRejectedValue(new Error('domains api down'));

            await expect(controller.listDomains(auth, 'work-1')).rejects.toMatchObject({
                response: { message: 'domains api down' },
            });
        });

        it('falls back to "Failed to get domains" when error has no message', async () => {
            const work = buildWork({ user: { id: 'caller-1' } });
            ownershipService.ensureCanView.mockResolvedValue({ work, isCreator: true });
            deployFacade.getDomains.mockRejectedValue({});

            await expect(controller.listDomains(auth, 'work-1')).rejects.toMatchObject({
                response: { message: 'Failed to get domains' },
            });
        });
    });

    describe('addDomain', () => {
        const dto = { domain: 'example.com' } as any;

        it('rejects when work has no website', async () => {
            const work = buildWork({ user: { id: 'caller-1' }, website: null });
            ownershipService.ensureCanEdit.mockResolvedValue({ work, isCreator: true });

            await expect(controller.addDomain(auth, 'work-1', dto)).rejects.toMatchObject({
                response: {
                    message:
                        'No deployment exists for this work. Deploy first before adding domains.',
                },
            });

            expect(deployFacade.addDomain).not.toHaveBeenCalled();
        });

        it('forwards (domain, {userId, workId}) to facade.addDomain (creator)', async () => {
            const work = buildWork({ user: { id: 'caller-1' } });
            ownershipService.ensureCanEdit.mockResolvedValue({ work, isCreator: true });
            deployFacade.addDomain.mockResolvedValue({ verified: false, dnsRecords: [] });

            const result = await controller.addDomain(auth, 'work-1', dto);

            expect(deployFacade.addDomain).toHaveBeenCalledWith('example.com', {
                userId: 'caller-1',
                workId: 'work-1',
            });
            expect(result).toEqual({
                status: 'success',
                verified: false,
                dnsRecords: [],
            });
        });

        it('falls back to owner.userId when caller is shared', async () => {
            const work = buildWork({ user: { id: 'owner-1' } });
            ownershipService.ensureCanEdit.mockResolvedValue({ work, isCreator: false });
            deployFacade.addDomain.mockResolvedValue({});

            await controller.addDomain(auth, 'work-1', dto);

            expect(deployFacade.addDomain).toHaveBeenCalledWith('example.com', {
                userId: 'owner-1',
                workId: 'work-1',
            });
        });

        it('wraps facade error w/ "Failed to add domain" fallback', async () => {
            const work = buildWork({ user: { id: 'caller-1' } });
            ownershipService.ensureCanEdit.mockResolvedValue({ work, isCreator: true });
            deployFacade.addDomain.mockRejectedValue({});

            await expect(controller.addDomain(auth, 'work-1', dto)).rejects.toMatchObject({
                response: { message: 'Failed to add domain' },
            });
        });
    });

    describe('removeDomain', () => {
        it('rejects when work has no website', async () => {
            const work = buildWork({ user: { id: 'caller-1' }, website: null });
            ownershipService.ensureCanEdit.mockResolvedValue({ work, isCreator: true });

            await expect(
                controller.removeDomain(auth, 'work-1', 'example.com'),
            ).rejects.toMatchObject({
                response: {
                    message:
                        'No deployment exists for this work. Deploy first before managing domains.',
                },
            });

            expect(deployFacade.removeDomain).not.toHaveBeenCalled();
        });

        it('forwards (domain, {userId, workId}) and returns {status, removed} envelope', async () => {
            const work = buildWork({ user: { id: 'caller-1' } });
            ownershipService.ensureCanEdit.mockResolvedValue({ work, isCreator: true });
            deployFacade.removeDomain.mockResolvedValue(true);

            const result = await controller.removeDomain(auth, 'work-1', 'example.com');

            expect(deployFacade.removeDomain).toHaveBeenCalledWith('example.com', {
                userId: 'caller-1',
                workId: 'work-1',
            });
            expect(result).toEqual({ status: 'success', removed: true });
        });

        it('forwards owner.userId when caller is shared (isCreator:false)', async () => {
            const work = buildWork({ user: { id: 'owner-1' } });
            ownershipService.ensureCanEdit.mockResolvedValue({ work, isCreator: false });
            deployFacade.removeDomain.mockResolvedValue(false);

            await controller.removeDomain(auth, 'work-1', 'example.com');

            expect(deployFacade.removeDomain).toHaveBeenCalledWith('example.com', {
                userId: 'owner-1',
                workId: 'work-1',
            });
        });

        it('wraps facade error w/ "Failed to remove domain" fallback', async () => {
            const work = buildWork({ user: { id: 'caller-1' } });
            ownershipService.ensureCanEdit.mockResolvedValue({ work, isCreator: true });
            deployFacade.removeDomain.mockRejectedValue({});

            await expect(
                controller.removeDomain(auth, 'work-1', 'example.com'),
            ).rejects.toMatchObject({
                response: { message: 'Failed to remove domain' },
            });
        });
    });

    describe('verifyDomain', () => {
        it('rejects when work has no website', async () => {
            const work = buildWork({ user: { id: 'caller-1' }, website: null });
            ownershipService.ensureCanEdit.mockResolvedValue({ work, isCreator: true });

            await expect(
                controller.verifyDomain(auth, 'work-1', 'example.com'),
            ).rejects.toMatchObject({
                response: {
                    message:
                        'No deployment exists for this work. Deploy first before managing domains.',
                },
            });

            expect(deployFacade.verifyDomain).not.toHaveBeenCalled();
        });

        it('forwards (domain, {userId, workId}) and wraps result under {status, domain}', async () => {
            const work = buildWork({ user: { id: 'caller-1' } });
            ownershipService.ensureCanEdit.mockResolvedValue({ work, isCreator: true });
            deployFacade.verifyDomain.mockResolvedValue({
                name: 'example.com',
                verified: true,
                verification: [],
            });

            const result = await controller.verifyDomain(auth, 'work-1', 'example.com');

            expect(deployFacade.verifyDomain).toHaveBeenCalledWith('example.com', {
                userId: 'caller-1',
                workId: 'work-1',
            });
            expect(result).toEqual({
                status: 'success',
                domain: { name: 'example.com', verified: true, verification: [] },
            });
        });

        it('falls back to owner.userId when caller is shared', async () => {
            const work = buildWork({ user: { id: 'owner-1' } });
            ownershipService.ensureCanEdit.mockResolvedValue({ work, isCreator: false });
            deployFacade.verifyDomain.mockResolvedValue({});

            await controller.verifyDomain(auth, 'work-1', 'example.com');

            expect(deployFacade.verifyDomain).toHaveBeenCalledWith('example.com', {
                userId: 'owner-1',
                workId: 'work-1',
            });
        });

        it('wraps facade error w/ "Failed to verify domain" fallback', async () => {
            const work = buildWork({ user: { id: 'caller-1' } });
            ownershipService.ensureCanEdit.mockResolvedValue({ work, isCreator: true });
            deployFacade.verifyDomain.mockRejectedValue({});

            await expect(
                controller.verifyDomain(auth, 'work-1', 'example.com'),
            ).rejects.toMatchObject({
                response: { message: 'Failed to verify domain' },
            });
        });
    });
});
