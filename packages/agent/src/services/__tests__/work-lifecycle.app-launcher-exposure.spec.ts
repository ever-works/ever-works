// `github-slugger` is an ESM-only dependency pulled in transitively via
// `MarkdownGeneratorService -> readme-builder`. ts-jest cannot parse its
// `import` syntax, so stub it out — this spec never touches slug building.
jest.mock('github-slugger', () => ({
    __esModule: true,
    default: class {
        slug(s: string) {
            return s;
        }
    },
}));

import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { WorkLifecycleService } from '../work-lifecycle.service';
import { WorkRepository } from '@src/database/repositories/work.repository';
import { UserRepository } from '@src/database/repositories/user.repository';
import { OrganizationRepository } from '@src/database/repositories/organization.repository';
import { DataGeneratorService } from '@src/generators/data-generator/data-generator.service';
import { MarkdownGeneratorService } from '@src/generators/markdown-generator/markdown-generator.service';
import { WebsiteGeneratorService } from '@src/generators/website-generator/website-generator.service';
import { WebsiteUpdateService } from '@src/generators/website-generator/website-update.service';
import { WorkOwnershipService } from '../work-ownership.service';
import { DeployFacadeService } from '@src/facades/deploy.facade';
import { GitFacadeService } from '@src/facades/git.facade';
import { TemplateCatalogService } from '@src/template-catalog/template-catalog.service';
import { WorkWebsiteRepositoryStateService } from '../work-website-repository-state.service';
import {
    EverWorksDeployQuotaService,
    EverWorksGitProvider,
    EverWorksDnsService,
} from '@src/ever-works-providers';
import { ZeroFrictionFunnelService } from '../zero-friction-funnel.service';
import { ActivityLogService } from '@src/activity-log/activity-log.service';
import { ActivityActionType, ActivityStatus } from '@src/entities/activity-log.types';
import { UpdateWorkDto } from '@src/dto/update-work.dto';
import type { Work } from '@src/entities/work.entity';
import type { User } from '@src/entities/user.entity';

/**
 * APW-11 T7 — exposure on Work update (spec FR-19/FR-20/FR-21/FR-60/FR-61,
 * plan §4.4, ACC-11-16 and ACC-11-46).
 *
 * `PUT /api/works/:id { appLauncherExposed: … }` persists ONE Work field and
 * records ONE Activity row per real change — never on a save that leaves the
 * effective value and the explicit flag where they were. "Changed" is the pair
 * `(storedValue, storedExplicit)` versus `(newValue, newExplicit)`, which is
 * why `null → true` on an `app` Work is a real change and `null → null` is
 * not. Edit rights are the EXISTING `ensureCanEdit` check: a viewer is refused
 * there and no second permission path exists.
 */

const WORK_ID = '00000000-0000-0000-0000-000000000001';
/** Deliberately not a substring of the address below, so each scan is meaningful. */
const WORK_NAME = 'Acme Rockets Directory';
const WORK_HOST = 'acme-rockets.ever.works';
const WORK_ADDRESS = `https://${WORK_HOST}/`;

function buildWork(overrides: Record<string, unknown> = {}): Work {
    return {
        id: WORK_ID,
        name: WORK_NAME,
        description: 'Acme directory',
        owner: 'acme',
        organization: false,
        readmeConfig: null,
        userId: 'user-1',
        tenantId: null,
        organizationId: null,
        kind: 'directory',
        status: 'active',
        website: WORK_ADDRESS,
        managedSubdomain: 'acme-rockets',
        appLauncherExposed: null,
        getRepoOwner: () => 'acme',
        ...overrides,
    } as unknown as Work;
}

