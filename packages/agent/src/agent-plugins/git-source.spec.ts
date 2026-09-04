import { HttpException } from '@nestjs/common';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    AgentPluginGitSource,
    redactUrl,
    refMatchesPattern,
    validateGitUrl,
    type GitLike,
} from './git-source';
import { AgentPluginAllowlistService } from './allowlist.service';

function allowlistStub(result: {
    allowed: boolean;
    reason?: string;
    entry?: { versionRange?: string | null };
}): AgentPluginAllowlistService {
    return {
        check: jest.fn().mockResolvedValue({
            allowed: result.allowed,
            reason: result.reason ?? (result.allowed ? 'allowed' : 'denied'),
            entry: result.entry,
        }),
    } as unknown as AgentPluginAllowlistService;
}

function gitStub(sha = 'a'.repeat(40)): GitLike & {
    clone: jest.Mock;
    resolveRef: jest.Mock;
    listServerRefs: jest.Mock;
} {
    return {
        clone: jest.fn().mockResolvedValue(undefined),
        resolveRef: jest.fn().mockResolvedValue(sha),
        // Part of `GitLike` since the update check landed. Stubbing the whole
        // interface rather than a subset is what makes a later addition to it
        // fail HERE, at compile time, instead of at the first call.
        listServerRefs: jest.fn().mockResolvedValue([{ ref: 'HEAD', oid: sha }]),
    };
}

async function scratch(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'ap-git-'));
}

describe('validateGitUrl', () => {
    it.each([
        ['http://example.com/x.git', 'only https'],
        ['file:///etc/passwd', 'only https'],
        ['ssh://git@example.com/x.git', 'only https'],
        // `ext::sh -c whoami` DOES parse as a URL, with protocol `ext:` — so it
        // is caught by the protocol rule, not by the parse. That matters:
        // relying on the parse to reject it would have let it through.
        ['ext::sh -c whoami', 'only https'],
    ])('refuses %s', (url, expected) => {
        const result = validateGitUrl(url);
        expect(result.ok).toBe(false);
        expect(result.reason?.toLowerCase()).toContain(expected.toLowerCase());
    });

    it('refuses a URL carrying credentials, which would be persisted in cleartext', () => {
        const result = validateGitUrl('https://user:hunter2@example.com/x.git');
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('embeds credentials');
        // The refusal itself must not become the leak it is preventing.
        expect(result.reason).not.toContain('hunter2');
    });

    it('accepts a plain https URL', () => {
        const result = validateGitUrl('https://example.com/acme/skills.git');
        expect(result.ok).toBe(true);
        expect(result.url?.hostname).toBe('example.com');
    });
});

describe('redactUrl', () => {
    it('removes credentials from a parseable URL', () => {
        expect(redactUrl('https://user:hunter2@example.com/x.git')).toBe(
            'https://<redacted>@example.com/x.git',
        );
    });

    it('removes credentials from a value that does NOT parse as a URL', () => {
        // The unparseable value is the one most likely to be echoed verbatim
        // into an error, so redaction cannot depend on a successful parse.
        expect(redactUrl('https://user:hunter2@exa mple.com/[x')).not.toContain('hunter2');
    });

    it('leaves a credential-free URL untouched', () => {
        expect(redactUrl('https://example.com/x.git')).toBe('https://example.com/x.git');
    });
});

describe('refMatchesPattern', () => {
    it('matches exactly, by prefix, and by wildcard', () => {
        expect(refMatchesPattern('main', 'main')).toBe(true);
        expect(refMatchesPattern('main', 'release')).toBe(false);
        expect(refMatchesPattern('v1.2.3', 'v1.*')).toBe(true);
        expect(refMatchesPattern('v2.0.0', 'v1.*')).toBe(false);
        expect(refMatchesPattern('anything', '*')).toBe(true);
    });

    it('treats regex metacharacters literally rather than as a pattern', () => {
        // If this were compiled as a regex, `.` would match any character and
        // the grant would be silently wider than what the operator wrote.
        expect(refMatchesPattern('vAx', 'v.x')).toBe(false);
        expect(refMatchesPattern('v.x', 'v.x')).toBe(true);
    });
});

