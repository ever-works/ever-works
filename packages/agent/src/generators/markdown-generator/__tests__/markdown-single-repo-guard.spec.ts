import { MarkdownRepository } from '../markdown-repository';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * EW-028 follow-up — a single-repo managed Work must never have its data wiped.
 *
 * Managed "Ever Works Git" storage provisions ONE repository and records it under
 * BOTH the `work` and `data` roles. `GitOperations.getLocalDir` is deterministic:
 *
 *     path.join(baseDir, slugifyText(`${owner}-${repo}`))
 *
 * so the markdown clone and the data clone resolve to the SAME directory. On the
 * RECREATE path `MarkdownGeneratorService` then called `markdownRepo.resetFiles()`,
 * which deletes every entry outside a six-item allowlist — `data/`,
 * `categories.yml`, `tags.yml` and `.works/` all go — and the deletions are staged,
 * committed and PUSHED. The user's only repository is emptied, silently: the item
 * loop's reads swallow ENOENT, so nothing is logged and no warning is raised.
 *
 * This test pins the DESTRUCTIVE PRIMITIVE rather than the service, deliberately.
 * Standing up `MarkdownGeneratorService` needs a git facade, a work entity, an
 * owner, a cancellation signal and a real clone; a test built on that many mocks
 * would mostly assert the mocks. `resetFiles()` on a directory laid out like a
 * data repo is the exact operation that destroys the content, so that is what is
 * measured — with real files on disk, no mocking at all.
 */
describe('MarkdownRepository.resetFiles — what it destroys in a data repo', () => {
    let dir: string;

    /** Lay out a directory the way a managed single-repo Work looks. */
    async function seedDataRepoLayout(root: string) {
        await fs.mkdir(path.join(root, '.git'), { recursive: true });
        await fs.mkdir(path.join(root, 'data'), { recursive: true });
        await fs.mkdir(path.join(root, '.works'), { recursive: true });
        await fs.writeFile(path.join(root, 'data', 'item-one.md'), '# item one');
        await fs.writeFile(path.join(root, '.works', 'works.yml'), 'name: demo');
        await fs.writeFile(path.join(root, 'categories.yml'), '- id: tools');
        await fs.writeFile(path.join(root, 'tags.yml'), '- id: free');
        await fs.writeFile(path.join(root, 'README.md'), '# stale readme');
    }

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ew028-guard-'));
        await seedDataRepoLayout(dir);
    });

    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('control: the seeded layout really is on disk before anything runs', async () => {
        // Without this, "the files are gone" below could mean "they were never
        // written" — which would make the whole spec vacuous.
        await expect(fs.access(path.join(dir, 'data', 'item-one.md'))).resolves.toBeUndefined();
        await expect(fs.access(path.join(dir, '.works', 'works.yml'))).resolves.toBeUndefined();
        await expect(fs.access(path.join(dir, 'categories.yml'))).resolves.toBeUndefined();
    });

    it('DESTROYS the data payload — which is why the caller must not run it on a shared dir', async () => {
        await new MarkdownRepository(dir).resetFiles();

        const survived = async (p: string) =>
            fs
                .access(path.join(dir, p))
                .then(() => true)
                .catch(() => false);

        // The source data — gone.
        expect(await survived('data/item-one.md')).toBe(false);
        expect(await survived('categories.yml')).toBe(false);
        expect(await survived('tags.yml')).toBe(false);
        // `.works/works.yml` is the very artefact EW-028 exists to keep syncable,
        // and it is deleted too: `.works` is not in the allowlist and does not
        // start with `.git`.
        expect(await survived('.works/works.yml')).toBe(false);

        // Git metadata is preserved, which is why the wipe becomes a normal
        // commit rather than an obviously broken repo.
        expect(await survived('.git')).toBe(true);
    });

    it('the guard condition is a path comparison, and it holds for the aliased case', () => {
        // `MarkdownGeneratorService` decides via
        //     path.resolve(markdownRepo.dir) === path.resolve(dataRepo.dir)
        // Paths, not repo names: the two names come from different sources (a
        // created-repository target vs the entity's role lookup) and can differ in
        // case or owner spelling while still slugifying to one directory.
        const markdownDir = path.join(dir, '.', '');
        const dataDir = dir;

        expect(path.resolve(markdownDir)).toBe(path.resolve(dataDir));

        // Control: genuinely different repos must NOT trip the guard, or the fix
        // would disable the reset for everyone and leave stale markdown behind.
        expect(path.resolve(path.join(dir, 'other-repo'))).not.toBe(path.resolve(dataDir));
    });
});
