/**
 * Merge-policy matrix (Wave 3, D4) — module-shape pin for PolicyModule.
 *
 * Pattern mirrors `fleet/__tests__/fleet.module.spec.ts`: heavy runtime
 * trees (TypeORM, the entity graph) are mocked at module scope so the
 * decorator metadata can be asserted without loading them under Jest's
 * CJS transformer.
 */

jest.mock('@nestjs/typeorm', () => ({
    TypeOrmModule: { forFeature: () => class TypeOrmFeatureStub {} },
    InjectRepository: () => () => undefined,
    InjectDataSource: () => () => undefined,
}));
jest.mock('../../entities/agent.entity', () => ({ Agent: class Agent {} }));
jest.mock('../../entities/work.entity', () => ({ Work: class Work {} }));
jest.mock('../../entities/organization.entity', () => ({ Organization: class Organization {} }));
jest.mock('../../entities/tenant.entity', () => ({ Tenant: class Tenant {} }));
jest.mock('../merge-policy.repository', () => ({
    MergePolicyScopeRepository: class MergePolicyScopeRepository {},
}));
jest.mock('../merge-policy.service', () => ({
    MergePolicyService: class MergePolicyService {},
}));

import 'reflect-metadata';
import { PolicyModule } from '../policy.module';
import { MERGE_POLICY_ENFORCER } from '../merge-policy.enforcer';
import { MergePolicyScopeRepository } from '../merge-policy.repository';
import { MergePolicyService } from '../merge-policy.service';

describe('PolicyModule', () => {
    const meta = (key: string): unknown[] => Reflect.getMetadata(key, PolicyModule) ?? [];

    it('provides the scope repository, the service and the enforcer binding', () => {
        expect(meta('providers')).toEqual([
            MergePolicyScopeRepository,
            MergePolicyService,
            { provide: MERGE_POLICY_ENFORCER, useExisting: MergePolicyService },
        ]);
    });

    it('exports all three so the facade can consume the TOKEN, not the class', () => {
        expect(meta('exports')).toEqual([
            MergePolicyScopeRepository,
            MergePolicyService,
            MERGE_POLICY_ENFORCER,
        ]);
    });

    it('imports only the four scope entities — a leaf module cannot cycle', () => {
        expect(meta('imports')).toHaveLength(1);
    });
});

describe('policy barrel', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const barrel = require('../index');

    it('re-exports the module, service, repository, token and tool factory', () => {
        expect(barrel.PolicyModule).toBe(PolicyModule);
        expect(barrel.MergePolicyService).toBe(MergePolicyService);
        expect(barrel.MergePolicyScopeRepository).toBe(MergePolicyScopeRepository);
        expect(barrel.MERGE_POLICY_ENFORCER).toBe(MERGE_POLICY_ENFORCER);
        expect(typeof barrel.buildMergePolicyTools).toBe('function');
    });

    it('re-exports the pure resolution + decision functions (cross-package consumers)', () => {
        expect(typeof barrel.resolveMergePolicyChain).toBe('function');
        expect(typeof barrel.evaluateAgentMerge).toBe('function');
        expect(typeof barrel.sanitizeMergePolicyOverride).toBe('function');
    });
});
