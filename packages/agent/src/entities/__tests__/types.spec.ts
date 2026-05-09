import {
    SubscriptionPlanCode,
    WorkMemberRole,
    DomainEnvironment,
    ASSIGNABLE_MEMBER_ROLES,
    GenerateStatusType,
    WorkScheduleCadence,
    WorkScheduleStatus,
    WorkScheduleBillingMode,
    type AssignableMemberRole,
    type ClassToObject,
    type GenerateStatus,
    type CommunityPrState,
    type ProvidersDto,
} from '../types';

/**
 * `entities/types.ts` is a small contracts module that pins runtime enums
 * + interface shapes consumed across the agent package. Most of the
 * literals (subscription plan codes, member roles, domain environments)
 * are persisted in DB rows and matched via string equality, so a silent
 * rename is a backwards-incompat break.
 */
describe('entities/types', () => {
    describe('SubscriptionPlanCode', () => {
        it.each([
            ['FREE', 'free'],
            ['STANDARD', 'standard'],
            ['PREMIUM', 'premium'],
        ] as const)('%s → %s', (key, value) => {
            expect(SubscriptionPlanCode[key]).toBe(value);
        });

        it('has exactly 3 plan codes', () => {
            const literals = Object.values(SubscriptionPlanCode).filter(
                (v) => typeof v === 'string',
            );
            expect(literals).toHaveLength(3);
            // Pinned ascending tier order: free → standard → premium.
            expect(literals).toEqual(['free', 'standard', 'premium']);
        });
    });

    describe('WorkMemberRole', () => {
        it.each([
            ['OWNER', 'owner'],
            ['MANAGER', 'manager'],
            ['EDITOR', 'editor'],
            ['VIEWER', 'viewer'],
        ] as const)('%s → %s', (key, value) => {
            expect(WorkMemberRole[key]).toBe(value);
        });

        it('has exactly 4 roles (no silent additions)', () => {
            const literals = Object.values(WorkMemberRole).filter((v) => typeof v === 'string');
            expect(literals).toHaveLength(4);
        });

        it('every literal is unique', () => {
            const literals = Object.values(WorkMemberRole).filter((v) => typeof v === 'string');
            expect(new Set(literals).size).toBe(literals.length);
        });
    });

    describe('ASSIGNABLE_MEMBER_ROLES', () => {
        it('contains MANAGER + EDITOR + VIEWER (NOT OWNER)', () => {
            expect(ASSIGNABLE_MEMBER_ROLES).toEqual([
                WorkMemberRole.MANAGER,
                WorkMemberRole.EDITOR,
                WorkMemberRole.VIEWER,
            ]);
        });

        it('explicitly excludes OWNER (creator-only role)', () => {
            // The JSDoc on WorkMemberRole pins this contract: OWNER is reserved
            // for the work creator and must never appear in the assignment list.
            expect(ASSIGNABLE_MEMBER_ROLES).not.toContain(WorkMemberRole.OWNER);
        });

        it('AssignableMemberRole type is the union of the array members', () => {
            // Compile-time check: each ASSIGNABLE_MEMBER_ROLES entry is also a
            // valid AssignableMemberRole.
            const r1: AssignableMemberRole = ASSIGNABLE_MEMBER_ROLES[0];
            const r2: AssignableMemberRole = ASSIGNABLE_MEMBER_ROLES[1];
            const r3: AssignableMemberRole = ASSIGNABLE_MEMBER_ROLES[2];
            expect([r1, r2, r3]).toEqual(['manager', 'editor', 'viewer']);
        });

        it('is a frozen-by-convention `as const` array (TS enforces immutability via readonly)', () => {
            // Pin: the array literal is `as const` so it is a `readonly` tuple
            // type. Runtime behaviour is just a regular array — the TS compiler
            // is the enforcement boundary. This test is here so a future
            // refactor that drops `as const` is a deliberate change.
            expect(Array.isArray(ASSIGNABLE_MEMBER_ROLES)).toBe(true);
            expect(ASSIGNABLE_MEMBER_ROLES.length).toBe(3);
        });
    });

    describe('DomainEnvironment', () => {
        it.each([
            ['PRODUCTION', 'production'],
            ['STAGING', 'staging'],
            ['DEVELOPMENT', 'development'],
        ] as const)('%s → %s', (key, value) => {
            expect(DomainEnvironment[key]).toBe(value);
        });

        it('has exactly 3 environments', () => {
            const literals = Object.values(DomainEnvironment).filter((v) => typeof v === 'string');
            expect(literals).toHaveLength(3);
        });
    });

    describe('Re-exports from @ever-works/contracts/api', () => {
        it('re-exports GenerateStatusType (enum)', () => {
            expect(typeof GenerateStatusType).toBe('object');
            // Common GenerateStatusType members exist (defensive smoke check —
            // the contracts package owns the literal set).
            const members = Object.values(GenerateStatusType).filter((v) => typeof v === 'string');
            expect(members.length).toBeGreaterThan(0);
        });

        it('re-exports WorkScheduleCadence (enum)', () => {
            const members = Object.values(WorkScheduleCadence).filter((v) => typeof v === 'string');
            expect(members.length).toBeGreaterThan(0);
        });

        it('re-exports WorkScheduleStatus (enum)', () => {
            const members = Object.values(WorkScheduleStatus).filter((v) => typeof v === 'string');
            expect(members.length).toBeGreaterThan(0);
        });

        it('re-exports WorkScheduleBillingMode (enum)', () => {
            const members = Object.values(WorkScheduleBillingMode).filter(
                (v) => typeof v === 'string',
            );
            expect(members.length).toBeGreaterThan(0);
        });
    });

    describe('GenerateStatus type literal acceptance', () => {
        it('accepts a minimal GenerateStatus with only `status`', () => {
            const s: GenerateStatus = {
                status: Object.values(GenerateStatusType)[0] as any,
            };
            expect(s.status).toBeDefined();
        });

        it('accepts every documented optional field', () => {
            const s: GenerateStatus = {
                status: Object.values(GenerateStatusType)[0] as any,
                step: 'prompt-processing',
                stepName: 'Prompt Processing',
                stepIndex: 0,
                totalSteps: 15,
                progress: 50,
                itemsProcessed: 25,
                error: 'oops',
                warnings: ['rate-limited'],
                recentLogs: [],
            };
            expect(s.step).toBe('prompt-processing');
            expect(s.stepIndex).toBe(0);
            expect(s.warnings).toEqual(['rate-limited']);
        });
    });

    describe('CommunityPrState type literal acceptance', () => {
        it('accepts the minimal shape with only processedPrNumbers', () => {
            const s: CommunityPrState = { processedPrNumbers: [1, 2, 3] };
            expect(s.processedPrNumbers).toEqual([1, 2, 3]);
        });

        it('accepts every documented optional field', () => {
            const s: CommunityPrState = {
                processedPrNumbers: [42],
                processedPrs: [
                    { number: 42, updatedAt: '2026-05-09T00:00:00Z', outcome: 'applied' },
                    { number: 43, updatedAt: '2026-05-09T00:00:00Z', outcome: 'ignored' },
                ],
                lastProcessedAt: '2026-05-09T00:00:00Z',
                totalItemsAdded: 100,
                lastError: 'parse failed',
            };
            expect(s.processedPrs).toHaveLength(2);
            expect(s.lastError).toBe('parse failed');
        });

        it('accepts lastError: null (explicit clear)', () => {
            const s: CommunityPrState = { processedPrNumbers: [], lastError: null };
            expect(s.lastError).toBeNull();
        });

        it('processedPrs.outcome is restricted to "applied" | "ignored"', () => {
            // Compile-time check: only the documented two literals.
            const applied: CommunityPrState['processedPrs'] = [
                { number: 1, updatedAt: '', outcome: 'applied' },
            ];
            const ignored: CommunityPrState['processedPrs'] = [
                { number: 1, updatedAt: '', outcome: 'ignored' },
            ];
            expect(applied![0].outcome).toBe('applied');
            expect(ignored![0].outcome).toBe('ignored');
        });
    });

    describe('ClassToObject<T> mapped type', () => {
        it('accepts an object literal that mirrors a class shape', () => {
            class Cls {
                a = 1;
                b = 'two';
            }
            const obj: ClassToObject<Cls> = { a: 1, b: 'two' };
            expect(obj.a).toBe(1);
            expect(obj.b).toBe('two');
        });
    });

    describe('ProvidersDto re-export', () => {
        it('is type-only; literal {} satisfies the shape (every field is optional)', () => {
            const empty: ProvidersDto = {};
            expect(empty).toEqual({});
        });
    });
});
