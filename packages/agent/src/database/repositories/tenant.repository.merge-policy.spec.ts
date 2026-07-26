import { TenantRepository } from './tenant.repository';

/**
 * Merge-policy matrix (Wave 3, D4) — the TENANT write path.
 *
 * The tenant is the top of the four-scope matrix and shipped with a
 * column nothing could write. This is the write, and the two properties
 * it has to hold are the same ones the other three scopes already hold:
 * a stored policy is a sanitized PARTIAL, and "inherit" has exactly ONE
 * representation at rest (NULL), never an empty object that later reads
 * as a declared-nothing override.
 */
describe('TenantRepository.updateMergePolicy', () => {
    const makeRepo = (existing: unknown = { id: 'tenant-1', mergePolicy: null }) => {
        const rows = {
            findOne: jest.fn().mockResolvedValue(existing),
            update: jest.fn().mockResolvedValue({ affected: 1 }),
        };
        return { repo: new TenantRepository(rows as never), rows };
    };

    it('stores a sanitized partial', async () => {
        const { repo, rows } = makeRepo();
        await repo.updateMergePolicy('tenant-1', { allowAgentMerge: true });
        expect(rows.update).toHaveBeenCalledWith('tenant-1', {
            mergePolicy: { allowAgentMerge: true },
        });
    });

    it('drops unrecognized keys rather than coercing them', async () => {
        const { repo, rows } = makeRepo();
        await repo.updateMergePolicy('tenant-1', {
            allowAgentMerge: true,
            nonsense: 'yes',
        } as never);
        expect(rows.update).toHaveBeenCalledWith('tenant-1', {
            mergePolicy: { allowAgentMerge: true },
        });
    });

    it('normalizes an override that sanitizes to nothing into NULL', async () => {
        const { repo, rows } = makeRepo();
        await repo.updateMergePolicy('tenant-1', { bogus: 1 } as never);
        expect(rows.update).toHaveBeenCalledWith('tenant-1', { mergePolicy: null });
    });

    it('clears the override on an explicit null', async () => {
        const { repo, rows } = makeRepo();
        await repo.updateMergePolicy('tenant-1', null);
        expect(rows.update).toHaveBeenCalledWith('tenant-1', { mergePolicy: null });
    });

    it('returns null and writes nothing for an unknown tenant', async () => {
        const { repo, rows } = makeRepo(null);
        await expect(
            repo.updateMergePolicy('tenant-9', { allowAgentMerge: true }),
        ).resolves.toBeNull();
        expect(rows.update).not.toHaveBeenCalled();
    });
});
