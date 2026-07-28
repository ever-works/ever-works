import { OrganizationOnboardingProfileRepository } from './organization-onboarding-profile.repository';

/**
 * Audit item A53 — the org-level mirror of the onboarding wizard's
 * "What do you do" answers.
 *
 * The behaviour worth pinning is `upsert`'s FIELD-LEVEL merge: the
 * wizard sends roles-only or team-size-only patches all the time, so an
 * omitted field must leave the persisted value alone while an explicit
 * `null` clears it. Getting that wrong silently wipes a previously
 * answered team size the first time somebody re-picks their roles.
 */

interface Harness {
    repository: OrganizationOnboardingProfileRepository;
    repo: {
        findOne: jest.Mock;
        create: jest.Mock;
        save: jest.Mock;
        update: jest.Mock;
    };
}

function makeHarness(existing?: Record<string, unknown> | null): Harness {
    let row: Record<string, unknown> | null = existing ?? null;
    const repo = {
        findOne: jest.fn(async () => row),
        create: jest.fn((value: Record<string, unknown>) => value),
        save: jest.fn(async (value: Record<string, unknown>) => {
            row = { ...value };
            return row;
        }),
        update: jest.fn(async (_where: unknown, patch: Record<string, unknown>) => {
            row = { ...(row ?? {}), ...patch };
            return { affected: 1 };
        }),
    };
    return {
        repository: new OrganizationOnboardingProfileRepository(repo as never),
        repo,
    };
}

describe('OrganizationOnboardingProfileRepository', () => {
    it('creates the row on the first answer', async () => {
        const { repository, repo } = makeHarness(null);

        const saved = await repository.upsert('org-1', {
            roles: ['marketing'],
            teamSize: 'solo',
            updatedByUserId: 'u1',
        });

        expect(repo.create).toHaveBeenCalledWith({
            organizationId: 'org-1',
            roles: ['marketing'],
            teamSize: 'solo',
            updatedByUserId: 'u1',
        });
        expect(repo.save).toHaveBeenCalled();
        expect(saved).toMatchObject({ organizationId: 'org-1', roles: ['marketing'] });
    });

    it('updates in place when the organization already has a row', async () => {
        const { repository, repo } = makeHarness({
            organizationId: 'org-1',
            roles: ['sales'],
            teamSize: 'solo',
        });

        const saved = await repository.upsert('org-1', { roles: ['engineering'] });

        expect(repo.create).not.toHaveBeenCalled();
        expect(repo.update).toHaveBeenCalledWith(
            { organizationId: 'org-1' },
            { roles: ['engineering'] },
        );
        // The omitted `teamSize` survives — field-level merge.
        expect(saved).toMatchObject({ roles: ['engineering'], teamSize: 'solo' });
    });

    it('leaves omitted fields untouched (never writes undefined columns)', async () => {
        const { repository, repo } = makeHarness({ organizationId: 'org-1', teamSize: 'solo' });

        await repository.upsert('org-1', { updatedByUserId: 'u2' });

        expect(repo.update).toHaveBeenCalledWith(
            { organizationId: 'org-1' },
            { updatedByUserId: 'u2' },
        );
    });

    it('clears a field when an explicit null is passed', async () => {
        const { repository, repo } = makeHarness({
            organizationId: 'org-1',
            roles: ['sales'],
            teamSize: 'solo',
        });

        await repository.upsert('org-1', { roles: null, teamSize: null });

        expect(repo.update).toHaveBeenCalledWith(
            { organizationId: 'org-1' },
            { roles: null, teamSize: null },
        );
    });

    it('copies the incoming roles array instead of storing the caller reference', async () => {
        const { repository, repo } = makeHarness(null);
        const roles = ['product'];

        await repository.upsert('org-1', { roles });
        roles.push('mutated-after-the-call');

        const created = repo.create.mock.calls[0][0] as { roles: string[] };
        expect(created.roles).toEqual(['product']);
    });

    it('findByOrg queries by the organization primary key', async () => {
        const { repository, repo } = makeHarness({ organizationId: 'org-1' });

        await repository.findByOrg('org-1');

        expect(repo.findOne).toHaveBeenCalledWith({ where: { organizationId: 'org-1' } });
    });
});
