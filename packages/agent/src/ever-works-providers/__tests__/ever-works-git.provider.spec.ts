import { EverWorksGitProvider } from '../ever-works-git.provider';
import {
    EverWorksGitDisabledError,
    EverWorksGitRequestError,
    type EverWorksProviderWorkRef,
} from '../types';

const WORK: EverWorksProviderWorkRef = {
    id: 'b8a4f8e0-1234-4def-aaaa-bbbbbbbbbbbb',
    slug: 'my-tools',
    userId: 'user-1',
    userSlug: 'evereq',
    description: 'A curated directory',
};

interface FakeRepoResponse {
    name: string;
    owner: { login: string };
    full_name: string;
    html_url: string;
    clone_url: string;
    private: boolean;
}

function mkResponse(status: number, body: unknown): Response {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { 'content-type': 'application/json' } });
}

function mkRepoBody(name: string, owner: string, isPrivate = true): FakeRepoResponse {
    return {
        name,
        owner: { login: owner },
        full_name: `${owner}/${name}`,
        html_url: `https://github.com/${owner}/${name}`,
        clone_url: `https://github.com/${owner}/${name}.git`,
        private: isPrivate,
    };
}

describe('EverWorksGitProvider', () => {
    const ORIGINAL_ENV = { ...process.env };

    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
    });

    describe('buildRepoName', () => {
        it('combines userSlug + workSlug', () => {
            const p = new EverWorksGitProvider();
            expect(p.buildRepoName(WORK)).toBe('evereq-my-tools');
        });

        it('appends a 7-char collision suffix when requested', () => {
            const p = new EverWorksGitProvider();
            const name = p.buildRepoName(WORK, true);
            expect(name).toMatch(/^evereq-my-tools-[0-9a-f]{7}$/);
        });

        it('falls back to userId-prefix when userSlug is missing', () => {
            const p = new EverWorksGitProvider();
            const work = { ...WORK, userSlug: undefined };
            expect(p.buildRepoName(work)).toBe('user-1-my-tools');
        });

        it('slugifies non-alphanumeric characters', () => {
            const p = new EverWorksGitProvider();
            const work = { ...WORK, slug: 'My Tools & Co' };
            expect(p.buildRepoName(work)).toBe('evereq-my-tools-co');
        });
    });

    describe('isEnabled', () => {
        it('returns false when the flag is off', () => {
            process.env.STORAGE_EVER_WORKS_GIT_ENABLED = 'false';
            process.env.EVER_WORKS_CUSTOMERS_GITHUB_PAT = 'ghp_test';
            const p = new EverWorksGitProvider();
            expect(p.isEnabled()).toBe(false);
        });

        it('returns false when the PAT is empty even with the flag on', () => {
            process.env.STORAGE_EVER_WORKS_GIT_ENABLED = 'true';
            process.env.EVER_WORKS_CUSTOMERS_GITHUB_PAT = '';
            const p = new EverWorksGitProvider();
            expect(p.isEnabled()).toBe(false);
        });

        it('returns true when both flag and PAT are set', () => {
            process.env.STORAGE_EVER_WORKS_GIT_ENABLED = 'true';
            process.env.EVER_WORKS_CUSTOMERS_GITHUB_PAT = 'ghp_test';
            const p = new EverWorksGitProvider();
            expect(p.isEnabled()).toBe(true);
        });
    });

    describe('createRepository', () => {
        beforeEach(() => {
            process.env.STORAGE_EVER_WORKS_GIT_ENABLED = 'true';
            process.env.EVER_WORKS_CUSTOMERS_GITHUB_PAT = 'ghp_test';
            process.env.EVER_WORKS_CUSTOMERS_GITHUB_ORG = 'ever-works-cloud';
        });

        it('throws EverWorksGitDisabledError when the flag is off (no orgOverride)', async () => {
            process.env.STORAGE_EVER_WORKS_GIT_ENABLED = 'false';
            const p = new EverWorksGitProvider();
            await expect(
                p.createRepository({ work: WORK, fetchImpl: jest.fn() }),
            ).rejects.toBeInstanceOf(EverWorksGitDisabledError);
        });

        it('POSTs to /orgs/{org}/repos with the right body on the happy path', async () => {
            const fetchImpl = jest
                .fn()
                .mockResolvedValueOnce(
                    mkResponse(201, mkRepoBody('evereq-my-tools', 'ever-works-cloud')),
                );

            const p = new EverWorksGitProvider();
            const repo = await p.createRepository({ work: WORK, fetchImpl });

            expect(fetchImpl).toHaveBeenCalledTimes(1);
            const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
            expect(url).toBe('https://api.github.com/orgs/ever-works-cloud/repos');
            expect(init.method).toBe('POST');
            expect((init.headers as Record<string, string>).authorization).toBe('Bearer ghp_test');
            const body = JSON.parse(init.body as string);
            expect(body).toMatchObject({
                name: 'evereq-my-tools',
                description: 'A curated directory',
                private: true,
                auto_init: true,
            });
            expect(repo).toEqual({
                owner: 'ever-works-cloud',
                repo: 'evereq-my-tools',
                fullName: 'ever-works-cloud/evereq-my-tools',
                htmlUrl: 'https://github.com/ever-works-cloud/evereq-my-tools',
                cloneUrl: 'https://github.com/ever-works-cloud/evereq-my-tools.git',
                privateRepo: true,
            });
        });

        it('retries with a -{shortId} suffix when the name is already taken', async () => {
            const fetchImpl = jest
                .fn()
                .mockResolvedValueOnce(
                    mkResponse(422, {
                        message: 'Validation Failed',
                        errors: [
                            {
                                resource: 'Repository',
                                code: 'custom',
                                field: 'name',
                                message: 'name already exists on this account',
                            },
                        ],
                    }),
                )
                .mockResolvedValueOnce(
                    mkResponse(201, mkRepoBody('evereq-my-tools-b8a4f8e', 'ever-works-cloud')),
                );

            const p = new EverWorksGitProvider();
            const repo = await p.createRepository({ work: WORK, fetchImpl });

            expect(fetchImpl).toHaveBeenCalledTimes(2);
            const firstBody = JSON.parse(
                (fetchImpl.mock.calls[0][1] as RequestInit).body as string,
            );
            const secondBody = JSON.parse(
                (fetchImpl.mock.calls[1][1] as RequestInit).body as string,
            );
            expect(firstBody.name).toBe('evereq-my-tools');
            expect(secondBody.name).toMatch(/^evereq-my-tools-[0-9a-f]{7}$/);
            expect(repo.repo).toBe('evereq-my-tools-b8a4f8e');
        });

        it('throws EverWorksGitRequestError when both attempts collide', async () => {
            const taken = mkResponse(422, {
                message: 'Validation Failed',
                errors: [{ field: 'name', message: 'name already exists on this account' }],
            });
            const fetchImpl = jest
                .fn()
                .mockResolvedValueOnce(taken.clone())
                .mockResolvedValueOnce(taken.clone());

            const p = new EverWorksGitProvider();
            await expect(p.createRepository({ work: WORK, fetchImpl })).rejects.toBeInstanceOf(
                EverWorksGitRequestError,
            );
        });

        it('throws EverWorksGitRequestError on a non-2xx response that is not a name collision', async () => {
            const fetchImpl = jest
                .fn()
                .mockResolvedValueOnce(mkResponse(401, { message: 'Bad credentials' }));

            const p = new EverWorksGitProvider();
            let caught: unknown;
            try {
                await p.createRepository({ work: WORK, fetchImpl });
            } catch (e) {
                caught = e;
            }
            expect(caught).toBeInstanceOf(EverWorksGitRequestError);
            const err = caught as EverWorksGitRequestError;
            expect(err.status).toBe(401);
            expect(err.message).toMatch(/401/);
            expect(err.message).toMatch(/Bad credentials/);
        });

        it('respects orgOverride and visibilityOverride for tests', async () => {
            const fetchImpl = jest
                .fn()
                .mockResolvedValueOnce(
                    mkResponse(201, mkRepoBody('evereq-my-tools', 'custom-org', false)),
                );

            const p = new EverWorksGitProvider();
            const repo = await p.createRepository({
                work: WORK,
                fetchImpl,
                orgOverride: 'custom-org',
                visibilityOverride: 'public',
            });
            const url = fetchImpl.mock.calls[0][0] as string;
            const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
            expect(url).toContain('/orgs/custom-org/repos');
            expect(body.private).toBe(false);
            expect(repo.privateRepo).toBe(false);
        });
    });
});
