import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import { WorksConfigService } from '../services/works-config.service';
import { WorksConfigWriterService } from '../services/works-config-writer.service';

/**
 * `kind` in `.works/works.yml`.
 *
 * The writer pushes to the user's own git repository, so the two properties
 * that matter are: never clobber what they wrote, and never produce a diff
 * for a Work whose kind carries no information.
 */
describe('WorksConfigWriterService — kind', () => {
    const CONFIG_PATH = '.works/works.yml';

    const makeService = () => new WorksConfigWriterService(new WorksConfigService({} as never));

    const createWork = (kind?: string) =>
        ({
            name: 'Compare Cloud Pricing',
            kind,
            getRepoOwner: jest.fn((role?: string) =>
                role === 'website' ? 'ever-works-web' : 'ever-works',
            ),
            getDataRepo: jest.fn().mockReturnValue('compare-cloud-pricing-data'),
            getMainRepo: jest.fn().mockReturnValue('compare-cloud-pricing'),
            getWebsiteRepo: jest.fn().mockReturnValue('compare-cloud-pricing-site'),
            scheduledUpdatesEnabled: true,
            scheduledCadence: 'weekly',
        }) as never;

    const write = async (repoDir: string, work: never) => {
        await makeService().writeToDataRepository({
            work,
            dataRepository: { dir: repoDir } as never,
            request: { name: 'Compare Cloud Pricing', prompt: 'Track cloud pricing' },
        } as never);
        return fs.readFile(path.join(repoDir, CONFIG_PATH), 'utf-8');
    };

    const tmpRepo = () => fs.mkdtemp(path.join(os.tmpdir(), 'works-config-kind-'));

    it('writes the kind for a kind-aware Work', async () => {
        const repoDir = await tmpRepo();
        const raw = await write(repoDir, createWork('blog'));
        expect(yaml.parse(raw).kind).toBe('blog');
    });

    it.each(['website', 'landing-page', 'directory', 'awesome-repo', 'company'])(
        'writes the %s kind',
        async (kind) => {
            const repoDir = await tmpRepo();
            expect(yaml.parse(await write(repoDir, createWork(kind))).kind).toBe(kind);
        },
    );

    /**
     * `default` carries no information — it is also the parse-time fallback —
     * so writing it would add a diff to every existing repository for no
     * gain, and break the `cacheEmpty === cfgEmpty` invariant that
     * `flow-work-config-cache.spec.ts` pins.
     */
    it('omits the key entirely for a default-kind Work', async () => {
        const repoDir = await tmpRepo();
        const raw = await write(repoDir, createWork('default'));
        expect(yaml.parse(raw).kind).toBeUndefined();
        expect(raw).not.toContain('kind:');
    });

    it('omits the key when the Work has no kind at all', async () => {
        const repoDir = await tmpRepo();
        const raw = await write(repoDir, createWork(undefined));
        expect(raw).not.toContain('kind:');
    });

    /**
     * The byte-identical property, stated directly: a default-kind Work's
     * file must be exactly what the writer produced before `kind` existed.
     */
    it('produces an identical file for a default-kind and a kindless Work', async () => {
        const [a, b] = await Promise.all([tmpRepo(), tmpRepo()]);
        expect(await write(a, createWork('default'))).toBe(await write(b, createWork(undefined)));
    });

    /**
     * The file belongs to the user and may declare a kind this build does
     * not know — a newer server, or hand-authored. Overwriting it with our
     * view would corrupt their repository on a routine round-trip write.
     */
    it('preserves a kind already present in the file', async () => {
        const repoDir = await tmpRepo();
        await fs.mkdir(path.join(repoDir, '.works'), { recursive: true });
        await fs.writeFile(
            path.join(repoDir, CONFIG_PATH),
            ['name: Existing', 'kind: storefront'].join('\n'),
            'utf-8',
        );

        const raw = await write(repoDir, createWork('blog'));
        expect(yaml.parse(raw).kind).toBe('storefront');
    });

    it('does not overwrite an existing kind even when the Work is default', async () => {
        const repoDir = await tmpRepo();
        await fs.mkdir(path.join(repoDir, '.works'), { recursive: true });
        await fs.writeFile(
            path.join(repoDir, CONFIG_PATH),
            ['name: Existing', 'kind: directory'].join('\n'),
            'utf-8',
        );

        expect(yaml.parse(await write(repoDir, createWork('default'))).kind).toBe('directory');
    });

    it('round-trips: what the writer emits parses back to the same kind', async () => {
        const repoDir = await tmpRepo();
        const raw = await write(repoDir, createWork('landing-page'));
        const parsed = new WorksConfigService({} as never).parse(raw);
        expect(parsed.kind).toBe('landing-page');
    });
});
