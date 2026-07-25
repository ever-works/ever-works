/**
 * Fleet (Wave 12, slice 1) — module-shape pin for FleetModule.
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
jest.mock('../../plugins/services/plugin-registry.service', () => ({
    PluginRegistryService: class PluginRegistryService {},
}));
jest.mock('../../plugins/services/plugin-settings.service', () => ({
    PluginSettingsService: class PluginSettingsService {},
}));
jest.mock('../fleet-node.repository', () => ({
    FleetNodeRepository: class FleetNodeRepository {},
}));
jest.mock('../fleet.service', () => ({
    FleetService: class FleetService {},
}));

import 'reflect-metadata';
import { FleetModule } from '../fleet.module';
import { FleetNodeRepository } from '../fleet-node.repository';
import { FleetService } from '../fleet.service';

describe('FleetModule', () => {
    const meta = (key: string): unknown[] => Reflect.getMetadata(key, FleetModule) ?? [];

    it('provides the repository and the service', () => {
        expect(meta('providers')).toEqual([FleetNodeRepository, FleetService]);
    });

    it('exports both for the API surface + chat-tool assembly', () => {
        expect(meta('exports')).toEqual([FleetNodeRepository, FleetService]);
    });

    it('imports only the entity feature (plugins resolve via the global module)', () => {
        expect(meta('imports')).toHaveLength(1);
    });
});

describe('fleet barrel', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const barrel = require('../index');

    it('re-exports the module, service, repository and tool factory', () => {
        expect(barrel.FleetModule).toBe(FleetModule);
        expect(barrel.FleetService).toBe(FleetService);
        expect(barrel.FleetNodeRepository).toBe(FleetNodeRepository);
        expect(typeof barrel.buildFleetTools).toBe('function');
    });
});
