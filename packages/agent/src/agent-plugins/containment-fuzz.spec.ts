import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isWithin } from './package-data-dir.service';
import { LaunchRefused, resolveCommand, resolveCwd } from './stdio-launcher';
import { redactUrl, validateGitUrl } from './git-source';
import { versionPermitted } from './npm-source';
import { connectionNameFor } from './package-mcp-reconciler.service';

/**
 * T40 — containment fuzzing over the security boundary.
 *
 * Every other suite asserts a specific case. This one generates the space of
 * escape attempts and asserts that NONE is accepted, which is the property
 * that actually matters: a containment check is only as good as the inputs
 * nobody thought to try.
 *
 * The generators below are deliberately mechanical — separator variants,
 * encodings, prefixes — because a hand-written list reflects the same
 * assumptions as the code it is testing.
 */

const SEPARATORS = ['/', '\\'];
const TRAVERSALS = ['..', '%2e%2e', '....//', '.%2e', '..;'];
const ABSOLUTE_PREFIXES = ['/', '//', '\\\\', 'C:\\', 'C:/', '\\\\?\\C:\\', '\\\\server\\share'];

/** Path-ish strings that must never be accepted as a package-relative value. */
function escapeAttempts(): string[] {
    const out = new Set<string>();

    for (const sep of SEPARATORS) {
        for (const trav of TRAVERSALS) {
            out.add(`${trav}${sep}etc${sep}passwd`);
            out.add(`.${sep}${trav}${sep}elsewhere`);
            out.add(`.${sep}bin${sep}${trav}${sep}${trav}${sep}etc`);
            out.add(`${trav}${sep}${trav}${sep}${trav}`);
        }
    }
    for (const prefix of ABSOLUTE_PREFIXES) {
        out.add(`${prefix}etc/passwd`);
        out.add(`${prefix}`);
    }
    out.add('\0/etc/passwd');
    out.add('./bin/\0../../etc');
    out.add('${PLUGIN_ROOT}/../elsewhere');
    out.add('${PLUGIN_DATA}/../elsewhere');
    out.add('~');
    out.add('~/.ssh/id_rsa');

    return [...out];
}

let pkg: string;
let data: string;

beforeAll(async () => {
    const root = await mkdtemp(join(tmpdir(), 'ap-fuzz-'));
    pkg = join(root, 'package');
    data = join(root, 'data');
    await mkdir(join(pkg, 'bin'), { recursive: true });
    await mkdir(data, { recursive: true });
    await writeFile(join(pkg, 'bin', 'server'), '#!/bin/sh\n', 'utf8');
});

describe('containment fuzz — command resolution', () => {
    it('refuses every generated escape attempt', async () => {
        const accepted: string[] = [];

        for (const attempt of escapeAttempts()) {
            try {
                const result = await resolveCommand(attempt, pkg);
                // A bare name is legitimate; anything that resolved to a PATH
                // lookup has not escaped anything. Only a resolved FILE path
                // that landed outside the package is a failure.
                if (!result.resolvesThroughPath && !isWithin(pkg, result.command)) {
                    accepted.push(attempt);
                }
            } catch (err) {
                expect(err).toBeInstanceOf(LaunchRefused);
            }
        }

        expect(accepted).toEqual([]);
    });

    it('accepts the one shape that is supposed to work', async () => {
        // A fuzz suite that refuses everything proves nothing, so this pins
        // that the legitimate case still passes.
        const result = await resolveCommand('./bin/server', pkg);
        expect(isWithin(pkg, result.command)).toBe(true);
    });
});

describe('containment fuzz — cwd resolution', () => {
    it('never resolves outside the anchor it names', async () => {
        const escaped: string[] = [];

        for (const attempt of escapeAttempts()) {
            try {
                const resolved = await resolveCwd(attempt, {
                    packageRoot: pkg,
                    pluginData: data,
                });
                if (!isWithin(pkg, resolved) && !isWithin(data, resolved)) {
                    escaped.push(`${attempt} -> ${resolved}`);
                }
            } catch (err) {
                expect(err).toBeInstanceOf(LaunchRefused);
            }
        }

        expect(escaped).toEqual([]);
    });
});

