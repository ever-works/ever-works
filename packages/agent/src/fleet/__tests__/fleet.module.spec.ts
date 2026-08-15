/**
 * Fleet (Wave 12, slice 1 + Desktop PRD M4) — module-shape pin for
 * FleetModule.
 *
 * Pattern mirrors `meetings.module.spec.ts`: heavy runtime trees
 * (TypeORM, the plugins services graph) are mocked at module scope so
 * the decorator metadata can be asserted without loading them under
 * Jest's CJS transformer.
 */

jest.mock('@nestjs/typeorm', () => ({
    TypeOrmModule: { forFeature: () => class TypeOrmFeatureStub {} },
    InjectRepository: () => () => undefined,
    InjectDataSource: () => () => undefined,
}));
jest.mock('../../entities/fleet-node.entity', () => ({
    FleetNode: class FleetNode {},
}));
jest.mock('../../entities/fleet-job.entity', () => ({
    FleetJob: class FleetJob {},
}));
jest.mock('../../entities/fleet-execution-preference.entity', () => ({
    FleetExecutionPreference: class FleetExecutionPreference {},
}));
jest.mock('../../plugins/services/plugin-registry.service', () => ({
    PluginRegistryService: class PluginRegistryService {},
}));
jest.mock('../../plugins/services/plugin-settings.service', () => ({
    PluginSettingsService: class PluginSettingsService {},
}));
jest.mock('../fleet-node.repository', () => ({
    FleetNodeRepository: class FleetNodeRepository {},
}));
jest.mock('../fleet-job.repository', () => ({
    FleetJobRepository: class FleetJobRepository {},
}));
jest.mock('../fleet-execution-preference.repository', () => ({
    FleetExecutionPreferenceRepository: class FleetExecutionPreferenceRepository {},
}));
jest.mock('../fleet.service', () => ({
    FleetService: class FleetService {},
}));
jest.mock('../fleet-job.service', () => ({
    FleetJobService: class FleetJobService {},
}));
jest.mock('../fleet-execution-preference.service', () => ({
    FleetExecutionPreferenceService: class FleetExecutionPreferenceService {},
}));

import 'reflect-metadata';
import { FleetModule } from '../fleet.module';
import { FleetNodeRepository } from '../fleet-node.repository';
import { FleetJobRepository } from '../fleet-job.repository';
import { FleetService } from '../fleet.service';
import { FleetJobService } from '../fleet-job.service';
import { FleetExecutionPreferenceRepository } from '../fleet-execution-preference.repository';
import { FleetExecutionPreferenceService } from '../fleet-execution-preference.service';

describe('FleetModule', () => {
    const meta = (key: string): unknown[] => Reflect.getMetadata(key, FleetModule) ?? [];

    it('provides the registry, the job-runtime halves and the routing preference', () => {
        expect(meta('providers')).toEqual([
            FleetNodeRepository,
            FleetJobRepository,
            FleetExecutionPreferenceRepository,
            FleetService,
            FleetJobService,
            FleetExecutionPreferenceService,
        ]);
    });

    it('exports all six for the API surface + chat-tool assembly', () => {
        expect(meta('exports')).toEqual([
            FleetNodeRepository,
            FleetJobRepository,
            FleetExecutionPreferenceRepository,
            FleetService,
            FleetJobService,
            FleetExecutionPreferenceService,
        ]);
    });

    it('imports only the entity feature (plugins resolve via the global module)', () => {
        expect(meta('imports')).toHaveLength(1);
    });
});

describe('fleet barrel', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const barrel = require('../index');

    it('re-exports the module, services, repositories and tool factory', () => {
        expect(barrel.FleetModule).toBe(FleetModule);
        expect(barrel.FleetService).toBe(FleetService);
        expect(barrel.FleetNodeRepository).toBe(FleetNodeRepository);
        expect(barrel.FleetJobService).toBe(FleetJobService);
        expect(barrel.FleetJobRepository).toBe(FleetJobRepository);
        expect(barrel.FleetExecutionPreferenceService).toBe(FleetExecutionPreferenceService);
        expect(barrel.FleetExecutionPreferenceRepository).toBe(FleetExecutionPreferenceRepository);
        expect(typeof barrel.buildFleetTools).toBe('function');
    });

    it('re-exports the shared node-credential helper, so enroll / heartbeat / lease cannot drift', () => {
        expect(typeof barrel.verifyNodeSecret).toBe('function');
        expect(typeof barrel.constantTimeEquals).toBe('function');
    });
});
