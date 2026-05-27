import { ScopeContextService } from '../scope-context.service';
import { EMPTY_SCOPE } from '../scope-context.types';

describe('ScopeContextService (EW-657 Phase 5b)', () => {
    let service: ScopeContextService;

    beforeEach(() => {
        service = new ScopeContextService();
    });

    describe('getScope()', () => {
        it('returns EMPTY_SCOPE when called outside any runWith boundary', () => {
            expect(service.getScope()).toEqual(EMPTY_SCOPE);
            expect(service.getTenantId()).toBeNull();
            expect(service.getOrganizationId()).toBeNull();
        });

        it('returns the active scope inside a runWith block', () => {
            const scope = { tenantId: 't-1', organizationId: 'o-1' };
            const observed = service.runWith(scope, () => service.getScope());
            expect(observed).toEqual(scope);
        });

        it('returns EMPTY_SCOPE again after a runWith block exits', () => {
            service.runWith({ tenantId: 't-1', organizationId: 'o-1' }, () => {});
            expect(service.getScope()).toEqual(EMPTY_SCOPE);
        });
    });

    describe('runWith()', () => {
        it('nested runWith blocks fully override the parent scope (no merging)', () => {
            const outer = { tenantId: 't-outer', organizationId: 'o-outer' };
            const inner = { tenantId: 't-inner', organizationId: null };

            const observed = service.runWith(outer, () =>
                service.runWith(inner, () => service.getScope()),
            );

            expect(observed).toEqual(inner);
        });

        it('restores the parent scope when an inner runWith block exits', () => {
            const outer = { tenantId: 't-outer', organizationId: 'o-outer' };
            const inner = { tenantId: 't-inner', organizationId: 'o-inner' };

            const observed = service.runWith(outer, () => {
                service.runWith(inner, () => {});
                return service.getScope();
            });

            expect(observed).toEqual(outer);
        });

        it('propagates scope through awaited async work', async () => {
            const scope = { tenantId: 't-async', organizationId: 'o-async' };

            const observed = await service.runWith(scope, async () => {
                await new Promise((resolve) => setImmediate(resolve));
                return service.getScope();
            });

            expect(observed).toEqual(scope);
        });

        it('returns the function result', () => {
            const result = service.runWith(EMPTY_SCOPE, () => 'sentinel');
            expect(result).toBe('sentinel');
        });
    });

    describe('isolation', () => {
        it('two concurrent async runWith blocks do not bleed scope into each other', async () => {
            const a = { tenantId: 't-a', organizationId: null };
            const b = { tenantId: 't-b', organizationId: null };

            const [observedA, observedB] = await Promise.all([
                service.runWith(a, async () => {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                    return service.getTenantId();
                }),
                service.runWith(b, async () => {
                    await new Promise((resolve) => setTimeout(resolve, 5));
                    return service.getTenantId();
                }),
            ]);

            expect(observedA).toBe('t-a');
            expect(observedB).toBe('t-b');
        });
    });
});
