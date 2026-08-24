// Paid-plan checkout's HTTP boundary (audit B24). Mirrors
// billing.controller.spec.ts: the agent barrels are stubbed so the spec
// never drags in @ever-works/agent/database, and the DTOs are validated
// with the same class-validator pipeline the global ValidationPipe runs.
//
// What these specs exist to pin is AUTH SCOPING:
//   - the routes are session-guarded, so an unauthenticated caller never
//     reaches the handler at all;
//   - the buyer is always the session user — no body field can name
//     another one;
//   - an `organizationId` outside the caller's tenant is rejected BEFORE
//     the payment provider is ever contacted;
//   - a checkout session belonging to another account cannot be
//     finalized, and is answered the same as one that does not exist.
class FakeBillingProviderNotConfiguredError extends Error {
    constructor(message = 'Payment provider is not configured on this deployment') {
        super(message);
        this.name = 'BillingProviderNotConfiguredError';
    }
}
class FakeBillingProviderError extends Error {
    constructor(
        message: string,
        public readonly code?: string,
    ) {
        super(message);
        this.name = 'BillingProviderError';
    }
}
class FakeUnknownSubscriptionPlanError extends Error {
    constructor(planCode: string) {
        super(`Unknown subscription plan: ${planCode}`);
        this.name = 'UnknownSubscriptionPlanError';
    }
}
class FakePlanNotPurchasableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PlanNotPurchasableError';
    }
}
class FakeActivePlanSubscriptionError extends Error {
    constructor() {
        super('An active provider subscription already exists');
        this.name = 'ActivePlanSubscriptionError';
    }
}
class FakeCheckoutSessionNotFoundError extends Error {
    constructor() {
        super('Checkout session not found');
        this.name = 'CheckoutSessionNotFoundError';
    }
}

jest.mock('@ever-works/agent/subscriptions', () => ({
    BillingProviderNotConfiguredError: FakeBillingProviderNotConfiguredError,
    BillingProviderError: FakeBillingProviderError,
    UnknownSubscriptionPlanError: FakeUnknownSubscriptionPlanError,
    PlanNotPurchasableError: FakePlanNotPurchasableError,
    ActivePlanSubscriptionError: FakeActivePlanSubscriptionError,
    CheckoutSessionNotFoundError: FakeCheckoutSessionNotFoundError,
    PlanSubscriptionService: class PlanSubscriptionService {},
}));
// 🛑 Keep this in step with the REAL enum in packages/agent/src/entities/types.ts.
// It stubbed only the three cloud codes, which silently made every DTO
// assertion here validate against a catalog that has not existed since the
// self-hosted editions landed - so a `selfhosted_pro` body looked like a 400
// in tests while the running API accepts it. A mock that lags the enum turns
// this suite from a guard into a decoy.
jest.mock('@ever-works/agent/entities', () => ({
    SubscriptionPlanCode: {
        FREE: 'free',
        STANDARD: 'standard',
        PREMIUM: 'premium',
        SELFHOSTED_COMMUNITY: 'selfhosted_community',
        SELFHOSTED_PRO: 'selfhosted_pro',
        SELFHOSTED_ENTERPRISE: 'selfhosted_enterprise',
    },
}));
jest.mock('../auth', () => ({
    AuthSessionGuard: class AuthSessionGuard {},
    CurrentUser: () => () => undefined,
}));
jest.mock('../organizations/organization-membership.service', () => ({
    OrganizationMembershipService: class OrganizationMembershipService {},
}));

import {
    BadRequestException,
    ConflictException,
    NotFoundException,
    ServiceUnavailableException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PlanCheckoutController } from './plan-checkout.controller';
import { CreatePlanCheckoutDto, PlanCheckoutReturnQueryDto } from './dto/plan-checkout.dto';
import { AuthSessionGuard } from '../auth';
import type { AuthenticatedUser } from '../auth/types/auth.types';

const auth: AuthenticatedUser = {
    userId: 'user-1',
    email: 'u@e.test',
    username: 'u',
    provider: 'local',
    emailVerified: true,
} as AuthenticatedUser;

const otherAuth: AuthenticatedUser = { ...auth, userId: 'user-2' } as AuthenticatedUser;

