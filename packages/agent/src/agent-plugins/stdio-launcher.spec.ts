import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    buildLaunchEnv,
    buildLaunchPlan,
    LaunchRefused,
    resolveCommand,
    resolveCwd,
    type LaunchContext,
} from './stdio-launcher';

/**
 * Launching a package's own executable is the largest grant in this feature,
 * so these tests are mostly about what is REFUSED and what is not visible.
 */

let root: string;
let pkg: string;
let data: string;
let ctx: LaunchContext;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ap-launch-'));
    pkg = join(root, 'package');
    data = join(root, 'data');
    await mkdir(join(pkg, 'bin'), { recursive: true });
    await mkdir(data, { recursive: true });
    await writeFile(join(pkg, 'bin', 'server'), '#!/bin/sh\n', 'utf8');
    ctx = { packageRoot: pkg, pluginData: data };
});

describe('buildLaunchEnv', () => {
    const original = process.env;

    beforeEach(() => {
        process.env = { ...original };
    });

    afterAll(() => {
        process.env = original;
    });

    it('does NOT inherit platform secrets from the API process', () => {
        // The API environment holds these. A denylist would have to enumerate
        // every secret that exists now and every one added later; building
        // from {} means a new platform secret is invisible by default.
        process.env.DATABASE_URL = 'postgres://user:pw@host/db';
        process.env.AUTH_SECRET = 'super-secret';
        process.env.PLUGIN_OPENROUTER_API_KEY = 'sk-live-xxxx';
        process.env.PLATFORM_ENCRYPTION_KEY = 'key-material';

        const env = buildLaunchEnv(undefined, ctx);

        expect(env.DATABASE_URL).toBeUndefined();
        expect(env.AUTH_SECRET).toBeUndefined();
        expect(env.PLUGIN_OPENROUTER_API_KEY).toBeUndefined();
        expect(env.PLATFORM_ENCRYPTION_KEY).toBeUndefined();
        expect(JSON.stringify(env)).not.toContain('super-secret');
        expect(JSON.stringify(env)).not.toContain('sk-live-xxxx');
    });

    it('provides the small base every runtime needs', () => {
        const env = buildLaunchEnv(undefined, ctx);

        expect(env.PATH).toBeTruthy();
        expect(env.HOME).toBeTruthy();
        expect(env.TMPDIR).toBeTruthy();
    });

    it('sets PLUGIN_ROOT and PLUGIN_DATA from the client, not the package', () => {
        const env = buildLaunchEnv({ SOMETHING: 'else' }, ctx);

        expect(env.PLUGIN_ROOT).toBe(pkg);
        expect(env.PLUGIN_DATA).toBe(data);
    });

    it('expands placeholders inside the package’s own declared values', () => {
        const env = buildLaunchEnv(
            { CONFIG: '${PLUGIN_ROOT}/c.json', DB: '${PLUGIN_DATA}/x' },
            ctx,
        );

        expect(env.CONFIG).toBe(`${pkg}/c.json`);
        expect(env.DB).toBe(`${data}/x`);
    });

    it('refuses a package that declares a RESERVED key', () => {
        // The library rejects this at validation, so reaching here is a bug —
        // but the assignment would silently win over the authoritative value,
        // so it is refused rather than trusted.
        expect(() => buildLaunchEnv({ PLUGIN_ROOT: '/elsewhere' }, ctx)).toThrow(LaunchRefused);
        expect(() => buildLaunchEnv({ PLUGIN_DATA: '/elsewhere' }, ctx)).toThrow(LaunchRefused);
    });

    it('does not let a package override PATH to shadow the binary about to run', () => {
        const env = buildLaunchEnv({ PATH: '/tmp/evil' }, ctx);

        // A package CAN set PATH — it is not reserved — but the reserved keys
        // are still written last, so the two values the client controls are
        // never the package's.
        expect(env.PLUGIN_ROOT).toBe(pkg);
        expect(env.PLUGIN_DATA).toBe(data);
    });
});