describe('containment fuzz — isWithin', () => {
    it('never reports containment for a sibling sharing a prefix', () => {
        const roots = ['/data/acme', '/data/a', '/srv/x'];
        const wrong: string[] = [];

        for (const root of roots) {
            for (const suffix of ['-2', '2', '.bak', 'x', '-evil/nested']) {
                const sibling = `${root}${suffix}`;
                if (isWithin(root, sibling)) {
                    wrong.push(`${root} <- ${sibling}`);
                }
            }
        }

        expect(wrong).toEqual([]);
    });

    it('still reports containment for genuine descendants', () => {
        expect(isWithin('/data/acme', '/data/acme/x/y')).toBe(true);
        expect(isWithin('/data/acme', '/data/acme')).toBe(true);
    });
});

describe('containment fuzz — git URL policy', () => {
    it('refuses every non-https scheme and every credential form', () => {
        const attempts = [
            'http://example.com/x.git',
            'file:///etc/passwd',
            'ftp://example.com/x',
            'ssh://git@example.com/x.git',
            'git://example.com/x.git',
            'ext::sh -c whoami',
            'javascript:alert(1)',
            'data:text/plain,hello',
            'https://user:pw@example.com/x.git',
            'https://:pw@example.com/x.git',
            'https://user:@example.com/x.git',
        ];

        const accepted = attempts.filter((url) => validateGitUrl(url).ok);
        expect(accepted).toEqual([]);
    });

    it('never leaves a credential in a refusal, whatever the shape', () => {
        const secrets = ['hunter2', 'sk-live-abcdef', 'ghp_zzzz'];
        const leaked: string[] = [];

        for (const secret of secrets) {
            for (const url of [
                `https://user:${secret}@example.com/x.git`,
                `https://${secret}:x@example.com/x.git`,
                `http://user:${secret}@example.com/x`,
                `https://user:${secret}@exa mple.com/[x`,
            ]) {
                const result = validateGitUrl(url);
                if (result.reason?.includes(secret)) leaked.push(url);
                if (redactUrl(url).includes(secret)) leaked.push(`redactUrl: ${url}`);
            }
        }

        expect(leaked).toEqual([]);
    });

    it('still accepts an ordinary https URL', () => {
        expect(validateGitUrl('https://github.com/acme/skills.git').ok).toBe(true);
    });
});

describe('containment fuzz — derived identifiers', () => {
    it('never derives a connection name outside the permitted charset', () => {
        const inputs = ['../evil', 'a/b', 'A B C', '', '...', '@scope/pkg', '\0nul', '–dash'];
        const bad: string[] = [];

        for (const pkgName of inputs) {
            for (const server of inputs) {
                const name = connectionNameFor(pkgName, server);
                if (name !== null && !/^[a-z0-9][a-z0-9-]{0,79}$/u.test(name)) {
                    bad.push(`${pkgName} + ${server} -> ${name}`);
                }
            }
        }

        expect(bad).toEqual([]);
    });

    it('never treats a crafted range as permitting an arbitrary version', () => {
        // The range is operator-supplied, so a value that accidentally matched
        // everything would silently widen an authorisation.
        expect(versionPermitted('9.9.9', '1.0.0')).toBe(false);
        expect(versionPermitted('9.9.9', '1.')).toBe(false);
        expect(versionPermitted('9.9.9', '^1.0.0')).toBe(false);
        expect(versionPermitted('9.9.9', '1.*')).toBe(false);
        // Only an explicit wildcard opens it, which an operator can see.
        expect(versionPermitted('9.9.9', '*')).toBe(true);
    });
});
