// The services barrel is large; this suite only needs the class as a DI token.
jest.mock('@ever-works/agent/services', () => ({
    WorkOwnershipService: class WorkOwnershipService {},
}));
// The dependency barrel: the service and the spec source as DI tokens (every case supplies a double).
jest.mock('@ever-works/agent/app-dependencies', () => ({
    AppDependenciesService: class AppDependenciesService {},
    AppDependencySpecSourceAdapter: class AppDependencySpecSourceAdapter {},
}));
jest.mock('@ever-works/agent/app-env', () => ({
    isAppEnvEncryptionUnavailableError: (value: { name?: string }) =>
        value?.name === 'AppEnvEncryptionUnavailableError',
}));
jest.mock('@ever-works/agent/activity-log', () => ({
    ActivityLogService: class ActivityLogService {},
}));
jest.mock('@ever-works/agent/entities', () => ({
    ActivityActionType: { APP_DEPENDENCY: 'app_dependency' },
    ActivityStatus: { COMPLETED: 'completed' },
}));
jest.mock('@ever-works/agent/config', () => ({
    config: { everWorks: { apps: { worksEnabled: jest.fn(() => true) } } },
}));
// The auth barrel pulls `better-auth` (ESM); nothing here drives a router.
jest.mock('../auth', () => ({
    AuthSessionGuard: class AuthSessionGuard {},
    CurrentUser: () => () => undefined,
}));

