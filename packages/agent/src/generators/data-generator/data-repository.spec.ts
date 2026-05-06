import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DataRepository } from './data-repository';

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

        await fs.rm(repoDir, { recursive: true, force: true });
    });

    it('uses works.yml as the primary data config', async () => {
        const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'data-repository-spec-'));

        await fs.mkdir(path.join(repoDir, 'data'), { recursive: true });
        await Promise.all([
            fs.writeFile(path.join(repoDir, 'works.yml'), 'name: Compare Cloud Pricing\n', 'utf-8'),
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

        await expect(fs.readFile(path.join(repoDir, 'works.yml'), 'utf-8')).resolves.toContain(
            'name: Generated Config',
        );

        await fs.rm(repoDir, { recursive: true, force: true });
    });

    it('uses provided default config overrides when creating works.yml', async () => {
        const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'data-repository-spec-'));

        const repository = await DataRepository.create(repoDir, {
            company_name: 'Compare Cloud Pricing',
        });

        await expect(repository.getConfig()).resolves.toMatchObject({
            company_name: 'Compare Cloud Pricing',
        });
        await expect(fs.readFile(path.join(repoDir, 'works.yml'), 'utf-8')).resolves.toContain(
            'company_name: Compare Cloud Pricing',
        );

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
