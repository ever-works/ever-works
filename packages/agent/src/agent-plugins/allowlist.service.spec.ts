import type { Repository } from 'typeorm';
import { AgentPluginAllowlistService } from './allowlist.service';
import type { AgentPluginPackageAllowlist } from '../entities/agent-plugin-package-allowlist.entity';

/**
 * The allowlist is the only thing standing between a URL and a network fetch,
 * so these tests are about REFUSAL, not about the happy path. Every case here
 * asserts that something is denied, because the failure mode that matters is a
 * check that quietly starts allowing everything.
 */

type RepoMock = Partial<Repository<AgentPluginPackageAllowlist>>;

function entry(over: Partial<AgentPluginPackageAllowlist> = {}): AgentPluginPackageAllowlist {
    return {
        id: 'entry-1',
        packageName: 'acme-skills',
        source: 'npm',
        versionRange: null,
        integrity: null,
        enabled: true,
        notes: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
        ...over,
    } as AgentPluginPackageAllowlist;
}

function serviceWith(repo?: RepoMock): AgentPluginAllowlistService {
    return new AgentPluginAllowlistService(repo as Repository<AgentPluginPackageAllowlist>);
}

describe('AgentPluginAllowlistService', () => {
    it('refuses when no repository is bound, rather than treating it as unrestricted', async () => {
        // The @Optional() injection means an absent repository is a REAL
        // runtime state, not a test artefact. Failing open here would turn a
        // missing binding into unrestricted remote acquisition.
        const result = await serviceWith(undefined).check('acme-skills', 'npm');

        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('unavailable');
    });

    it('refuses when the allowlist lookup THROWS, and says it was a lookup failure', async () => {
        // A database blip must not read as "the allowlist is empty". The
        // distinction is also operator-facing: an outage and a missing entry
        // call for completely different responses.
        const repo: RepoMock = {
            findOne: jest.fn().mockRejectedValue(new Error('connection terminated')),
        };

        const result = await serviceWith(repo).check('acme-skills', 'npm');

        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('could not be read');
        expect(result.reason).toContain('connection terminated');
        expect(result.reason).not.toContain('not on the Agent Plugins allowlist');
    });

    it('refuses a package with no entry', async () => {
        const repo: RepoMock = { findOne: jest.fn().mockResolvedValue(null) };

        const result = await serviceWith(repo).check('acme-skills', 'npm');

        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('not on the Agent Plugins allowlist');
    });

    it('refuses a disabled entry, so revoking does not require deleting the audit trail', async () => {
        const repo: RepoMock = {
            findOne: jest.fn().mockResolvedValue(entry({ enabled: false })),
        };

        const result = await serviceWith(repo).check('acme-skills', 'npm');

        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('disabled');
        expect(result.entry).toBeDefined();
    });

    it('scopes an entry to its source, so an npm grant does not authorise a git fetch', async () => {
        const findOne = jest.fn().mockResolvedValue(null);
        await serviceWith({ findOne }).check('acme-skills', 'git');

        expect(findOne).toHaveBeenCalledWith({
            where: { packageName: 'acme-skills', source: 'git' },
        });
    });

    it('allows an enabled entry and returns it for downstream version checks', async () => {
        const row = entry({ versionRange: '1.2.*' });
        const repo: RepoMock = { findOne: jest.fn().mockResolvedValue(row) };

        const result = await serviceWith(repo).check('acme-skills', 'npm');

        expect(result.allowed).toBe(true);
        expect(result.entry).toBe(row);
    });
});
