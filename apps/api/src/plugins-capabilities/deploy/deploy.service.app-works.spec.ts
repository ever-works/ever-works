// `deploy.service.ts` reaches the agent package's barrels, and two of them pull
// ESM-only dependencies jest cannot parse (`@ever-works/agent/services` ->
// work-lifecycle -> the markdown generator -> `github-slugger`). The sibling
// `deploy.service.spec.ts` shells the same set; this file needs behaviour from
// none of them, because the App branch returns before any is touched.
jest.mock('@ever-works/agent/database', () => ({
    WorkRepository: class {},
    WorkCustomDomainRepository: class {},
}));
jest.mock('@ever-works/agent/entities', () => ({
    Work: class {},
    User: class {},
    DeploymentEnvironment: { PRODUCTION: 'production', PREVIEW: 'preview' },
    DeploymentTriggerSource: { MANUAL: 'manual', SCHEDULED: 'scheduled' },
}));
jest.mock('@ever-works/agent/plugins', () => ({ PluginRegistryService: class {} }));
jest.mock('@ever-works/agent/services', () => ({
    PlatformSyncSecretService: class {},
    ZeroFrictionFunnelService: class {},
}));
jest.mock('@ever-works/agent/facades', () => ({
    DeployFacadeService: class {},
    GitFacadeService: class {},
}));
jest.mock('@ever-works/agent/generators', () => ({
    WebsiteUpdateService: class {},
    getWebsiteTemplateBranch: () => 'main',
    getWebsiteTemplateConfig: () => ({ branch: 'main' }),
}));
jest.mock('@ever-works/agent/events', () => ({
    DeploymentDispatchedEvent: class {
        static EVENT_NAME = 'deployment.dispatched';
        constructor(public readonly payload: unknown) {}
    },
}));
// The App request service is a DI token here and always a double below.
jest.mock('@ever-works/agent/app-runtime', () => ({
    AppDeployRequestService: class {},
    AppDeployRequestModule: class {},
}));

import { HttpStatus } from '@nestjs/common';

import { DeployService } from './deploy.service';

/**
 * APW-06 §2.2's SECOND caller — `DeployService.deploy()` for a Work of kind `app`.
 *
 * `POST /api/works/:id/deploy` is the member-facing route. This branch is what
 * catches every OTHER way a deploy reaches the platform — `deployBatch`, the
 * schedule dispatcher, and the legacy `POST /api/deploy/works/:id` — so all of
 * them go through one request service and therefore one deploy lock.
 *
 * Four properties, and each of them is a way this could silently do the wrong
 * thing rather than fail loudly:
 *
 *   1. it branches **before** the facade resolves a provider. An App Work has no
 *      website deploy provider, so the facade would throw
 *      `NoDeployProviderError` first and tell the member their configuration is
 *      wrong when the real answer is that this Work deploys somewhere else;
 *   2. a refusal **throws**. `DeployResult` has no field for one, and callers
 *      treat a resolved result as "we queued something" — `deployBatch` would
 *      record a refused Deployment as a success;
 *   3. `queued` is a success with `dispatched: false`, because that is exactly
 *      what `dispatched` means;
 *   4. with no request service bound it refuses by name rather than falling
 *      through to the website path, which would push an App repository at a
 *      website provider.
 *
 * The service is constructed positionally with the collaborators this branch
 * reads and `undefined` for the rest: the App path returns before any of them is
 * touched, and passing doubles for sixteen unused services would assert nothing
 * while hiding which two actually matter.
 */

const WORK_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

type RequestMock = { request: jest.Mock };

function appResult(overrides: Record<string, unknown> = {}) {
    return {
        status: 'accepted',
        httpStatus: 202,
        code: null,
        deploymentId: 'd-1',
        queuedDeploymentId: null,
        queuedBuildId: null,
        runningDeploymentId: null,
        unmet: [],
        advisory: [],
        warnings: [],
        dispatched: true,
        deduplicated: false,
        stored: {},
        ...overrides,
    };
}

/**
 * A `DeployService` carrying only what the App branch reads.
 *
 * `workRepository` is argument 3 and the request service is the LAST argument;
 * every position between them is a collaborator this path never reaches.
 */
function makeService(
    kind: string,
    appDeployRequest?: RequestMock,
): {
    service: DeployService;
    findById: jest.Mock;
    deployFacade: { getPluginAndTokenAndSettings: jest.Mock };
} {
    const findById = jest.fn(async () => ({ id: WORK_ID, slug: 'demo', kind }));
    const deployFacade = {
        // If the App branch ever stops short-circuiting, this is what a test
        // sees instead of a confusing downstream failure.
        getPluginAndTokenAndSettings: jest.fn(async () => {
            throw new Error('the website provider path must not be reached for an App Work');
        }),
    };

    const service = new DeployService(
        deployFacade as never,
        undefined as never, // gitFacade
        { findById } as never, // workRepository
        undefined as never, // deploymentRepository
        undefined as never, // pluginRegistry
        undefined as never, // websiteUpdateService
        undefined as never, // websiteTemplateResolver
        undefined as never, // eventEmitter
        undefined as never, // platformSyncSecretService
        undefined as never, // webhookSecretService
        undefined as never, // workRuntimeEnvService
        undefined as never, // dnsService
        undefined as never, // subdomainAllocator
        undefined as never, // funnel
        undefined as never, // customDomainRepository
        undefined as never, // dbProvisionService
        appDeployRequest as never,
    );

    return { service, findById, deployFacade };
}