function makeService(overrides: Record<string, unknown> = {}) {
    return {
        startPlanCheckout: jest.fn().mockResolvedValue({
            url: 'https://pay.example/cs_plan_1',
            sessionId: 'cs_plan_1',
            planCode: 'standard',
            priceCents: 2900,
            currency: 'usd',
        }),
        syncCheckoutReturn: jest.fn().mockResolvedValue({
            status: 'active',
            activated: true,
            planCode: 'standard',
        }),
        ...overrides,
    } as any;
}

function makeMembership(overrides: Record<string, unknown> = {}) {
    return {
        ensureMember: jest.fn().mockResolvedValue({ id: 'org-1', tenantId: 'tenant-1' }),
        ...overrides,
    } as any;
}

beforeAll(() => {
    process.env.WEB_URL = 'https://app.test';
});

describe('PlanCheckoutController — route auth posture', () => {
    it('is session-guarded, so an unauthenticated request never reaches the handler', () => {
        const guards = Reflect.getMetadata('__guards__', PlanCheckoutController) ?? [];
        expect(guards).toContain(AuthSessionGuard);
    });
});

describe('POST /api/billing/checkout/plan — owner scoping', () => {
    it('starts the checkout for the AUTHENTICATED user, never a caller-supplied one', async () => {
        const service = makeService();
        const controller = new PlanCheckoutController(service, makeMembership());

        await controller.createPlanCheckout(auth, { planCode: 'standard' } as never);
        expect(service.startPlanCheckout).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'user-1', planCode: 'standard' }),
        );

        // A second caller cannot subscribe on behalf of the first.
        await controller.createPlanCheckout(otherAuth, { planCode: 'standard' } as never);
        expect(service.startPlanCheckout).toHaveBeenLastCalledWith(
            expect.objectContaining({ userId: 'user-2' }),
        );
    });

    it('builds the return URLs server-side (no client-supplied redirect)', async () => {
        const service = makeService();
        const controller = new PlanCheckoutController(service, makeMembership());

        await controller.createPlanCheckout(auth, { planCode: 'premium' } as never);

        const passed = service.startPlanCheckout.mock.calls[0][0];
        expect(passed.successUrl).toBe('https://app.test/settings/billing?plan=success');
        expect(passed.cancelUrl).toBe('https://app.test/settings/billing?plan=cancelled');
    });

    it('omits org scope entirely when the body names no organization', async () => {
        const service = makeService();
        const membership = makeMembership();
        const controller = new PlanCheckoutController(service, membership);

        await controller.createPlanCheckout(auth, { planCode: 'standard' } as never);

        expect(membership.ensureMember).not.toHaveBeenCalled();
        expect(service.startPlanCheckout).toHaveBeenCalledWith(
            expect.objectContaining({ organizationId: null, tenantId: null }),
        );
    });

    it('CANNOT start a checkout for another org — the membership check runs first', async () => {
        const service = makeService();
        // `ensureMember` answers 404 for any org outside the caller's
        // tenant (existence-leak contract).
        const membership = makeMembership({
            ensureMember: jest
                .fn()
                .mockRejectedValue(new NotFoundException('Organization org-other not found')),
        });
        const controller = new PlanCheckoutController(service, membership);

        await expect(
            controller.createPlanCheckout(auth, {
                planCode: 'standard',
                organizationId: 'org-other',
            } as never),
        ).rejects.toBeInstanceOf(NotFoundException);

        expect(membership.ensureMember).toHaveBeenCalledWith('org-other', 'user-1');
        // The payment provider is never contacted for a foreign org.
        expect(service.startPlanCheckout).not.toHaveBeenCalled();
    });

    it('authorizes the caller against the SESSION user, not a body-supplied one', async () => {
        const service = makeService();
        const membership = makeMembership();
        const controller = new PlanCheckoutController(service, membership);

        await controller.createPlanCheckout(otherAuth, {
            planCode: 'standard',
            organizationId: 'org-1',
            // Even if a smuggled userId survived validation, nothing reads it.
            userId: 'user-1',
        } as never);

        expect(membership.ensureMember).toHaveBeenCalledWith('org-1', 'user-2');
        expect(service.startPlanCheckout).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'user-2', organizationId: 'org-1' }),
        );
    });

    it('passes the RESOLVED org + tenant, never the raw request values', async () => {
        const service = makeService();
        const membership = makeMembership({
            ensureMember: jest
                .fn()
                .mockResolvedValue({ id: 'org-canonical', tenantId: 'tenant-canonical' }),
        });
        const controller = new PlanCheckoutController(service, membership);

        await controller.createPlanCheckout(auth, {
            planCode: 'standard',
            organizationId: 'org-1',
        } as never);

        expect(service.startPlanCheckout).toHaveBeenCalledWith(
            expect.objectContaining({
                organizationId: 'org-canonical',
                tenantId: 'tenant-canonical',
            }),
        );
    });

    it('maps provider-not-configured to 503 so the UI can degrade', async () => {
        const service = makeService({
            startPlanCheckout: jest
                .fn()
                .mockRejectedValue(new FakeBillingProviderNotConfiguredError()),
        });
        const controller = new PlanCheckoutController(service, makeMembership());

        await expect(
            controller.createPlanCheckout(auth, { planCode: 'standard' } as never),
        ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('maps an unknown plan and a free plan to 400', async () => {
        const unknown = new PlanCheckoutController(
            makeService({
                startPlanCheckout: jest
                    .fn()
                    .mockRejectedValue(new FakeUnknownSubscriptionPlanError('enterprise')),
            }),
            makeMembership(),
        );
        await expect(
            unknown.createPlanCheckout(auth, { planCode: 'standard' } as never),
        ).rejects.toBeInstanceOf(BadRequestException);

        const free = new PlanCheckoutController(
            makeService({
                startPlanCheckout: jest
                    .fn()
                    .mockRejectedValue(new FakePlanNotPurchasableError('Free plans')),
            }),
            makeMembership(),
        );
        await expect(
            free.createPlanCheckout(auth, { planCode: 'free' } as never),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('maps a provider-side failure to 409 rather than an unmapped 500', async () => {
        const controller = new PlanCheckoutController(
            makeService({
                startPlanCheckout: jest
                    .fn()
                    .mockRejectedValue(new FakeBillingProviderError('provider said no')),
            }),
            makeMembership(),
        );

        await expect(
            controller.createPlanCheckout(auth, { planCode: 'standard' } as never),
        ).rejects.toBeInstanceOf(ConflictException);
    });

    it('maps an existing active subscription to 409', async () => {
        const controller = new PlanCheckoutController(
            makeService({
                startPlanCheckout: jest
                    .fn()
                    .mockRejectedValue(new FakeActivePlanSubscriptionError()),
            }),
            makeMembership(),
        );

        await expect(
            controller.createPlanCheckout(auth, { planCode: 'standard' } as never),
        ).rejects.toBeInstanceOf(ConflictException);
    });
});

describe('GET /api/billing/checkout/plan/return — session ownership', () => {
    it('finalizes only for the authenticated user', async () => {
        const service = makeService();
        const controller = new PlanCheckoutController(service, makeMembership());

        const result = await controller.completePlanCheckout(auth, { sessionId: 'cs_plan_1' });

        expect(service.syncCheckoutReturn).toHaveBeenCalledWith('user-1', 'cs_plan_1');
        // The route returns `PlanCheckoutReturn` verbatim. Its `status` is
        // the SUBSCRIPTION state (`active` | `pending` | `ignored`), not a
        // `{ status: 'success' }` transport envelope — wrapping it in one
        // would collide on the key and destroy the domain value.
        expect(result).toEqual(
            expect.objectContaining({ status: 'active', activated: true, planCode: 'standard' }),
        );
    });

    it('CANNOT finalize another account’s checkout session (404, not 403)', async () => {
        // The service refuses when the session metadata names a
        // different user; the controller must not soften that into a
        // "does this session exist?" oracle.
        const service = makeService({
            syncCheckoutReturn: jest.fn().mockRejectedValue(new FakeCheckoutSessionNotFoundError()),
        });
        const controller = new PlanCheckoutController(service, makeMembership());

        await expect(
            controller.completePlanCheckout(otherAuth, { sessionId: 'cs_plan_1' }),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(service.syncCheckoutReturn).toHaveBeenCalledWith('user-2', 'cs_plan_1');
    });

    it('maps provider-not-configured to 503', async () => {
        const controller = new PlanCheckoutController(
            makeService({
                syncCheckoutReturn: jest
                    .fn()
                    .mockRejectedValue(new FakeBillingProviderNotConfiguredError()),
            }),
            makeMembership(),
        );

        await expect(
            controller.completePlanCheckout(auth, { sessionId: 'cs_plan_1' }),
        ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
});

describe('CreatePlanCheckoutDto — the client can never name a price', () => {
    async function validateBody(body: Record<string, unknown>) {
        const dto = plainToInstance(CreatePlanCheckoutDto, body, {
            // Same options as the global ValidationPipe in main.ts.
            excludeExtraneousValues: false,
        });
        return validate(dto as object, { whitelist: true, forbidNonWhitelisted: true });
    }

    it('accepts a known plan code', async () => {
        expect(await validateBody({ planCode: 'standard' })).toHaveLength(0);
        expect(await validateBody({ planCode: 'premium', organizationId: 'org-1' })).toHaveLength(
            0,
        );
    });

    it('rejects an unknown plan code', async () => {
        expect(await validateBody({ planCode: 'enterprise' })).not.toHaveLength(0);
    });

    it('rejects a body carrying a client-supplied amount (forbidNonWhitelisted)', async () => {
        for (const field of ['priceCents', 'monthlyPrice', 'amount', 'credits']) {
            const errors = await validateBody({ planCode: 'standard', [field]: 1 });
            expect(errors.map((e) => e.property)).toContain(field);
        }
    });

    it('rejects a body trying to name another buyer', async () => {
        const errors = await validateBody({ planCode: 'standard', userId: 'user-9' });
        expect(errors.map((e) => e.property)).toContain('userId');
    });

    it('rejects a missing plan code', async () => {
        expect(await validateBody({})).not.toHaveLength(0);
    });

    /**
     * H1 — `interval` and `seats` decide WHICH catalog SKU is priced. They
     * have always been accepted here and forwarded by the controller, and
     * until now no test at this boundary said so, while the web client never
     * sent them. That is what made the $99 lifetime licence unreachable: not
     * refused, just never requested.
     */
    it('accepts each supported interval, and rejects anything else', async () => {
        for (const interval of ['monthly', 'annual', 'lifetime']) {
            expect(await validateBody({ planCode: 'selfhosted_pro', interval })).toHaveLength(0);
        }
        for (const interval of ['weekly', 'perpetual', '', 1]) {
            expect(await validateBody({ planCode: 'selfhosted_pro', interval })).not.toHaveLength(
                0,
            );
        }
    });

    it('treats an omitted interval as not supplied (the server defaults to monthly)', async () => {
        // @IsOptional() skips validation for null AND undefined, so both mean
        // 'field absent' - which the controller turns into 'monthly'. Asserted
        // so a later switch to @ValidateIf cannot silently start 400ing every
        // body that predates this field.
        expect(await validateBody({ planCode: 'standard' })).toHaveLength(0);
        expect(await validateBody({ planCode: 'standard', interval: null })).toHaveLength(0);
    });

    it('accepts a seat count in range and rejects one outside it', async () => {
        expect(await validateBody({ planCode: 'standard', seats: 0 })).toHaveLength(0);
        expect(await validateBody({ planCode: 'standard', seats: 17 })).toHaveLength(0);
        for (const seats of [-1, 1.5, 100001]) {
            expect(await validateBody({ planCode: 'standard', seats })).not.toHaveLength(0);
        }
    });
});

describe('PlanCheckoutReturnQueryDto', () => {
    async function validateQuery(query: Record<string, unknown>) {
        const dto = plainToInstance(PlanCheckoutReturnQueryDto, query);
        return validate(dto as object, { whitelist: true, forbidNonWhitelisted: true });
    }

    it('accepts a provider-shaped session id', async () => {
        expect(await validateQuery({ sessionId: 'cs_test_a1B2-c3_d4' })).toHaveLength(0);
    });

    it('rejects a session id carrying path or query characters', async () => {
        for (const value of ['../../etc', 'cs_1?x=1', 'cs 1', 'https://evil.test/cs_1']) {
            expect(await validateQuery({ sessionId: value })).not.toHaveLength(0);
        }
    });

    it('rejects a smuggled userId on the query string', async () => {
        const errors = await validateQuery({ sessionId: 'cs_1', userId: 'user-9' });
        expect(errors.map((e) => e.property)).toContain('userId');
    });
});