import { ForbiddenException, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common/enums/request-method.enum';
import { config } from '@ever-works/agent/config';
import type { AppDependenciesService } from '@ever-works/agent/app-dependencies';
import type { WorkOwnershipService } from '@ever-works/agent/services';

import { WorkAppDependenciesController } from './work-app-dependencies.controller';

/**
 * Lane aw-deps-api (APW-07 T25) — `GET /api/works/:id/app-dependencies`, `PUT`/`DELETE …/:kind` and
 * `POST …/:kind/provision`.
 *
 * The controller decides who may ask, what it passes on, which status answers and which Activity
 * row is written; every state transition is `AppDependenciesService`'s and has its own spec.
 */

const WORK_ID = '5a07fa3f-367a-444e-9d1e-311d03cc1327';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const USER = { userId: USER_ID } as never;
const SLUG = 'hello-app';

const worksEnabled = (config as unknown as { everWorks: { apps: { worksEnabled: jest.Mock } } })
    .everWorks.apps.worksEnabled;

type Role = 'owner' | 'viewer' | 'foreign' | 'missing';

function ownership(role: Role, kind = 'app'): WorkOwnershipService {
    const access = { work: { id: WORK_ID, kind, slug: SLUG }, isCreator: role === 'owner' };
    return {
        ensureCanView: jest.fn(async () => {
            if (role === 'missing') throw new NotFoundException('Work not found');
            if (role === 'foreign') throw new ForbiddenException('No access');
            return access;
        }),
        ensureCanEdit: jest.fn(async () => {
            if (role === 'missing') throw new NotFoundException('Work not found');
            if (role !== 'owner') throw new ForbiddenException('Edit access required');
            return access;
        }),
    } as unknown as WorkOwnershipService;
}

/** One card, as the service lists it — names and numbers only. */
function card(overrides: Record<string, unknown> = {}) {
    return {
        kind: 'postgres',
        declared: true,
        provider: { pluginId: 'k8s', providerId: 'k8s-inline-postgres', label: 'Postgres' },
        availableProviders: [],
        status: 'failed',
        statusReason: 'clusterUnreachable',
        statusDetail: null,
        awaitingConfig: false,
        actualVersion: null,
        sizeGiB: 10,
        backup: { policy: 'none', state: 'none', lastBackupAt: null, checkedAt: null },
        inSpec: true,
        keptResources: null,
        outputs: [{ name: 'url', secret: true }],
        lastProvisionedAt: null,
        lastCheckedAt: null,
        label: 'Postgres',
        names: [],
        attempts: 3,
        ...overrides,
    };
}

type ServiceDouble = AppDependenciesService &
    Record<'list' | 'configure' | 'retry' | 'requestDataDeletion', jest.Mock>;

function deps(overrides: Partial<Record<keyof ServiceDouble, jest.Mock>> = {}): ServiceDouble {
    return {
        list: jest.fn(async () => [card()]),
        configure: jest.fn(async () => card({ status: 'pending', statusReason: null })),
        retry: jest.fn(async () => ({ dispatched: true })),
        requestDataDeletion: jest.fn(async () => card({ status: 'deleting' })),
        ...overrides,
    } as unknown as ServiceDouble;
}

function specs(deployTarget: string | null = 'your-cluster') {
    return { read: jest.fn(async () => (deployTarget ? { deployTarget } : null)) };
}

function activity() {
    return { log: jest.fn(async () => ({})) };
}

function response(): { status: jest.Mock; code: () => number | undefined } {
    const status = jest.fn();
    return { status, code: () => status.mock.calls.at(-1)?.[0] };
}

function controller(
    role: Role = 'owner',
    service: ServiceDouble = deps(),
    log = activity(),
    kind = 'app',
): WorkAppDependenciesController {
    return new WorkAppDependenciesController(
        ownership(role, kind),
        service,
        specs() as never,
        log as never,
    );
}

async function statusOf(
    promise: Promise<unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
    try {
        await promise;
    } catch (error) {
        if (error instanceof HttpException) {
            return {
                status: error.getStatus(),
                body: error.getResponse() as Record<string, unknown>,
            };
        }
        throw error;
    }
    throw new Error('expected a refusal');
}

describe('WorkAppDependenciesController — routes', () => {
    it('declares the four paths of plan §5:787-790, four segments deep under api/works', () => {
        const proto = WorkAppDependenciesController.prototype;
        const route = (handler: unknown) => ({
            path: Reflect.getMetadata(PATH_METADATA, handler as object),
            method: Reflect.getMetadata(METHOD_METADATA, handler as object),
        });

        expect(Reflect.getMetadata(PATH_METADATA, WorkAppDependenciesController)).toBe('api/works');
        expect(route(proto.list)).toEqual({
            path: ':id/app-dependencies',
            method: RequestMethod.GET,
        });
        expect(route(proto.configure)).toEqual({
            path: ':id/app-dependencies/:kind',
            method: RequestMethod.PUT,
        });
        expect(route(proto.retry)).toEqual({
            path: ':id/app-dependencies/:kind/provision',
            method: RequestMethod.POST,
        });
        expect(route(proto.deleteData)).toEqual({
            path: ':id/app-dependencies/:kind',
            method: RequestMethod.DELETE,
        });
    });
});

describe('WorkAppDependenciesController — access', () => {
    beforeEach(() => worksEnabled.mockReturnValue(true));

    it('answers 404 appWorksDisabled on every route while App Works is off', async () => {
        worksEnabled.mockReturnValue(false);
        const service = deps();
        const subject = controller('owner', service);

        for (const call of [
            subject.list(USER, WORK_ID),
            subject.retry(USER, WORK_ID, 'postgres', response()),
            subject.configure(USER, WORK_ID, 'postgres', { sizeGiB: 20 }, response()),
            subject.deleteData(USER, WORK_ID, 'postgres', { confirmSlug: SLUG }, response()),
        ]) {
            const { status, body } = await statusOf(call);
            expect(status).toBe(HttpStatus.NOT_FOUND);
            expect(body.code).toBe('appWorksDisabled');
        }
        expect(service.list).not.toHaveBeenCalled();
        expect(service.retry).not.toHaveBeenCalled();
    });

    it('answers ONE 404 notAppWork for missing, invisible and another kind alike', async () => {
        for (const subject of [
            controller('missing'),
            controller('foreign'),
            controller('owner', deps(), activity(), 'website'),
        ]) {
            const { status, body } = await statusOf(subject.list(USER, WORK_ID));
            expect(status).toBe(HttpStatus.NOT_FOUND);
            expect(body.code).toBe('notAppWork');
        }
    });

    it('lets a viewer read, and refuses every write 403 editAccessRequired', async () => {
        const service = deps();
        const viewer = controller('viewer', service);

        const read = await viewer.list(USER, WORK_ID);
        expect(read.canEdit).toBe(false);

        for (const call of [
            viewer.retry(USER, WORK_ID, 'postgres', response()),
            viewer.configure(USER, WORK_ID, 'postgres', { sizeGiB: 20 }, response()),
            viewer.deleteData(USER, WORK_ID, 'postgres', { confirmSlug: SLUG }, response()),
        ]) {
            const { status, body } = await statusOf(call);
            expect(status).toBe(HttpStatus.FORBIDDEN);
            expect(body.code).toBe('editAccessRequired');
        }
        expect(service.retry).not.toHaveBeenCalled();
        expect(service.configure).not.toHaveBeenCalled();
        expect(service.requestDataDeletion).not.toHaveBeenCalled();
    });

    it('refuses an unknown kind 404 dependencyNotDeclared before asking the service', async () => {
        const service = deps();
        const { status, body } = await statusOf(
            controller('owner', service).retry(USER, WORK_ID, 'mongodb', response()),
        );

        expect(status).toBe(HttpStatus.NOT_FOUND);
        expect(body.code).toBe('dependencyNotDeclared');
        expect(service.retry).not.toHaveBeenCalled();
    });
});

describe('WorkAppDependenciesController — GET', () => {
    beforeEach(() => worksEnabled.mockReturnValue(true));

    it('answers the cards, the deploy target and canEdit — no value anywhere', async () => {
        const service = deps();
        const body = await controller('owner', service).list(USER, WORK_ID);

        expect(service.list).toHaveBeenCalledWith(WORK_ID, { userId: USER_ID });
        expect(body).toEqual({
            workId: WORK_ID,
            deployTarget: 'your-cluster',
            dependencies: [card()],
            refreshing: false,
            canEdit: true,
        });
    });

    it('answers deployTarget null when the spec source is unbound', async () => {
        const subject = new WorkAppDependenciesController(ownership('owner'), deps());
        const body = await subject.list(USER, WORK_ID);
        expect(body.deployTarget).toBeNull();
        expect(body.dependencies).toHaveLength(1);
    });
});

describe('WorkAppDependenciesController — POST …/:kind/provision (Retry)', () => {
    beforeEach(() => worksEnabled.mockReturnValue(true));

    it('answers 202 { dispatched, dependency } and writes one Activity row', async () => {
        const service = deps({
            list: jest.fn(async () => [
                card({ status: 'pending', statusReason: null, attempts: 0 }),
            ]),
        });
        const log = activity();
        const res = response();

        const body = await controller('owner', service, log).retry(USER, WORK_ID, 'postgres', res);

        expect(service.retry).toHaveBeenCalledWith(WORK_ID, 'postgres');
        expect(res.code()).toBe(HttpStatus.ACCEPTED);
        expect(body).toMatchObject({
            status: 'accepted',
            dispatched: true,
            dependency: { kind: 'postgres', status: 'pending', attempts: 0 },
        });
        expect(body).not.toHaveProperty('reason');
        expect(log.log).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: USER_ID,
                workId: WORK_ID,
                actionType: 'app_dependency',
                action: 'app.dependency.retried',
                metadata: { kinds: ['postgres'], trigger: 'retry', dispatched: true },
            }),
        );
    });

    it('answers 409 leaseHeld while a worker holds the dependency, and logs nothing', async () => {
        const log = activity();
        const { status, body } = await statusOf(
            controller(
                'owner',
                deps({ retry: jest.fn(async () => ({ dispatched: false, reason: 'leaseHeld' })) }),
                log,
            ).retry(USER, WORK_ID, 'postgres', response()),
        );

        expect(status).toBe(HttpStatus.CONFLICT);
        expect(body.code).toBe('leaseHeld');
        expect(log.log).not.toHaveBeenCalled();
    });

    it('says when the dispatcher is unavailable instead of pretending it was sent', async () => {
        const body = await controller(
            'owner',
            deps({
                retry: jest.fn(async () => ({
                    dispatched: false,
                    reason: 'dispatcherUnavailable',
                })),
            }),
        ).retry(USER, WORK_ID, 'postgres', response());

        expect(body).toMatchObject({ dispatched: false, reason: 'dispatcherUnavailable' });
    });

    it('maps the service’s dependencyNotDeclared to 404', async () => {
        const refusal = Object.assign(new Error('This App Work has no redis dependency.'), {
            name: 'AppDependencyRefusalError',
            code: 'dependencyNotDeclared',
            status: 404,
        });
        const { status, body } = await statusOf(
            controller(
                'owner',
                deps({ retry: jest.fn(async () => Promise.reject(refusal)) }),
            ).retry(USER, WORK_ID, 'redis', response()),
        );

        expect(status).toBe(HttpStatus.NOT_FOUND);
        expect(body).toEqual({
            status: 'error',
            code: 'dependencyNotDeclared',
            message: 'This App Work has no redis dependency.',
        });
    });
});

