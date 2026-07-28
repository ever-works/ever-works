/**
 * Policy matrices (Wave 3 D4 + audit items G4/G14) — module-shape pin for
 * PolicyModule.
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
jest.mock('../../entities/tool-grant.entity', () => ({ ToolGrant: class ToolGrant {} }));
jest.mock('../merge-policy.repository', () => ({
    MergePolicyScopeRepository: class MergePolicyScopeRepository {},
}));
jest.mock('../merge-policy.service', () => ({
    MergePolicyService: class MergePolicyService {},
}));
jest.mock('../pull-request-gate.service', () => ({
    PullRequestGateService: class PullRequestGateService {},
    PullRequestGateRefusedError: class PullRequestGateRefusedError extends Error {},
}));
jest.mock('../tool-grant.repository', () => ({
    ToolGrantRepository: class ToolGrantRepository {},
}));
jest.mock('../tool-grant.service', () => ({
    ToolGrantService: class ToolGrantService {},
}));

import 'reflect-metadata';
import { PolicyModule } from '../policy.module';
import { MERGE_POLICY_ENFORCER } from '../merge-policy.enforcer';
import { MergePolicyScopeRepository } from '../merge-policy.repository';
import { MergePolicyService } from '../merge-policy.service';
import { PullRequestGateService } from '../pull-request-gate.service';
import { TOOL_GRANT_ENFORCER } from '../tool-grant.enforcer';
import { ToolGrantRepository } from '../tool-grant.repository';
import { ToolGrantService } from '../tool-grant.service';
import { CREDENTIAL_RESOLVER, EnvCredentialResolver } from '../credential-resolver';

describe('PolicyModule', () => {
    const meta = (key: string): unknown[] => Reflect.getMetadata(key, PolicyModule) ?? [];

    it('provides both matrices, their enforcer bindings and the credential resolver', () => {
        expect(meta('providers')).toEqual([
            MergePolicyScopeRepository,
            MergePolicyService,
            { provide: MERGE_POLICY_ENFORCER, useExisting: MergePolicyService },
            PullRequestGateService,
            ToolGrantRepository,
            ToolGrantService,
            { provide: TOOL_GRANT_ENFORCER, useExisting: ToolGrantService },
            EnvCredentialResolver,
            { provide: CREDENTIAL_RESOLVER, useExisting: EnvCredentialResolver },
        ]);
    });

    it('exports the tokens so consumers depend on the CONTRACT, not the class', () => {
        expect(meta('exports')).toEqual([
            MergePolicyScopeRepository,
            MergePolicyService,
            MERGE_POLICY_ENFORCER,
            PullRequestGateService,
            ToolGrantRepository,
            ToolGrantService,
            TOOL_GRANT_ENFORCER,
            CREDENTIAL_RESOLVER,
        ]);
    });

    it('imports only the scope entities + tool_grants — a leaf module cannot cycle', () => {
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

    it('re-exports the PR gate service + its refusal error (cross-module consumers)', () => {
        expect(barrel.PullRequestGateService).toBe(PullRequestGateService);
        expect(typeof barrel.PullRequestGateRefusedError).toBe('function');
    });

    it('re-exports the pure resolution + decision functions (cross-package consumers)', () => {
        expect(typeof barrel.resolveMergePolicyChain).toBe('function');
        expect(typeof barrel.evaluateAgentMerge).toBe('function');
        expect(typeof barrel.sanitizeMergePolicyOverride).toBe('function');
    });

    it('re-exports the tool-grant surface (G4/G12/G14)', () => {
        expect(barrel.ToolGrantService).toBe(ToolGrantService);
        expect(barrel.ToolGrantRepository).toBe(ToolGrantRepository);
        expect(barrel.TOOL_GRANT_ENFORCER).toBe(TOOL_GRANT_ENFORCER);
        expect(barrel.CREDENTIAL_RESOLVER).toBe(CREDENTIAL_RESOLVER);
        expect(typeof barrel.buildToolGrantTools).toBe('function');
        expect(typeof barrel.resolveToolGrantChain).toBe('function');
        expect(typeof barrel.decideToolGrant).toBe('function');
        expect(typeof barrel.filterSkillsByToolGrants).toBe('function');
        expect(typeof barrel.interpolateCredentials).toBe('function');
        expect(typeof barrel.redactCredentialValues).toBe('function');
        expect(typeof barrel.checkToolCredentialDeclarations).toBe('function');
    });
});