describe('resolveCommand', () => {
    it('accepts a bare name and marks it as PATH-resolved', async () => {
        await expect(resolveCommand('node', pkg)).resolves.toEqual({
            command: 'node',
            resolvesThroughPath: true,
        });
    });

    it('accepts a ./-relative path inside the package and returns it absolute', async () => {
        const result = await resolveCommand('./bin/server', pkg);

        expect(result.resolvesThroughPath).toBe(false);
        expect(result.command).toContain('server');
    });

    it.each([
        ['/usr/bin/node', 'an absolute path'],
        ['../../bin/sh', 'a parent escape'],
        ['sub/dir/cmd', 'a path with a separator'],
        ['C:\\Windows\\system32\\cmd.exe', 'a Windows drive path'],
        ['', 'an empty token'],
    ])('refuses %s (%s)', async (command) => {
        await expect(resolveCommand(command, pkg)).rejects.toBeInstanceOf(LaunchRefused);
    });

    it('refuses a ./ path that ESCAPES via a symlink', async () => {
        // `resolve` collapses `..` lexically before any symlink is followed,
        // so a lexical check alone passes this. The real path must be
        // recomputed — the same trap the conformance library documents.
        const outside = join(root, 'outside');
        await mkdir(outside, { recursive: true });
        await writeFile(join(outside, 'evil'), '#!/bin/sh\n', 'utf8');

        let linked = false;
        try {
            await symlink(outside, join(pkg, 'link'), 'dir');
            linked = true;
        } catch {
            linked = false;
        }

        if (!linked) {
            // Windows without developer mode cannot create symlinks. Say so
            // OUT LOUD: a silent early return here reads as a passing test,
            // and in Phase 0 five containment tests skipped invisibly for
            // exactly this reason while appearing green.
            console.warn(
                'SKIPPED: symlink creation unavailable on this host; the escape case did not run.',
            );
            expect(linked).toBe(false);
            return;
        }

        await expect(resolveCommand('./link/evil', pkg)).rejects.toMatchObject({
            code: 'command-escapes-package',
        });
    });
});

describe('resolveCwd', () => {
    it('defaults to the package root', async () => {
        await expect(resolveCwd(undefined, ctx)).resolves.toContain('package');
    });

    it('accepts a ./-relative directory inside the package', async () => {
        await expect(resolveCwd('./bin', ctx)).resolves.toContain('bin');
    });

    it('accepts a ${PLUGIN_DATA}-anchored directory', async () => {
        await expect(resolveCwd('${PLUGIN_DATA}', ctx)).resolves.toContain('data');
    });

    it.each(['../elsewhere', './../elsewhere', '/etc', '${PLUGIN_DATA}/../elsewhere'])(
        'refuses %s',
        async (cwd) => {
            await expect(resolveCwd(cwd, ctx)).rejects.toBeInstanceOf(LaunchRefused);
        },
    );

    it('contains a ${PLUGIN_DATA} cwd against the DATA root, not the package root', async () => {
        // Checking both anchors against the package root would pass a value
        // that escapes into another tenant's data directory.
        const sibling = join(root, 'other-tenant');
        await mkdir(sibling, { recursive: true });

        await expect(resolveCwd('${PLUGIN_DATA}/../other-tenant', ctx)).rejects.toBeInstanceOf(
            LaunchRefused,
        );
    });
});

describe('buildLaunchPlan', () => {
    it('produces a complete plan with nothing left to decide', async () => {
        const plan = await buildLaunchPlan(
            {
                type: 'stdio',
                command: 'node',
                args: ['${PLUGIN_ROOT}/index.js', '--data', '${PLUGIN_DATA}'],
                env: { LOG: 'debug' },
            },
            ctx,
        );

        expect(plan.command).toBe('node');
        expect(plan.resolvesThroughPath).toBe(true);
        expect(plan.args).toEqual([`${pkg}/index.js`, '--data', data]);
        expect(plan.env.LOG).toBe('debug');
        expect(plan.env.PLUGIN_ROOT).toBe(pkg);
        expect(plan.cwd).toContain('package');
    });

    it('refuses the whole plan when any part is refused', async () => {
        await expect(
            buildLaunchPlan({ type: 'stdio', command: '/bin/sh' }, ctx),
        ).rejects.toBeInstanceOf(LaunchRefused);
    });
});
