import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DataRepository, RuntimeYamlCompatibilityError } from './data-repository';

describe('DataRepository', () => {
    afterEach(async () => {
        jest.restoreAllMocks();
    });

    it('parses item YAML with duplicate keys by keeping the last value', async () => {
        const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'data-repository-spec-'));
        const itemDir = path.join(repoDir, 'data', 'box');

        await fs.mkdir(itemDir, { recursive: true });
        await Promise.all([
            fs.writeFile(path.join(repoDir, 'categories.yml'), '[]\n', 'utf-8'),
            fs.writeFile(path.join(repoDir, 'tags.yml'), '[]\n', 'utf-8'),
            fs.writeFile(path.join(repoDir, 'collections.yml'), '[]\n', 'utf-8'),
        ]);
        await fs.writeFile(
            path.join(itemDir, 'box.yml'),
            [
                'name: Box',
                'description: Test item',
                'brand: First',
                'brand: Box',
                'updated_at: 2026-04-05 00:09',
                '',
            ].join('\n'),
            'utf-8',
        );

        const warnSpy = jest.spyOn((DataRepository as any).logger, 'warn').mockImplementation();
        const repository = await DataRepository.create(repoDir);

        await expect(repository.getItem('box')).resolves.toMatchObject({
            slug: 'box',
            name: 'Box',
            description: 'Test item',
            brand: 'Box',
            updated_at: '2026-04-05 00:09',
        });
        expect(warnSpy).toHaveBeenCalledTimes(1);

        await expect(repository.assertRuntimeCompatible()).rejects.toMatchObject({
            name: RuntimeYamlCompatibilityError.name,
            relativePath: 'data/box/box.yml',
        });

        await fs.rm(repoDir, { recursive: true, force: true });
    });

    it('counts item works without parsing malformed item YAML', async () => {
        const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'data-repository-spec-'));
        const itemDir = path.join(repoDir, 'data', 'broken-item');

        await fs.mkdir(itemDir, { recursive: true });
        await Promise.all([
            fs.writeFile(path.join(repoDir, 'categories.yml'), '[]\n', 'utf-8'),
            fs.writeFile(path.join(repoDir, 'tags.yml'), '[]\n', 'utf-8'),
            fs.writeFile(path.join(repoDir, 'collections.yml'), '[]\n', 'utf-8'),
        ]);
        await fs.writeFile(
            path.join(itemDir, 'broken-item.yml'),
            [
                'name: Broken Item',
                'updated_at: 2026-04-04 21:39',
                'ariant | Total Params | Active Params | Min VRAM (quantized) | Target Hardware |',
                '',
            ].join('\n'),
            'utf-8',
        );

        const repository = await DataRepository.create(repoDir);

        await expect(repository.countItems()).resolves.toBe(1);
        await expect(repository.getItem('broken-item')).rejects.toThrow();
        await expect(repository.assertRuntimeCompatible()).rejects.toMatchObject({
            name: RuntimeYamlCompatibilityError.name,
            relativePath: 'data/broken-item/broken-item.yml',
        });

        await fs.rm(repoDir, { recursive: true, force: true });
    });

    it('certifies item YAML only when the strict runtime parser accepts the corpus', async () => {
        const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'data-repository-spec-'));

        await fs.mkdir(path.join(repoDir, 'data', 'valid-item'), { recursive: true });
        await fs.writeFile(
            path.join(repoDir, 'data', 'valid-item', 'valid-item.yml'),
            ['name: Valid Item', 'description: Runtime-compatible YAML', ''].join('\n'),
            'utf-8',
        );

        const repository = await DataRepository.create(repoDir);

        await expect(repository.assertRuntimeCompatible()).resolves.toBeUndefined();

        await fs.rm(repoDir, { recursive: true, force: true });
    });

    it('treats missing categories.yml and tags.yml as empty taxonomy lists', async () => {
        const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'data-repository-spec-'));
        await fs.mkdir(path.join(repoDir, 'data'), { recursive: true });

        const repository = await DataRepository.create(repoDir);

        await expect(repository.getCategories()).resolves.toEqual([]);
        await expect(repository.getTags()).resolves.toEqual([]);

        await fs.rm(repoDir, { recursive: true, force: true });
    });

    it('uses .works/works.yml as the primary data config', async () => {
        const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'data-repository-spec-'));

        await fs.mkdir(path.join(repoDir, 'data'), { recursive: true });
        await fs.mkdir(path.join(repoDir, '.works'), { recursive: true });
        await Promise.all([
            fs.writeFile(
                path.join(repoDir, '.works/works.yml'),
                'name: Compare Cloud Pricing\n',
                'utf-8',
            ),
            fs.writeFile(path.join(repoDir, 'categories.yml'), '[]\n', 'utf-8'),
            fs.writeFile(path.join(repoDir, 'tags.yml'), '[]\n', 'utf-8'),
            fs.writeFile(path.join(repoDir, 'collections.yml'), '[]\n', 'utf-8'),
        ]);

        const repository = await DataRepository.create(repoDir);

        await expect(repository.getConfig()).resolves.toMatchObject({
            name: 'Compare Cloud Pricing',
        });

        await repository.writeConfig({
            name: 'Generated Config',
            version: 1,
        } as any);

        await expect(
            fs.readFile(path.join(repoDir, '.works/works.yml'), 'utf-8'),
        ).resolves.toContain('name: Generated Config');

        await fs.rm(repoDir, { recursive: true, force: true });
    });

    it('uses provided default config overrides when creating .works/works.yml', async () => {
        const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'data-repository-spec-'));

        const repository = await DataRepository.create(repoDir, {
            company_name: 'Compare Cloud Pricing',
        });

        await expect(repository.getConfig()).resolves.toMatchObject({
            company_name: 'Compare Cloud Pricing',
        });
        await expect(
            fs.readFile(path.join(repoDir, '.works/works.yml'), 'utf-8'),
        ).resolves.toContain('company_name: Compare Cloud Pricing');

        await fs.rm(repoDir, { recursive: true, force: true });
    });

    it('reads and writes processed references', async () => {
        const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'data-repository-spec-'));
        const repository = await DataRepository.create(repoDir);

        await repository.writeReferences([
            {
                url: 'https://example.com/list?utm_source=test',
                normalized_url: 'https://example.com/list',
                first_seen_at: '2026-05-02T13:36:33.000Z',
                last_attempted_at: '2026-05-02T13:36:33.000Z',
                status: 'success',
                items_created: 4,
                pipeline: 'agent-pipeline',
            },
        ]);

        await expect(repository.getReferences()).resolves.toEqual([
            expect.objectContaining({
                url: 'https://example.com/list?utm_source=test',
                normalized_url: 'https://example.com/list',
                status: 'success',
                items_created: 4,
            }),
        ]);

        await fs.rm(repoDir, { recursive: true, force: true });
    });

    it('confines item slugs to dataDir: rejects traversal slugs, preserves legit paths', async () => {
        const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'data-repository-spec-'));
        await fs.mkdir(path.join(repoDir, 'data'), { recursive: true });

        const repository = await DataRepository.create(repoDir);
        const dataDir = path.join(repoDir, 'data');

        // (a) Malicious slugs that would escape dataDir must throw before any
        // fs sink (rm/mkdir/access) is reached — fail closed, never fail open.
        for (const hostile of ['../victim', '../../etc', '..', '.', 'a/b', 'a\\b', 'foo/../bar']) {
            await expect(repository.itemExists(hostile)).rejects.toThrow(/Invalid slug/);
            await expect(repository.removeItem(hostile)).rejects.toThrow(/Invalid slug/);
            await expect(repository.createItemDir({ slug: hostile } as any)).rejects.toThrow(
                /Invalid slug/,
            );
        }

        // Sanity: the guard actually prevented escape — no directory was
        // created outside dataDir for any hostile slug.
        await expect(fs.readdir(dataDir)).resolves.toEqual([]);

        // (b) A legitimate slugifyText-shaped slug still passes unchanged: the
        // item directory lands exactly at path.join(dataDir, slug) (the
        // pre-guard return value) and round-trips through the public API.
        const legitSlug = 'compare_cloud-pricing1';
        const expectedDir = path.join(dataDir, legitSlug);

        await expect(repository.itemExists(legitSlug)).resolves.toBe(false);
        await repository.createItemDir({ slug: legitSlug } as any);
        await expect(fs.stat(expectedDir)).resolves.toBeDefined();
        await expect(repository.itemExists(legitSlug)).resolves.toBe(true);
        await expect(fs.readdir(dataDir)).resolves.toEqual([legitSlug]);

        await fs.rm(repoDir, { recursive: true, force: true });
    });

    // The comparison read sinks take the slug of a `GET …/comparisons/:slug`
    // request: a hostile slug is refused before any file is opened, and a
    // plain one still reads `<comparisons>/<slug>/<slug>{.yml,.md,-extended.md}`.
    it('confines comparison reads to the comparison directory', async () => {
        const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'data-repository-spec-'));
        const repository = await DataRepository.create(repoDir);

        // A read that reached the disk would answer ENOENT as null/undefined;
        // only the confinement check rejects.
        for (const hostile of ['../victim', '..', '.', 'a/b', 'a\\b', '/etc/passwd', 'x\0y']) {
            await expect(repository.getComparison(hostile)).rejects.toThrow(/Invalid slug/);
            await expect(repository.getComparisonMarkdown(hostile)).rejects.toThrow(/Invalid slug/);
            await expect(repository.getComparisonExtendedMarkdown(hostile)).rejects.toThrow(
                /Invalid slug/,
            );
        }

        const slug = 'netlify--vercel';
        await repository.writeComparison({ slug, sources: [] } as any);
        await repository.writeComparisonMarkdown(slug, '# Netlify vs Vercel');
        await repository.writeComparisonExtendedMarkdown(slug, '## More');

        await expect(repository.getComparison(slug)).resolves.toMatchObject({ slug });
        await expect(repository.getComparisonMarkdown(slug)).resolves.toBe('# Netlify vs Vercel');
        await expect(repository.getComparisonExtendedMarkdown(slug)).resolves.toBe('## More');
        await expect(repository.getComparisonMarkdown('absent')).resolves.toBeUndefined();
        await expect(
            fs.readdir(path.join(repoDir, 'comparisons', slug)).then((names) => names.sort()),
        ).resolves.toEqual([`${slug}-extended.md`, `${slug}.md`, `${slug}.yml`]);

        await fs.rm(repoDir, { recursive: true, force: true });
    });

    // The data repository is the member's own GitHub repository. isomorphic-git
    // checks a mode-120000 entry out as a real symlink (fs.symlink), so a
    // committed link can point anywhere on the server. The slug checks above are
    // lexical and cannot see that; every read and write must refuse to follow a
    // link whose real target lies outside the checkout.
    describe('links that leave the cloned repository', () => {
        const SECRET = 'SERVER-SECRET=hunter2\n';
        let root: string;
        let repoDir: string;
        let outsideDir: string;

        // A directory link is a junction on Windows (no privilege needed) and
        // a plain symlink elsewhere (the type argument is ignored there).
        const linkDir = (target: string, link: string) => fs.symlink(target, link, 'junction');
        const linkFile = (target: string, link: string) => fs.symlink(target, link, 'file');

        beforeEach(async () => {
            root = await fs.mkdtemp(path.join(os.tmpdir(), 'data-repository-links-'));
            repoDir = path.join(root, 'repo');
            outsideDir = path.join(root, 'outside');
            await fs.mkdir(repoDir, { recursive: true });
            await fs.mkdir(outsideDir, { recursive: true });
            await fs.writeFile(path.join(outsideDir, 'secret.md'), SECRET, 'utf-8');
            await fs.writeFile(path.join(outsideDir, 'x.yml'), 'slug: x\nsources: []\n', 'utf-8');
            await fs.writeFile(path.join(outsideDir, 'x.md'), SECRET, 'utf-8');
            await fs.writeFile(path.join(outsideDir, 'x-extended.md'), SECRET, 'utf-8');
        });

        afterEach(async () => {
            await fs.rm(root, { recursive: true, force: true });
        });

        it('refuses a comparison file that links out of the repository', async () => {
            const compDir = path.join(repoDir, 'comparisons', 'x');
            await fs.mkdir(compDir, { recursive: true });
            await fs.writeFile(path.join(compDir, 'x.yml'), 'slug: x\nsources: []\n', 'utf-8');
            await linkFile(path.join(outsideDir, 'secret.md'), path.join(compDir, 'x.md'));
            await linkFile(path.join(outsideDir, 'secret.md'), path.join(compDir, 'x-extended.md'));

            const repository = await DataRepository.create(repoDir);

            await expect(repository.getComparison('x')).resolves.toMatchObject({ slug: 'x' });
            await expect(repository.getComparisonMarkdown('x')).rejects.toThrow(
                /link out of the data repository/,
            );
            await expect(repository.getComparisonExtendedMarkdown('x')).rejects.toThrow(
                /link out of the data repository/,
            );
        });

        it('refuses a comparison directory that links out of the repository', async () => {
            await fs.mkdir(path.join(repoDir, 'comparisons'), { recursive: true });
            await linkDir(outsideDir, path.join(repoDir, 'comparisons', 'x'));

            const repository = await DataRepository.create(repoDir);

            for (const read of [
                () => repository.getComparison('x'),
                () => repository.getComparisonMarkdown('x'),
                () => repository.getComparisonExtendedMarkdown('x'),
            ]) {
                const outcome = await read().then(
                    (value) => ({ value }),
                    (error: Error) => ({ error: error.message }),
                );
                expect(JSON.stringify(outcome)).not.toContain('hunter2');
                expect(outcome).toEqual({
                    error: expect.stringMatching(/link out of the data repository/),
                });
            }
        });

        it('refuses item, taxonomy and licence files that link out of the repository', async () => {
            const itemDir = path.join(repoDir, 'data', 'box');
            await fs.mkdir(itemDir, { recursive: true });
            await linkFile(path.join(outsideDir, 'x.yml'), path.join(itemDir, 'box.yml'));
            await linkFile(path.join(outsideDir, 'secret.md'), path.join(itemDir, 'box.md'));
            await linkFile(path.join(outsideDir, 'x.yml'), path.join(repoDir, 'categories.yml'));
            await linkFile(path.join(outsideDir, 'secret.md'), path.join(repoDir, 'LICENSE.md'));

            const repository = await DataRepository.create(repoDir);

            await expect(repository.getItem('box')).rejects.toThrow(
                /link out of the data repository/,
            );
            await expect(repository.getMarkdown('box')).rejects.toThrow(
                /link out of the data repository/,
            );
            await expect(repository.getCategories()).rejects.toThrow(
                /link out of the data repository/,
            );
            await expect(repository.getLicense()).rejects.toThrow(
                /link out of the data repository/,
            );
        });

        it('refuses to write through a link out of the repository', async () => {
            // An existing directory link: the write would land in outsideDir.
            await fs.mkdir(path.join(repoDir, 'data'), { recursive: true });
            await linkDir(outsideDir, path.join(repoDir, 'data', 'box'));
            // A dangling file link: writing it would create the target.
            const compDir = path.join(repoDir, 'comparisons', 'z');
            await fs.mkdir(compDir, { recursive: true });
            await linkFile(path.join(outsideDir, 'created.md'), path.join(compDir, 'z.md'));
            // A linked config directory.
            await linkDir(outsideDir, path.join(repoDir, '.works'));

            const repository = await DataRepository.create(repoDir);
            const before = (await fs.readdir(outsideDir)).sort();

            await expect(
                repository.writeItemMarkdown({ slug: 'box' } as any, 'pwned'),
            ).rejects.toThrow(/link out of the data repository/);
            await expect(repository.writeItem({ slug: 'box', name: 'Box' } as any)).rejects.toThrow(
                /link out of the data repository/,
            );
            await expect(repository.writeComparisonMarkdown('z', 'pwned')).rejects.toThrow(
                /link out of the data repository/,
            );
            await expect(repository.writeConfig({ company_name: 'pwned' })).rejects.toThrow(
                /link out of the data repository/,
            );

            await expect(fs.readdir(outsideDir).then((names) => names.sort())).resolves.toEqual(
                before,
            );
            await expect(fs.readFile(path.join(outsideDir, 'secret.md'), 'utf-8')).resolves.toBe(
                SECRET,
            );
        });

        it('still follows links that stay inside the repository, and a linked repository root', async () => {
            const sharedDir = path.join(repoDir, 'shared');
            const compDir = path.join(repoDir, 'comparisons', 'x');
            await fs.mkdir(sharedDir, { recursive: true });
            await fs.mkdir(compDir, { recursive: true });
            await fs.writeFile(path.join(sharedDir, 'x.md'), '# Shared', 'utf-8');
            await fs.writeFile(path.join(compDir, 'x.yml'), 'slug: x\nsources: []\n', 'utf-8');
            await linkFile(path.join(sharedDir, 'x.md'), path.join(compDir, 'x.md'));

            // The checkout itself reached through a link (a temp-dir alias).
            const alias = path.join(root, 'alias');
            await linkDir(repoDir, alias);
            const repository = await DataRepository.create(alias);

            await expect(repository.getComparison('x')).resolves.toMatchObject({ slug: 'x' });
            await expect(repository.getComparisonMarkdown('x')).resolves.toBe('# Shared');

            await repository.writeComparisonMarkdown('y', '# Y');
            await expect(repository.getComparisonMarkdown('y')).resolves.toBe('# Y');
            await repository.createItemDir({ slug: 'box' } as any);
            await repository.writeItem({ slug: 'box', name: 'Box' } as any);
            await expect(repository.getItem('box')).resolves.toMatchObject({ name: 'Box' });
            await expect(repository.ensureDefaultConfig()).resolves.toMatchObject({
                company_name: 'Acme',
            });
            await expect(
                fs.readFile(path.join(repoDir, 'comparisons', 'y', 'y.md'), 'utf-8'),
            ).resolves.toBe('# Y');
        });
    });

    it('normalizes public reference errors before writing references.yaml', async () => {
        const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'data-repository-spec-'));
        const repository = await DataRepository.create(repoDir);

        await repository.writeReferences([
            {
                url: 'https://example.com/empty',
                normalized_url: 'https://example.com/empty',
                last_attempted_at: '2026-05-02T13:36:33.000Z',
                status: 'empty',
                error: 'No items extracted',
            },
            {
                url: 'https://example.com/error',
                normalized_url: 'https://example.com/error',
                last_attempted_at: '2026-05-02T13:36:33.000Z',
                status: 'error',
                error: 'Content extraction failed for URL: https://example.com/error',
            },
        ]);

        const referencesYaml = await fs.readFile(path.join(repoDir, 'references.yml'), 'utf-8');
        expect(referencesYaml).toContain('No items retrieved from URL: https://example.com/empty');
        expect(referencesYaml).toContain('Processing failed for URL: https://example.com/error');
        expect(referencesYaml).not.toContain('No items extracted');
        expect(referencesYaml).not.toContain('Content extraction failed');

        await fs.rm(repoDir, { recursive: true, force: true });
    });
});