describe('WorkAppDependenciesController — PUT …/:kind (Configure)', () => {
    beforeEach(() => worksEnabled.mockReturnValue(true));

    it('passes the checked body to configure and answers 202 { dependency }', async () => {
        const service = deps();
        const log = activity();
        const res = response();

        const body = await controller('owner', service, log).configure(
            USER,
            WORK_ID,
            'smtp',
            {
                providerId: 'smtp-external',
                config: { host: 'mail.example.com', password: 'hunter2' },
            },
            res,
        );

        expect(service.configure).toHaveBeenCalledWith(WORK_ID, 'smtp', {
            providerId: 'smtp-external',
            config: { host: 'mail.example.com', password: 'hunter2' },
            userId: USER_ID,
        });
        expect(res.code()).toBe(HttpStatus.ACCEPTED);
        expect(body.dependency).toMatchObject({ status: 'pending' });
        // The Activity row says THAT the config changed — never what it is (FR-5).
        const row = JSON.stringify(log.log.mock.calls);
        expect(row).toContain('app.dependency.configured');
        expect(row).not.toContain('hunter2');
        expect(row).not.toContain('mail.example.com');
    });

    it.each([
        ['a non-object body', 'nope'],
        ['an empty body', {}],
        ['a bad providerId', { providerId: 'Not A Provider!' }],
        ['a non-string config value', { config: { port: 587 } }],
        ['a fractional size', { sizeGiB: 1.5 }],
        ['a zero size', { sizeGiB: 0 }],
    ])('refuses %s with 400 invalidBody before asking the service', async (_label, payload) => {
        const service = deps();
        const { status, body } = await statusOf(
            controller('owner', service).configure(USER, WORK_ID, 'postgres', payload, response()),
        );

        expect(status).toBe(HttpStatus.BAD_REQUEST);
        expect(body.code).toBe('invalidBody');
        expect(service.configure).not.toHaveBeenCalled();
    });

    it('never echoes a config value in a refusal', async () => {
        const { body } = await statusOf(
            controller().configure(
                USER,
                WORK_ID,
                'smtp',
                { config: { password: 'x'.repeat(9_000) } },
                response(),
            ),
        );
        expect(String(body.message)).toContain('config.password');
        expect(String(body.message)).not.toContain('xxxx');
    });

    it.each([
        ['sizeShrinkRefused', 422, HttpStatus.UNPROCESSABLE_ENTITY],
        ['providerNotSupported', 422, HttpStatus.UNPROCESSABLE_ENTITY],
        ['dependencyNotDeclared', 404, HttpStatus.NOT_FOUND],
        ['secureStorageUnavailable', 503, HttpStatus.SERVICE_UNAVAILABLE],
    ])('maps %s to its status', async (code, serviceStatus, expected) => {
        const refusal = Object.assign(new Error(code), {
            name: 'AppDependencyRefusalError',
            code,
            status: serviceStatus,
        });
        const { status, body } = await statusOf(
            controller(
                'owner',
                deps({ configure: jest.fn(() => Promise.reject(refusal)) }),
            ).configure(USER, WORK_ID, 'postgres', { sizeGiB: 20 }, response()),
        );
        expect(status).toBe(expected);
        expect(body.code).toBe(code);
    });

    it('maps a missing encryption key to 503 secureStorageUnavailable', async () => {
        const unavailable = Object.assign(new Error('no key'), {
            name: 'AppEnvEncryptionUnavailableError',
        });
        const { status, body } = await statusOf(
            controller(
                'owner',
                deps({ configure: jest.fn(() => Promise.reject(unavailable)) }),
            ).configure(USER, WORK_ID, 'smtp', { config: { host: 'h' } }, response()),
        );
        expect(status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
        expect(body.code).toBe('secureStorageUnavailable');
    });
});

describe('WorkAppDependenciesController — DELETE …/:kind (Delete data)', () => {
    beforeEach(() => worksEnabled.mockReturnValue(true));

    it('hands the typed slug and the Work’s OWN slug to the service', async () => {
        const service = deps();
        const log = activity();
        const res = response();

        const body = await controller('owner', service, log).deleteData(
            USER,
            WORK_ID,
            'postgres',
            { confirmSlug: ` ${SLUG} ` },
            res,
        );

        expect(service.requestDataDeletion).toHaveBeenCalledWith(WORK_ID, 'postgres', {
            confirmSlug: SLUG,
            workSlug: SLUG,
            hasEditAccess: true,
        });
        expect(res.code()).toBe(HttpStatus.ACCEPTED);
        expect(body.dependency).toMatchObject({ status: 'deleting' });
        expect(log.log).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'app.dependency.data_delete_requested' }),
        );
    });

    it('passes a missing confirmation as null, never as an empty string', async () => {
        const service = deps();
        await controller('owner', service).deleteData(USER, WORK_ID, 'postgres', {}, response());
        expect(service.requestDataDeletion.mock.calls[0][2]).toMatchObject({ confirmSlug: null });
    });

    it.each([
        ['confirmationMismatch', 422, HttpStatus.UNPROCESSABLE_ENTITY],
        ['deleteInProgress', 409, HttpStatus.CONFLICT],
        ['dependencyNotDeclared', 404, HttpStatus.NOT_FOUND],
    ])(
        'maps %s to its status and writes no Activity row',
        async (code, serviceStatus, expected) => {
            const refusal = Object.assign(new Error(code), {
                name: 'AppDependencyRefusalError',
                code,
                status: serviceStatus,
            });
            const log = activity();
            const { status, body } = await statusOf(
                controller(
                    'owner',
                    deps({ requestDataDeletion: jest.fn(() => Promise.reject(refusal)) }),
                    log,
                ).deleteData(USER, WORK_ID, 'postgres', { confirmSlug: 'wrong' }, response()),
            );
            expect(status).toBe(expected);
            expect(body.code).toBe(code);
            expect(log.log).not.toHaveBeenCalled();
        },
    );
});
