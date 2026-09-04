import { mkdir, mkdtemp, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    AgentPluginPackageDataDirService,
    dataDirSegment,
    isWithin,
} from './package-data-dir.service';

describe('dataDirSegment', () => {
    it('keeps a readable prefix so an operator can tell what a directory is', () => {
        expect(dataDirSegment('acme.tools')).toMatch(/^acme\.tools-[0-9a-f]{12}$/u);
    });

    it('produces a path-safe segment from anything', () => {
        // A user id is whatever the platform issues, and sourceRef-derived
        // values have been attacker-influenced before. Hashing sidesteps the
        // question of which characters are safe on which platform.
        for (const nasty of ['../../etc', 'a/b\\c', '..', '.', 'C:\\evil', '', '   ']) {
            const segment = dataDirSegment(nasty);
            expect(segment).not.toContain('/');
            expect(segment).not.toContain('\\');
            expect(segment).not.toMatch(/^\.+$/u);
            expect(segment.length).toBeGreaterThan(0);
        }
    });

    it('gives different inputs different segments even when they slugify alike', () => {
        // Without the hash, `a/b` and `a-b` would collide — and a collision
        // between two tenants is a shared writable directory.
        expect(dataDirSegment('a/b')).not.toBe(dataDirSegment('a-b'));
    });

    it('is stable, so a package finds its own data again next launch', () => {
        expect(dataDirSegment('acme.tools')).toBe(dataDirSegment('acme.tools'));
    });
});

describe('isWithin', () => {
    it('does not treat a sibling with a shared prefix as contained', () => {
        // The classic containment bug: `/data/acme-2` starts with `/data/acme`.
        expect(isWithin('/data/acme', '/data/acme-2')).toBe(false);
        expect(isWithin('/data/acme', '/data/acme/x')).toBe(true);
        expect(isWithin('/data/acme', '/data/acme')).toBe(true);
    });

    it('refuses relative paths outright rather than guessing a base', () => {
        expect(isWithin('data', '/data/x')).toBe(false);
        expect(isWithin('/data', 'data/x')).toBe(false);
    });
});

describe('AgentPluginPackageDataDirService', () => {
    const originalEnv = process.env;
    let service: AgentPluginPackageDataDirService;
    let dataRoot: string;

    beforeEach(async () => {
        process.env = { ...originalEnv };
        dataRoot = await mkdtemp(join(tmpdir(), 'ap-data-'));
        process.env.AGENT_PLUGINS_DATA_DIR = dataRoot;
        service = new AgentPluginPackageDataDirService();
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    it('puts the OWNER segment first, so a tenant is one subtree', async () => {
        const path = service.pathFor({ userId: 'user-1', packageName: 'acme.tools' });

        // Per-tenant quota, backup and deletion become a single subtree
        // operation rather than a scan for matching leaves.
        const relative = path.slice(dataRoot.length + 1).split(/[\\/]/u);
        expect(relative[0]).toContain(dataDirSegment('user-1'));
        expect(relative[1]).toContain('acme.tools');
    });

    it('gives two tenants running the same package different directories', () => {
        const a = service.pathFor({ userId: 'user-1', packageName: 'acme.tools' });
        const b = service.pathFor({ userId: 'user-2', packageName: 'acme.tools' });

        expect(a).not.toBe(b);
    });

    it('computes a path WITHOUT creating anything', async () => {
        const path = service.pathFor({ userId: 'user-1', packageName: 'acme.tools' });

        // Resolving a path for display or comparison must not have a side
        // effect, so creation is a separate call.
        await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('creates the directory on ensure, and is idempotent', async () => {
        const owner = { userId: 'user-1', packageName: 'acme.tools' };

        const first = await service.ensure(owner);
        const second = await service.ensure(owner);

        expect(first).toBe(second);
        await expect(stat(first)).resolves.toMatchObject({});
    });

    it('REFUSES a leaf that is a symlink pointing outside the data root', async () => {
        // A mounted volume is commonly a symlink, and a pre-existing
        // symlinked leaf placed by anything else would otherwise hand a
        // package a writable directory outside the root.
        const owner = { userId: 'user-1', packageName: 'acme.tools' };
        const target = service.pathFor(owner);
        const outside = join(dataRoot, '..', 'escaped-' + Date.now());
        await mkdir(outside, { recursive: true });
        await mkdir(join(target, '..'), { recursive: true });

        let linked = false;
        try {
            await symlink(outside, target, 'dir');
            linked = true;
        } catch {
            linked = false;
        }

        if (!linked) {
            // Said out loud rather than returned silently: an invisible skip
            // reads exactly like a passing test.
            console.warn('SKIPPED: symlink creation unavailable; the escape case did not run.');
            expect(linked).toBe(false);
            return;
        }

        await expect(service.ensure(owner)).rejects.toThrow(/outside the configured data root/u);
    });

    it('removes a package’s data', async () => {
        const owner = { userId: 'user-1', packageName: 'acme.tools' };
        const path = await service.ensure(owner);
        await writeFile(join(path, 'state.json'), '{}', 'utf8');

        await service.remove(owner);

        await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('does not throw when there is nothing to remove', async () => {
        // Uninstall has already deleted the row and the contents by this
        // point; failing here would fail an uninstall that otherwise
        // succeeded and leave the caller unsure what happened.
        await expect(
            service.remove({ userId: 'nobody', packageName: 'nothing' }),
        ).resolves.toBeUndefined();
    });
});