describe('AgentPluginGitSource', () => {
    it('refuses a disallowed URL WITHOUT touching the network', async () => {
        const git = gitStub();
        const source = new AgentPluginGitSource(allowlistStub({ allowed: true }));
        source.setGitImplementation(git, {});

        await expect(
            source.acquire({ url: 'http://example.com/x.git', destDir: await scratch() }),
        ).rejects.toBeInstanceOf(HttpException);

        // The whole point of ordering policy before the fetch.
        expect(git.clone).not.toHaveBeenCalled();
    });

    it('redacts credentials from the thrown response body, not just the message', async () => {
        const git = gitStub();
        const source = new AgentPluginGitSource(allowlistStub({ allowed: true }));
        source.setGitImplementation(git, {});

        await source
            .acquire({
                url: 'https://user:hunter2@example.com/x.git',
                destDir: await scratch(),
            })
            .then(
                () => {
                    throw new Error('expected the acquisition to be refused');
                },
                (err: HttpException) => {
                    // The whole body is serialised into the API response and
                    // into the log, so every field has to be clean.
                    expect(JSON.stringify(err.getResponse())).not.toContain('hunter2');
                },
            );
        expect(git.clone).not.toHaveBeenCalled();
    });

    it('refuses an unallowlisted URL WITHOUT touching the network', async () => {
        const git = gitStub();
        const source = new AgentPluginGitSource(
            allowlistStub({ allowed: false, reason: 'not on the allowlist' }),
        );
        source.setGitImplementation(git, {});

        await expect(
            source.acquire({ url: 'https://example.com/x.git', destDir: await scratch() }),
        ).rejects.toMatchObject({ status: 409 });

        expect(git.clone).not.toHaveBeenCalled();
    });

    it('refuses a ref the allowlist entry does not permit', async () => {
        const git = gitStub();
        const source = new AgentPluginGitSource(
            allowlistStub({ allowed: true, entry: { versionRange: 'v1.*' } }),
        );
        source.setGitImplementation(git, {});

        await expect(
            source.acquire({
                url: 'https://example.com/x.git',
                ref: 'attacker-branch',
                destDir: await scratch(),
            }),
        ).rejects.toMatchObject({ status: 409 });

        expect(git.clone).not.toHaveBeenCalled();
    });

    it('clones shallow, single-branch, without tags and without an auth callback', async () => {
        const git = gitStub();
        const source = new AgentPluginGitSource(allowlistStub({ allowed: true }));
        source.setGitImplementation(git, {});
        const dir = await scratch();

        const result = await source.acquire({
            url: 'https://example.com/x.git',
            ref: 'main',
            destDir: join(dir, 'pkg'),
        });

        expect(result.resolvedSha).toHaveLength(40);
        const options = git.clone.mock.calls[0][0];
        expect(options).toMatchObject({
            depth: 1,
            singleBranch: true,
            noTags: true,
            ref: 'main',
            url: 'https://example.com/x.git',
        });
        // An anonymous clone must fail rather than reach for ambient
        // credentials when a server challenges it.
        expect(options.onAuth).toBeUndefined();
    });

    it('maps a timeout to 504 and any other clone failure to 502', async () => {
        const timing = gitStub();
        timing.clone.mockRejectedValue(new Error('socket ETIMEDOUT'));
        const a = new AgentPluginGitSource(allowlistStub({ allowed: true }));
        a.setGitImplementation(timing, {});
        await expect(
            a.acquire({ url: 'https://example.com/x.git', destDir: await scratch() }),
        ).rejects.toMatchObject({ status: 504 });

        const broken = gitStub();
        broken.clone.mockRejectedValue(new Error('repository not found'));
        const b = new AgentPluginGitSource(allowlistStub({ allowed: true }));
        b.setGitImplementation(broken, {});
        await expect(
            b.acquire({ url: 'https://example.com/x.git', destDir: await scratch() }),
        ).rejects.toMatchObject({ status: 502 });
    });

    it('leaves no directory behind when the clone fails', async () => {
        const { stat } = await import('node:fs/promises');
        const git = gitStub();
        git.clone.mockRejectedValue(new Error('boom'));
        const source = new AgentPluginGitSource(allowlistStub({ allowed: true }));
        source.setGitImplementation(git, {});
        const dest = join(await scratch(), 'pkg');

        await expect(
            source.acquire({ url: 'https://example.com/x.git', destDir: dest }),
        ).rejects.toBeInstanceOf(HttpException);

        // A partial tree that a later scan could pick up and load is worse
        // than no tree at all.
        await expect(stat(dest)).rejects.toMatchObject({ code: 'ENOENT' });
    });
});
