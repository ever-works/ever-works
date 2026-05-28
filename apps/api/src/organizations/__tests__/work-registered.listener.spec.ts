// Mock the agent barrels so importing the listener doesn't drag in the
// full TypeORM DataSource graph. We only need `WorkStatusChangedEvent`
// to construct test payloads. Same pattern as organization.service.spec.ts.
jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/events', () => ({
    WorkStatusChangedEvent: class WorkStatusChangedEvent {
        static EVENT_NAME = 'work.status.changed';
        constructor(
            public readonly workId: string,
            public readonly userId: string,
            public readonly kind: string,
            public readonly previousStatus: string,
            public readonly newStatus: string,
        ) {}
    },
}));

import { WorkStatusChangedEvent } from '@ever-works/agent/events';
import { WorkRegisteredListener } from '../work-registered.listener';

/**
 * EW-665 (Tenants & Organizations Phase 13) — unit tests for the
 * `work.status.changed` → Organization listener.
 */
describe('WorkRegisteredListener (EW-665 Phase 13)', () => {
    function makeListener(opts?: {
        work?: { id: string; name: string; companyName?: string | null } | null;
        createThrows?: boolean;
    }) {
        const work =
            opts?.work === undefined
                ? { id: 'w-1', name: 'Acme Work', companyName: 'Acme Inc.', companyWebsite: null }
                : opts.work;

        const workRepository = {
            findById: jest.fn().mockResolvedValue(work),
        };
        const organizationService = {
            createOrganizationFromCompanyWork: opts?.createThrows
                ? jest.fn().mockRejectedValue(new Error('boom'))
                : jest.fn().mockResolvedValue({ id: 'o-1', slug: 'acme' }),
        };

        const listener = new WorkRegisteredListener(
            organizationService as never,
            workRepository as never,
        );

        return { listener, workRepository, organizationService };
    }

    function evt(
        overrides: Partial<{
            workId: string;
            userId: string;
            kind: string;
            previousStatus: string;
            newStatus: string;
        }> = {},
    ) {
        return new (WorkStatusChangedEvent as never as new (
            workId: string,
            userId: string,
            kind: string,
            previousStatus: string,
            newStatus: string,
        ) => WorkStatusChangedEvent)(
            overrides.workId ?? 'w-1',
            overrides.userId ?? 'u-1',
            overrides.kind ?? 'company',
            overrides.previousStatus ?? 'draft',
            overrides.newStatus ?? 'registered',
        );
    }

    it('creates an Organization for a company Work transitioning → registered', async () => {
        const { listener, organizationService, workRepository } = makeListener();

        await listener.onWorkStatusChanged(evt());

        expect(workRepository.findById).toHaveBeenCalledWith('w-1');
        expect(organizationService.createOrganizationFromCompanyWork).toHaveBeenCalledWith('u-1', {
            id: 'w-1',
            name: 'Acme Work',
            companyName: 'Acme Inc.',
            companyWebsite: null,
        });
    });

    it('skips non-company Works', async () => {
        const { listener, organizationService, workRepository } = makeListener();

        await listener.onWorkStatusChanged(evt({ kind: 'default' }));

        expect(workRepository.findById).not.toHaveBeenCalled();
        expect(organizationService.createOrganizationFromCompanyWork).not.toHaveBeenCalled();
    });

    it('skips transitions that are not → registered', async () => {
        const { listener, organizationService } = makeListener();

        await listener.onWorkStatusChanged(evt({ newStatus: 'active' }));
        await listener.onWorkStatusChanged(evt({ newStatus: 'archived' }));

        expect(organizationService.createOrganizationFromCompanyWork).not.toHaveBeenCalled();
    });

    it('skips re-fires where the Work was already registered (previousStatus === registered)', async () => {
        const { listener, organizationService } = makeListener();

        await listener.onWorkStatusChanged(
            evt({ previousStatus: 'registered', newStatus: 'registered' }),
        );

        expect(organizationService.createOrganizationFromCompanyWork).not.toHaveBeenCalled();
    });

    it('skips (without throwing) when the Work no longer exists', async () => {
        const { listener, organizationService } = makeListener({ work: null });

        await expect(listener.onWorkStatusChanged(evt())).resolves.toBeUndefined();
        expect(organizationService.createOrganizationFromCompanyWork).not.toHaveBeenCalled();
    });

    it('swallows + logs errors from Org creation (never rethrows — detached handler)', async () => {
        const { listener, organizationService } = makeListener({ createThrows: true });

        // Must resolve, not reject — a throw here would surface as an
        // unhandled rejection in the originating request.
        await expect(listener.onWorkStatusChanged(evt())).resolves.toBeUndefined();
        expect(organizationService.createOrganizationFromCompanyWork).toHaveBeenCalledTimes(1);
    });
});
