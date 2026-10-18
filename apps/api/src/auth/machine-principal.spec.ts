import { ForbiddenException } from '@nestjs/common';
import { IntegrationHttpException } from './integration/integration-http.exception';
import { RefuseFleetRunGuard } from './guards/refuse-fleet-run.guard';
import {
    fleetRunBindingOf,
    isHumanSession,
    machinePrincipalKind,
    presentFields,
    refuseMachinePrincipalAction,
    refuseMachinePrincipalFields,
    refuseMachinePrincipalFieldsOutside,
    requireHumanSession,
    truthyFields,
    widerAgentPermissions,
} from './machine-principal';
import type { AuthenticatedUser } from './types/auth.types';

/**
 * Works-security lane 3a (2026-10-18) — the shared predicates every
 * controller uses to tell a NON-SESSION principal (a fleet-run token, an
 * integration key) from a person, and the refusals built on them.
 */
const session = { userId: 'u1', authMethod: 'session' } as AuthenticatedUser;
const personalKey = { userId: 'u1', authMethod: 'api-key' } as AuthenticatedUser;
const integration = {
    userId: 'u1',
    authMethod: 'integration',
    integration: { keyId: 'k1', actAsUserId: null },
} as unknown as AuthenticatedUser;
const runToken = { fleetRunCredential: { jobId: 'j1', organizationId: null, agentId: 'a1' } };

const WORK_GATE_FIELDS = ['mergePolicy', 'checkDefaults', 'checksPolicy', 'repoDeclaredCommands'];

describe('machine principal detection', () => {
    it('tells a fleet run, an integration key and a person apart', () => {
        expect(machinePrincipalKind(personalKey, runToken)).toBe('fleet-run');
        expect(machinePrincipalKind(integration, {})).toBe('integration');
        expect(machinePrincipalKind(session, {})).toBeNull();
        expect(machinePrincipalKind(personalKey, undefined)).toBeNull();
        expect(fleetRunBindingOf(runToken)?.agentId).toBe('a1');
        expect(fleetRunBindingOf({ fleetRunCredential: 'junk' })).toBeNull();
    });

    it('counts only an explicit session as a person (a missing stamp is not one)', () => {
        expect(isHumanSession(session)).toBe(true);
        for (const who of [personalKey, integration, { userId: 'u1' } as AuthenticatedUser, null]) {
            expect(isHumanSession(who)).toBe(false);
        }
    });
});

describe('refuseMachinePrincipalFields', () => {
    const body = { name: 'x', mergePolicy: { allowAgentMerge: true }, checkDefaults: null };

    it('names exactly the present fields (null is a change, undefined is not)', () => {
        expect(presentFields(body, WORK_GATE_FIELDS)).toEqual(['mergePolicy', 'checkDefaults']);
        expect(presentFields({ mergePolicy: undefined }, WORK_GATE_FIELDS)).toEqual([]);
    });

    it('answers 403 to a fleet run and 422 domain_rule to an integration key', () => {
        expect(() =>
            refuseMachinePrincipalFields(personalKey, runToken, body, WORK_GATE_FIELDS, 'a Work'),
        ).toThrow(ForbiddenException);
        try {
            refuseMachinePrincipalFields(integration, {}, body, WORK_GATE_FIELDS, 'a Work');
            throw new Error('expected a refusal');
        } catch (error) {
            expect(error).toBeInstanceOf(IntegrationHttpException);
            expect((error as IntegrationHttpException).getStatus()).toBe(422);
            expect((error as IntegrationHttpException).getResponse()).toMatchObject({
                error: {
                    code: 'domain_rule',
                    details: { fields: ['mergePolicy', 'checkDefaults'] },
                },
            });
        }
    });

    it('lets a session or a personal key through, and a machine principal that sends none of the fields', () => {
        expect(() =>
            refuseMachinePrincipalFields(session, {}, body, WORK_GATE_FIELDS, 'a Work'),
        ).not.toThrow();
        expect(() =>
            refuseMachinePrincipalFields(personalKey, undefined, body, WORK_GATE_FIELDS, 'a Work'),
        ).not.toThrow();
        expect(() =>
            refuseMachinePrincipalFields(
                personalKey,
                runToken,
                { name: 'x' },
                WORK_GATE_FIELDS,
                'a Work',
            ),
        ).not.toThrow();
    });

    it('truthyFields keeps only flags set to TRUE (DTO defaults are false)', () => {
        expect(truthyFields({ a: true, b: false, c: 'true' }, ['a', 'b', 'c'])).toEqual({
            a: true,
        });
    });
});

