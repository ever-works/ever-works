jest.mock('@src/generators/data-generator/data-generator.service', () => ({
    DataGeneratorService: class DataGeneratorService {},
}));
jest.mock('@src/generators/markdown-generator/markdown-generator.service', () => ({
    MarkdownGeneratorService: class MarkdownGeneratorService {},
}));
jest.mock('@src/generators/website-generator/website-generator.service', () => ({
    WebsiteGeneratorService: class WebsiteGeneratorService {},
}));
jest.mock('@src/generators/website-generator/website-update.service', () => ({
    WebsiteUpdateService: class WebsiteUpdateService {},
}));

import { WorkLifecycleService } from '../work-lifecycle.service';
import { Work } from '@src/entities/work.entity';
import { CreateWorkDto } from '@src/dto/create-work.dto';
import type { User } from '@src/entities/user.entity';

/**
 * EW-028 — a managed-storage Work must register its provisioned repository
 * under the `data` role, not only under `work`.
 *
 * Managed "Ever Works Git" storage is a SINGLE-repo model: `createRepository`
 * provisions ONE repo in the platform org, and `sourceRepository.type` is
 * literally `'data_repo'`. Until this fix `createWork` recorded it only under
 * `relatedRepositories.work`.
 *
 * That looked harmless because `Work.getRelatedRepository` has fallbacks — but
 * they are PER FIELD, not per role:
 *
 *     const owner = related?.owner || this.owner || this.user?.username || '';
 *     const repo  = related?.repo  || this.getDefaultRepositoryName(type);
 *
 * With the `data` role absent, `owner` still resolved correctly off
 * `work.owner`, while `repo` silently fell through to the DERIVED default
 * `${slug}-data`. The result is a half-right coordinate pair pointing at a repo
 * that is never created — which is why it reads as a plain "404 Not Found"
 * rather than as missing configuration.
 *
 * Observed on production 2026-08-13:
 *
 *     Failed to sync .works/works.yml for
 *       ever-works-cloud/ew027-verify-directory-data: HTTP Error: 404 Not Found
 *
 * while `ever-works-cloud/anon-1d565e12-ew027-verify-directory` — the repo that
 * WAS provisioned, 4 seconds earlier — sat beside it, untouched.
 *
 * The collision-suffixed name in these tests is deliberate and load-bearing:
 * `EverWorksGitProvider.buildRepoName` prefixes managed repos (`anon-<hash>-`),
 * so the provisioned name NEVER equals the derived default. A test using a
 * plain `${slug}` repo name would pass against the broken code, because
 * `${slug}-data` would happen to be right.
 */

const baseUser = { id: 'u-1', email: 'u@example.com', username: 'someuser' } as User;

const baseDto = {
    slug: 'my-work',
    name: 'My Work',
    description: 'A description',
    organization: false,
    gitProvider: 'github',
    storageProvider: 'ever-works-git',
} as CreateWorkDto;

const PLATFORM_ORG = 'ever-works-cloud';
/** As `buildRepoName` produces it — prefixed, hence never `${slug}-data`. */
const PROVISIONED_REPO = 'anon-1d565e12-my-work';

function makeService() {
    const workRepo = {
        create: jest.fn(async (data: Record<string, unknown>) => ({
            id: (data.id as string) ?? 'w-1',
            ...data,
            getRepoOwner: () => (data.owner as string) ?? 'evereq',
        })),
        updateGenerateStatus: jest.fn().mockResolvedValue(undefined),
    };
    const userRepo = {
        findById: jest.fn().mockResolvedValue({ id: baseUser.id, onboardingState: null }),
    };
    const dataGenerator = { getItems: jest.fn().mockResolvedValue([]) };
    const templateCatalog = {
        getVisibleTemplateForUser: jest.fn().mockResolvedValue(null),
        getDefaultTemplateIdForUser: jest.fn().mockResolvedValue(null),
    };
    const quota = { assertWithinQuota: jest.fn().mockResolvedValue(undefined) };

    const everWorksGit = {
        isEnabled: jest.fn().mockReturnValue(true),
        createRepository: jest.fn().mockResolvedValue({
            owner: PLATFORM_ORG,
            repo: PROVISIONED_REPO,
            htmlUrl: `https://github.com/${PLATFORM_ORG}/${PROVISIONED_REPO}`,
        }),
    };
    const everWorksDns = {
        getProvider: jest.fn().mockReturnValue(null),
        ensureWorkSubdomain: jest.fn().mockResolvedValue(undefined),
        removeWorkSubdomain: jest.fn().mockResolvedValue(undefined),
        ingressHostFor: jest.fn((slug: string) => `${slug}.ever.works`),
    };

    const service = new WorkLifecycleService(
        workRepo as never,
        userRepo as never,
        dataGenerator as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        templateCatalog as never,
        {} as never,
        quota as never,
        everWorksGit as never,
        everWorksDns as never,
        { emit: jest.fn() } as never,
        { emit: jest.fn(), emitAsync: jest.fn().mockResolvedValue([]) } as never,
        {} as never,
        // gitFacade (self-build slice D, EW-766) — only the Repository Work
        // create path touches it; the managed-storage path under test does not.
        {} as never,
    );

    return { service, workRepo, everWorksGit };
}

/** Rebuild a real entity from what `createWork` actually handed the repository. */
async function persistedWork(): Promise<Work> {
    const { service, workRepo, everWorksGit } = makeService();

    await service.createWork(baseDto, baseUser);

    // Control: if the provider was never called there is no provisioned repo,
    // and every assertion below would be about fallback behaviour instead.
    expect(everWorksGit.createRepository).toHaveBeenCalledTimes(1);
    expect(workRepo.create).toHaveBeenCalledTimes(1);

    return Object.assign(new Work(), workRepo.create.mock.calls[0][0] as Partial<Work>);
}

describe('WorkLifecycleService.createWork — managed storage repository roles', () => {
    it('control: the provisioned name differs from the derived default, so these tests can fail', async () => {
        const work = await persistedWork();

        // The whole defect is the gap between these two strings. If a future
        // change to `buildRepoName` ever closes it, the assertions below go
        // vacuous — and this test says so out loud rather than staying green.
        expect(PROVISIONED_REPO).not.toBe(`${work.slug}-data`);
    });

    it('resolves getDataRepo() to the repo that was actually provisioned', async () => {
        const work = await persistedWork();

        // Pre-fix this returned `my-work-data` — a repo nobody creates.
        expect(work.getDataRepo()).toBe(PROVISIONED_REPO);
        expect(work.getRepoOwner('data')).toBe(PLATFORM_ORG);
    });

    it('keeps the work role pointing at the same single managed repo', async () => {
        const work = await persistedWork();

        expect(work.getMainRepo()).toBe(PROVISIONED_REPO);
        expect(work.getRepoOwner('work')).toBe(PLATFORM_ORG);
    });

    it('records the data role outright, so webhook routing can match the Work', async () => {
        const work = await persistedWork();

        // `WorkRepository.findByDataRepoFullName` has NO fallback:
        //     if (!data?.owner || !data?.repo) return false;
        // so an absent `data` role made every inbound GitHub App push webhook
        // match zero Works — silently, with no error and no log line.
        const data = work.sourceRepository?.relatedRepositories?.data;

        expect(data).toEqual({ owner: PLATFORM_ORG, repo: PROVISIONED_REPO });
        expect(`${data!.owner}/${data!.repo}`).toBe(`${PLATFORM_ORG}/${PROVISIONED_REPO}`);
    });
});