describe('WorkLifecycleService — App Launcher exposure', () => {
    let service: WorkLifecycleService;
    let workRepository: { update: jest.Mock; findByUser: jest.Mock };
    let ownershipService: { ensureCanEdit: jest.Mock };
    let activityLog: { log: jest.Mock };
    let websiteUpdateService: { updateReadme: jest.Mock };
    let eventEmitter: { emit: jest.Mock; emitAsync: jest.Mock };
    let work: Work;

    const user = { id: 'user-1', username: 'user-1' } as unknown as User;

    /** The single Activity entry the service logged, or `undefined`. */
    function loggedEntry(): Record<string, any> | undefined {
        return activityLog.log.mock.calls[0]?.[0];
    }

    /** The payload handed to `workRepository.update`, for the first call. */
    function updatePayload(): Record<string, unknown> {
        return workRepository.update.mock.calls[0]?.[1] ?? {};
    }

    beforeEach(async () => {
        work = buildWork();
        workRepository = {
            update: jest
                .fn()
                .mockImplementation(async (_id: string, data: Record<string, unknown>) => ({
                    ...work,
                    ...data,
                    getRepoOwner: () => 'acme',
                })),
            findByUser: jest.fn().mockResolvedValue([work]),
        };
        ownershipService = {
            ensureCanEdit: jest.fn().mockImplementation(async () => ({ work, role: 'editor' })),
        };
        activityLog = { log: jest.fn().mockResolvedValue({ id: 'activity-1' }) };
        websiteUpdateService = { updateReadme: jest.fn().mockResolvedValue(undefined) };
        eventEmitter = { emit: jest.fn(), emitAsync: jest.fn() };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                WorkLifecycleService,
                { provide: WorkRepository, useValue: workRepository },
                { provide: UserRepository, useValue: {} },
                { provide: OrganizationRepository, useValue: {} },
                { provide: DataGeneratorService, useValue: {} },
                { provide: MarkdownGeneratorService, useValue: {} },
                { provide: WebsiteGeneratorService, useValue: {} },
                { provide: WebsiteUpdateService, useValue: websiteUpdateService },
                { provide: WorkOwnershipService, useValue: ownershipService },
                { provide: DeployFacadeService, useValue: { getAvailableProviders: () => [] } },
                { provide: GitFacadeService, useValue: {} },
                { provide: TemplateCatalogService, useValue: {} },
                { provide: WorkWebsiteRepositoryStateService, useValue: {} },
                { provide: EverWorksDeployQuotaService, useValue: {} },
                { provide: EverWorksGitProvider, useValue: {} },
                { provide: EverWorksDnsService, useValue: {} },
                { provide: ZeroFrictionFunnelService, useValue: {} },
                { provide: EventEmitter2, useValue: eventEmitter },
                { provide: ActivityLogService, useValue: activityLog },
            ],
        }).compile();

        service = module.get(WorkLifecycleService);
    });

    describe('the write', () => {
        it('persists the submitted choice and nothing else on the Work (ACC-11-46)', async () => {
            await service.updateWork(WORK_ID, { appLauncherExposed: true }, user);

            const payload = updatePayload();
            expect(payload.appLauncherExposed).toBe(true);
            // The ONLY field this request moves. Every other key the existing
            // update path always writes carries the Work's stored value back,
            // unchanged.
            expect(Object.keys(payload).sort()).toEqual([
                'appLauncherExposed',
                'description',
                'name',
                'organization',
                'owner',
                'readmeConfig',
            ]);
            expect(payload.name).toBe(WORK_NAME);
            expect(payload.description).toBe('Acme directory');
            expect(payload.owner).toBe('acme');
            expect(payload.organization).toBe(false);
            expect(payload.readmeConfig).toBeNull();
        });

        it('writes no README and requests no works.yml sync for an exposure-only save (ACC-11-46)', async () => {
            await service.updateWork(WORK_ID, { appLauncherExposed: true }, user);

            expect(websiteUpdateService.updateReadme).not.toHaveBeenCalled();
            expect(eventEmitter.emit).not.toHaveBeenCalled();
        });

        it('clears the explicit choice back to the kind default when the value is null (FR-60)', async () => {
            work = buildWork({ appLauncherExposed: true });
            ownershipService.ensureCanEdit.mockImplementation(async () => ({
                work,
                role: 'editor',
            }));

            await service.updateWork(WORK_ID, { appLauncherExposed: null }, user);

            expect(updatePayload().appLauncherExposed).toBeNull();
        });

        it('leaves the field untouched when the DTO omits it (every existing branch keeps working)', async () => {
            const result = await service.updateWork(WORK_ID, { name: 'Renamed' }, user);

            expect(result.status).toBe('success');
            expect(updatePayload()).not.toHaveProperty('appLauncherExposed');
            expect(activityLog.log).not.toHaveBeenCalled();
        });
    });

    describe('the Activity record (plan §4.4, FR-61)', () => {
        it('records one app_launcher row for one real change, with the dotted action, status and metadata', async () => {
            await service.updateWork(WORK_ID, { appLauncherExposed: true }, user);

            expect(activityLog.log).toHaveBeenCalledTimes(1);
            expect(loggedEntry()).toMatchObject({
                userId: 'user-1',
                workId: WORK_ID,
                actionType: ActivityActionType.APP_LAUNCHER,
                action: 'app.launcher.exposed',
                status: ActivityStatus.COMPLETED,
                summary: 'Show in App Launcher turned on',
                metadata: { explicit: true, previousEffective: false },
            });
            // The enum member's persisted literal, pinned here as well as in
            // `activity-log.types.spec.ts`: the row is matched by string
            // equality across the codebase.
            expect(loggedEntry()?.actionType).toBe('app_launcher');
            // `metadata` carries EXACTLY the two documented keys.
            expect(Object.keys(loggedEntry()?.metadata ?? {}).sort()).toEqual([
                'explicit',
                'previousEffective',
            ]);
        });

        it('records the direction of the effective value and the reset summary (FR-60/FR-61)', async () => {
            work = buildWork({ appLauncherExposed: true });
            ownershipService.ensureCanEdit.mockImplementation(async () => ({
                work,
                role: 'editor',
            }));

            await service.updateWork(WORK_ID, { appLauncherExposed: null }, user);

            expect(loggedEntry()).toMatchObject({
                action: 'app.launcher.hidden',
                summary: 'Show in App Launcher reset to the default for this Work kind',
                status: ActivityStatus.COMPLETED,
                metadata: { explicit: false, previousEffective: true },
            });
        });

        it('records the explicit flag even when the effective value does not move (null → false)', async () => {
            // A directory Work defaults to off, so `null → false` leaves the
            // effective value alone: what moved is the explicit flag, and
            // FR-61 records the change.
            await service.updateWork(WORK_ID, { appLauncherExposed: false }, user);

            expect(activityLog.log).toHaveBeenCalledTimes(1);
            expect(loggedEntry()).toMatchObject({
                action: 'app.launcher.hidden',
                summary: 'Show in App Launcher turned off',
                metadata: { explicit: true, previousEffective: false },
            });
        });

        it('names neither the Work nor its address in ANY field (spec §5.2, FR-21/FR-43)', async () => {
            await service.updateWork(WORK_ID, { appLauncherExposed: true }, user);

            const entry = loggedEntry();
            expect(entry).toBeDefined();
            const serialized = JSON.stringify(entry);

            // CONTROL — the scan can fail. The same serialization of a copy
            // that DOES carry the name and the host trips both scans, so the
            // green result below is a real absence and not an empty object.
            const poisoned = {
                ...entry,
                summary: `Show in App Launcher turned on for ${WORK_NAME} at ${WORK_ADDRESS}`,
            };
            expect(JSON.stringify(poisoned)).toContain(WORK_NAME);
            expect(JSON.stringify(poisoned)).toContain(WORK_HOST);

            expect(serialized).toContain('app.launcher.exposed');
            expect(serialized).not.toContain(WORK_NAME);
            expect(serialized).not.toContain(WORK_HOST);
            expect(serialized).not.toContain('acme-rockets');
            expect(serialized).not.toContain('https://');
        });

        it('writes nothing and logs nothing for null → null (a no-op, not a change)', async () => {
            work = buildWork({ appLauncherExposed: null });

            await service.updateWork(WORK_ID, { appLauncherExposed: null }, user);

            expect(activityLog.log).not.toHaveBeenCalled();
            expect(updatePayload()).not.toHaveProperty('appLauncherExposed');
        });

        it('writes nothing and logs nothing when the same explicit value is saved again', async () => {
            work = buildWork({ appLauncherExposed: true });
            ownershipService.ensureCanEdit.mockImplementation(async () => ({
                work,
                role: 'editor',
            }));

            await service.updateWork(WORK_ID, { appLauncherExposed: true }, user);

            expect(activityLog.log).not.toHaveBeenCalled();
            expect(updatePayload()).not.toHaveProperty('appLauncherExposed');
        });

        it('null → true on an `app` Work IS a change — the explicit flag moved, the effective value did not (FR-19/FR-61)', async () => {
            work = buildWork({ kind: 'app', appLauncherExposed: null });
            ownershipService.ensureCanEdit.mockImplementation(async () => ({
                work,
                role: 'editor',
            }));

            await service.updateWork(WORK_ID, { appLauncherExposed: true }, user);

            expect(updatePayload().appLauncherExposed).toBe(true);
            expect(activityLog.log).toHaveBeenCalledTimes(1);
            expect(loggedEntry()).toMatchObject({
                action: 'app.launcher.exposed',
                summary: 'Show in App Launcher turned on',
                metadata: { explicit: true, previousEffective: true },
            });
        });

        it('null → null on that same `app` Work stays a no-op (the kind default is not a change)', async () => {
            work = buildWork({ kind: 'app', appLauncherExposed: null });
            ownershipService.ensureCanEdit.mockImplementation(async () => ({
                work,
                role: 'editor',
            }));

            await service.updateWork(WORK_ID, { appLauncherExposed: null }, user);

            expect(activityLog.log).not.toHaveBeenCalled();
            expect(updatePayload()).not.toHaveProperty('appLauncherExposed');
        });

        it('never lets a logging failure fail the save the member already made', async () => {
            activityLog.log.mockRejectedValue(new Error('activity store down'));

            const result = await service.updateWork(WORK_ID, { appLauncherExposed: true }, user);

            expect(result.status).toBe('success');
            expect(updatePayload().appLauncherExposed).toBe(true);
        });
    });

    describe('edit rights (FR-20, ACC-11-16)', () => {
        it('refuses a viewer through the existing ensureCanEdit check, writing and logging nothing', async () => {
            const refusal = new ForbiddenException({
                status: 'error',
                message: 'You do not have permission to edit this work',
            });
            ownershipService.ensureCanEdit.mockRejectedValue(refusal);

            await expect(
                service.updateWork(WORK_ID, { appLauncherExposed: true }, user),
            ).rejects.toBe(refusal);

            expect(workRepository.update).not.toHaveBeenCalled();
            expect(activityLog.log).not.toHaveBeenCalled();
        });

        it('asks for edit rights on the same call the rest of the update path uses', async () => {
            await service.updateWork(WORK_ID, { appLauncherExposed: true }, user);

            expect(ownershipService.ensureCanEdit).toHaveBeenCalledWith(WORK_ID, 'user-1');
        });
    });

    describe('UpdateWorkDto.appLauncherExposed (plan §4.4)', () => {
        it('accepts true, false and null, and an absent field', async () => {
            for (const value of [true, false, null, undefined]) {
                const dto = plainToInstance(UpdateWorkDto, { appLauncherExposed: value });
                await expect(validate(dto)).resolves.toEqual([]);
            }
        });

        it('refuses a non-boolean value', async () => {
            for (const value of ['yes', 1, {}]) {
                const dto = plainToInstance(UpdateWorkDto, { appLauncherExposed: value });
                const errors = await validate(dto);
                expect(errors.flatMap((error) => Object.keys(error.constraints ?? {}))).toContain(
                    'isBoolean',
                );
            }
        });
    });
});