describe('refuseMachinePrincipalAction', () => {
    it('applies only to the kinds it names', () => {
        expect(() =>
            refuseMachinePrincipalAction(integration, {}, 'run a Task', 'why', ['fleet-run']),
        ).not.toThrow();
        expect(() =>
            refuseMachinePrincipalAction(personalKey, runToken, 'run a Task', 'why', ['fleet-run']),
        ).toThrow(/A fleet-run credential cannot run a Task; why/);
    });
});

describe('requireHumanSession', () => {
    it('refuses every non-session credential with a clear message', () => {
        expect(() => requireHumanSession(personalKey, 'approve an agent proposal')).toThrow(
            /Only a person signed in to Ever Works can approve an agent proposal/,
        );
        expect(() => requireHumanSession(integration, 'approve')).toThrow(IntegrationHttpException);
        expect(() => requireHumanSession(session, 'approve')).not.toThrow();
    });
});

describe('widerAgentPermissions', () => {
    it('lists the grants the target has and the run’s own Agent lacks', () => {
        expect(
            widerAgentPermissions(
                { canCommitToRepo: true, canSpend: true, canCreateAgents: false },
                { canCommitToRepo: true, canSpend: false },
            ),
        ).toEqual(['canSpend']);
        expect(widerAgentPermissions({ canSpend: false }, {})).toEqual([]);
        expect(widerAgentPermissions({ canSpend: true }, null)).toEqual(['canSpend']);
        expect(widerAgentPermissions(null, { canSpend: true })).toEqual([]);
    });
});

describe('RefuseFleetRunGuard', () => {
    const context = (request: unknown) =>
        ({ switchToHttp: () => ({ getRequest: () => request }) }) as never;

    it('refuses a fleet run and admits everything else', () => {
        const guard = new RefuseFleetRunGuard();
        expect(() => guard.canActivate(context(runToken))).toThrow(ForbiddenException);
        expect(guard.canActivate(context({ user: personalKey }))).toBe(true);
    });
});

describe('refuseMachinePrincipalFieldsOutside (the allowlist twin)', () => {
    const allowed = ['name', 'description'];

    it('lets a machine principal set only the allowlisted fields', () => {
        expect(() =>
            refuseMachinePrincipalFieldsOutside(
                personalKey,
                runToken,
                { name: 'x', description: 'y' },
                allowed,
                'a Work',
            ),
        ).not.toThrow();
    });

    it('refuses everything else, naming the fields, including ones nobody listed yet', () => {
        expect(() =>
            refuseMachinePrincipalFieldsOutside(
                personalKey,
                runToken,
                { name: 'x', communityPrEnabled: true, brandNewSetting: 1 },
                allowed,
                'a Work',
            ),
        ).toThrow(/communityPrEnabled, brandNewSetting/);
        expect(() =>
            refuseMachinePrincipalFieldsOutside(
                integration,
                {},
                { committerEmail: 'a@b.c' },
                allowed,
                'a Work',
            ),
        ).toThrow(IntegrationHttpException);
    });

    it('ignores undefined fields and never applies to a person', () => {
        expect(() =>
            refuseMachinePrincipalFieldsOutside(
                personalKey,
                runToken,
                { name: 'x', owner: undefined },
                allowed,
                'a Work',
            ),
        ).not.toThrow();
        expect(() =>
            refuseMachinePrincipalFieldsOutside(
                session,
                {},
                { mergePolicy: {} },
                allowed,
                'a Work',
            ),
        ).not.toThrow();
    });
});
