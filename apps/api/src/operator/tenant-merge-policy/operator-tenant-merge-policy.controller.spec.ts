// Same posture as `merge-policy.controller.spec.ts`: the controller's DI
// types come from `@ever-works/agent` barrels whose runtime graphs do not
// load under this app's jest module mapping, and every dependency is a
// stub here anyway. Nothing about the controller's behaviour is mocked.
jest.mock('@ever-works/agent/policy', () => ({ MergePolicyService: class {} }));
jest.mock('@ever-works/agent/database', () => ({ TenantRepository: class {} }));

import { NotFoundException } from '@nestjs/common';
import { PLATFORM_DEFAULT_MERGE_POLICY } from '@ever-works/contracts';
import { OperatorTenantMergePolicyController } from './operator-tenant-merge-policy.controller';

/**
 * Merge-policy matrix (Wave 3, D4) — the TENANT write path.
 *
 * The audit's finding was precise: four scopes resolve, three can be
 * written, and the top of the matrix was inert. These specs pin the shape
 * that closes it — an operator-only surface that always answers with
 * STORED + RESOLVED, so a write's effect is visible in the same round
 * trip.
 */
describe('OperatorTenantMergePolicyController', () => {
    const resolution = {
        policy: PLATFORM_DEFAULT_MERGE_POLICY,
        source: 'tenant' as const,
        chain: [
            { scope: 'default' as const, id: null, fields: [] },
            { scope: 'tenant' as const, id: 'tenant-1', fields: ['allowAgentMerge'] as never },
        ],
    };

    function make(overrides?: {
        findById?: jest.Mock;
        updateMergePolicy?: jest.Mock;
        resolve?: jest.Mock;
    }) {
        const findById =
            overrides?.findById ??
            jest.fn().mockResolvedValue({ id: 'tenant-1', mergePolicy: { allowAgentMerge: true } });
        const updateMergePolicy =
            overrides?.updateMergePolicy ??
            jest.fn().mockResolvedValue({ id: 'tenant-1', mergePolicy: { allowAgentMerge: true } });
        const resolve = overrides?.resolve ?? jest.fn().mockResolvedValue(resolution);
        const controller = new OperatorTenantMergePolicyController(
            { findById, updateMergePolicy } as never,
            { resolve } as never,
        );
        return { controller, findById, updateMergePolicy, resolve };
    }

    it('reads the stored override alongside what it resolves to', async () => {
        const { controller, resolve } = make();
        await expect(controller.read('tenant-1')).resolves.toEqual({
            tenantId: 'tenant-1',
            stored: { allowAgentMerge: true },
            resolved: PLATFORM_DEFAULT_MERGE_POLICY,
            source: 'tenant',
            chain: resolution.chain,
        });
        expect(resolve).toHaveBeenCalledWith({ tenantId: 'tenant-1' });
    });

    it('reports a tenant that declares nothing as `stored: null`', async () => {
        const { controller } = make({
            findById: jest.fn().mockResolvedValue({ id: 'tenant-1', mergePolicy: null }),
        });
        await expect(controller.read('tenant-1')).resolves.toEqual(
            expect.objectContaining({ stored: null }),
        );
    });

    it('404s an unknown tenant on read', async () => {
        const { controller, resolve } = make({ findById: jest.fn().mockResolvedValue(null) });
        await expect(controller.read('tenant-9')).rejects.toBeInstanceOf(NotFoundException);
        expect(resolve).not.toHaveBeenCalled();
    });

    it('writes a PARTIAL override through the repository', async () => {
        const { controller, updateMergePolicy } = make();
        await controller.replace('tenant-1', { mergePolicy: { allowAgentMerge: true } });
        expect(updateMergePolicy).toHaveBeenCalledWith('tenant-1', { allowAgentMerge: true });
    });

    it('treats an omitted body as "clear the tenant override"', async () => {
        const { controller, updateMergePolicy } = make({
            updateMergePolicy: jest.fn().mockResolvedValue({ id: 'tenant-1', mergePolicy: null }),
        });
        const result = await controller.replace('tenant-1', {});
        expect(updateMergePolicy).toHaveBeenCalledWith('tenant-1', null);
        expect(result.stored).toBeNull();
    });

    it('404s an unknown tenant on write', async () => {
        const { controller } = make({ updateMergePolicy: jest.fn().mockResolvedValue(null) });
        await expect(
            controller.replace('tenant-9', { mergePolicy: { allowAgentMerge: true } }),
        ).rejects.toBeInstanceOf(NotFoundException);
    });
});