describe('DeployService.deploy — kind `app` (APW-06 §2.2)', () => {
    it('routes to the App request path and never resolves a website provider', async () => {
        const request: RequestMock = { request: jest.fn(async () => appResult()) };
        const { service, deployFacade } = makeService('app', request);

        const result = await service.deploy(WORK_ID, USER_ID);

        expect(result).toEqual({ dispatched: true, deploymentId: 'd-1' });
        expect(request.request).toHaveBeenCalledWith(
            expect.objectContaining({ workId: WORK_ID, userId: USER_ID, trigger: 'manual' }),
        );
        expect(deployFacade.getPluginAndTokenAndSettings).not.toHaveBeenCalled();
    });

    it('forwards the caller’s commit and branch when it has them', async () => {
        const request: RequestMock = { request: jest.fn(async () => appResult()) };
        const { service } = makeService('app', request);

        await service.deploy(WORK_ID, USER_ID, { commitSha: 'a'.repeat(40), branch: 'main' });

        expect(request.request.mock.calls[0][0]).toMatchObject({
            headCommitSha: 'a'.repeat(40),
            branch: 'main',
        });
    });

    it('omits the two optional facts rather than sending empty strings', async () => {
        const request: RequestMock = { request: jest.fn(async () => appResult()) };
        const { service } = makeService('app', request);

        await service.deploy(WORK_ID, USER_ID, {});

        const sent = request.request.mock.calls[0][0];
        expect(sent).not.toHaveProperty('headCommitSha');
        expect(sent).not.toHaveProperty('branch');
    });

    it('reports a QUEUED Deployment as a success that was not dispatched', async () => {
        // The row exists in the latest-wins queue of one and runs when the
        // Deployment holding the lock releases it. `dispatched: false` is the
        // literal truth, and the caller has a deploymentId to poll.
        const request: RequestMock = {
            request: jest.fn(async () =>
                appResult({ status: 'queued', dispatched: false, deploymentId: 'd-queued' }),
            ),
        };
        const { service } = makeService('app', request);

        expect(await service.deploy(WORK_ID, USER_ID)).toEqual({
            dispatched: false,
            deploymentId: 'd-queued',
        });
    });

    it('THROWS on a refusal, carrying the request service’s own status and code', async () => {
        // `DeployResult` has no field for a refusal, and `deployBatch` records a
        // resolved result as a success. Returning one would report a Deployment
        // that does not exist.
        const request: RequestMock = {
            request: jest.fn(async () =>
                appResult({
                    status: 'refused',
                    httpStatus: 422,
                    code: 'APP_DEPLOY_PRECONDITIONS',
                    deploymentId: null,
                    dispatched: false,
                    unmet: [{ code: 'no_green_build', message: 'No green Build to deploy.' }],
                }),
            ),
        };
        const { service } = makeService('app', request);

        await expect(service.deploy(WORK_ID, USER_ID)).rejects.toMatchObject({
            status: HttpStatus.UNPROCESSABLE_ENTITY,
        });
    });

    it('throws for an ACCEPTED answer that carries no deploymentId', async () => {
        // Defensive, and cheap: a caller that received `{ dispatched: true,
        // deploymentId: null }` would poll a Deployment that was never created.
        const request: RequestMock = {
            request: jest.fn(async () => appResult({ deploymentId: null })),
        };
        const { service } = makeService('app', request);

        await expect(service.deploy(WORK_ID, USER_ID)).rejects.toBeDefined();
    });

    it('refuses by NAME when no request service is bound', async () => {
        // Never a fall-through to the website path: that would push an App
        // Work's own repository at a website deploy provider.
        const { service, deployFacade } = makeService('app', undefined);

        await expect(service.deploy(WORK_ID, USER_ID)).rejects.toMatchObject({
            status: HttpStatus.BAD_REQUEST,
        });
        expect(deployFacade.getPluginAndTokenAndSettings).not.toHaveBeenCalled();
    });

    it('leaves every other kind on the website path', async () => {
        // The branch is `isAppWorkKind`, not "anything unusual". A directory
        // Work must still reach the facade exactly as it did before.
        const request: RequestMock = { request: jest.fn(async () => appResult()) };
        const { service, deployFacade } = makeService('directory', request);

        await expect(service.deploy(WORK_ID, USER_ID)).rejects.toThrow(
            /website provider path must not be reached/,
        );
        expect(request.request).not.toHaveBeenCalled();
        expect(deployFacade.getPluginAndTokenAndSettings).toHaveBeenCalled();
    });
});
