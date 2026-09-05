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
jest.mock('../../entities/fleet-cost-policy.entity', () => ({
    FleetCostPolicy: class FleetCostPolicy {},
}));
jest.mock('../../entities/agent.entity', () => ({
    Agent: class Agent {},
}));
jest.mock('../../entities/fleet-agent-node-affinity.entity', () => ({
    FleetAgentNodeAffinity: class FleetAgentNodeAffinity {},
}));
jest.mock('../../entities/fleet-kill-switch.entity', () => ({
    FleetKillSwitch: class FleetKillSwitch {},
}));
jest.mock('../../entities/fleet-audit.entity', () => ({
    FleetAudit: class FleetAudit {},
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
jest.mock('../fleet-agent-node-affinity.repository', () => ({
    FleetAgentNodeAffinityRepository: class FleetAgentNodeAffinityRepository {},
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
jest.mock('../fleet-agent-node-affinity.service', () => ({
    FleetAgentNodeAffinityService: class FleetAgentNodeAffinityService {},
}));
jest.mock('../fleet-cost-policy.repository', () => ({
    FleetCostPolicyRepository: class FleetCostPolicyRepository {},
}));
jest.mock('../fleet-cost-ceiling.service', () => ({
    FleetCostCeilingService: class FleetCostCeilingService {},
}));
jest.mock('../fleet-kill-switch.repository', () => ({
    FleetKillSwitchRepository: class FleetKillSwitchRepository {},
}));
jest.mock('../fleet-kill-switch.service', () => ({
    FleetKillSwitchService: class FleetKillSwitchService {},
}));
jest.mock('../fleet-audit.service', () => ({
    FleetAuditService: class FleetAuditService {},
}));

import 'reflect-metadata';
import { FleetModule } from '../fleet.module';
import { FleetNodeRepository } from '../fleet-node.repository';
import { FleetJobRepository } from '../fleet-job.repository';
import { FleetService } from '../fleet.service';
import { FleetJobService } from '../fleet-job.service';
import { FleetExecutionPreferenceRepository } from '../fleet-execution-preference.repository';
import { FleetExecutionPreferenceService } from '../fleet-execution-preference.service';
import { FleetAgentNodeAffinityRepository } from '../fleet-agent-node-affinity.repository';
import { FleetAgentNodeAffinityService } from '../fleet-agent-node-affinity.service';
import { FleetCostPolicyRepository } from '../fleet-cost-policy.repository';
import { FleetCostCeilingService } from '../fleet-cost-ceiling.service';
import { FleetKillSwitchRepository } from '../fleet-kill-switch.repository';
import { FleetKillSwitchService } from '../fleet-kill-switch.service';
import { FleetAuditService } from '../fleet-audit.service';

describe('FleetModule', () => {
    const meta = (key: string): unknown[] => Reflect.getMetadata(key, FleetModule) ?? [];

    // Fleet cost accounting (EW-777) appended the cost-policy repository and
    // the daily-ceiling service to both lists; panic controls (EW-778) then
    // appended the kill-switch repository, the audit service and the
    // kill-switch service. The pin below grew with both so the shape stays
    // exact — a provider added without updating it fails here.
    it('provides the registry, the job-runtime halves, the routing preference, the cost ceilings and the panic controls', () => {
        expect(meta('providers')).toEqual([
            FleetNodeRepository,
            FleetJobRepository,
            FleetExecutionPreferenceRepository,
            FleetAgentNodeAffinityRepository,
            FleetCostPolicyRepository,
            FleetKillSwitchRepository,
            FleetService,
            FleetJobService,
            FleetExecutionPreferenceService,
            FleetAgentNodeAffinityService,
            FleetCostCeilingService,
            FleetAuditService,
            FleetKillSwitchService,
        ]);
    });

    it('exports every provider for the API surface + chat-tool assembly', () => {
        expect(meta('exports')).toEqual([
            FleetNodeRepository,
            FleetJobRepository,
            FleetExecutionPreferenceRepository,
            FleetAgentNodeAffinityRepository,
            FleetCostPolicyRepository,
            FleetKillSwitchRepository,
            FleetService,
            FleetJobService,
            FleetExecutionPreferenceService,
            FleetAgentNodeAffinityService,
            FleetCostCeilingService,
            FleetAuditService,
            FleetKillSwitchService,
        ]);
    });

    // EW-778 — the api-side AgentsModule binds RUN_KILL_SWITCH to this
    // service with `useExisting`, which only resolves when the fleet
    // module EXPORTS it. An unexported service would leave the gate's
    // @Optional() injection undefined and the stop flag silently dark.
    it('exports the kill switch so the gate port binding can resolve it', () => {
        expect(meta('exports')).toContain(FleetKillSwitchService);
        expect(meta('exports')).toContain(FleetAuditService);
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
        expect(barrel.FleetAgentNodeAffinityService).toBe(FleetAgentNodeAffinityService);
        expect(barrel.FleetAgentNodeAffinityRepository).toBe(FleetAgentNodeAffinityRepository);
        expect(barrel.FleetCostPolicyRepository).toBe(FleetCostPolicyRepository);
        expect(barrel.FleetCostCeilingService).toBe(FleetCostCeilingService);
        expect(barrel.FleetKillSwitchService).toBe(FleetKillSwitchService);
        expect(barrel.FleetKillSwitchRepository).toBe(FleetKillSwitchRepository);
        expect(barrel.FleetAuditService).toBe(FleetAuditService);
        expect(typeof barrel.buildFleetTools).toBe('function');
    });

    it('re-exports the shared node-credential helper, so enroll / heartbeat / lease cannot drift', () => {
        expect(typeof barrel.verifyNodeSecret).toBe('function');
        expect(typeof barrel.constantTimeEquals).toBe('function');
    });
});
