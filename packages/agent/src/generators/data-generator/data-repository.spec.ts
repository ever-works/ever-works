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
});
