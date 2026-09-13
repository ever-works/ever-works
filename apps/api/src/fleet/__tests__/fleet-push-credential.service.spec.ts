import { generateKeyPairSync } from 'node:crypto';
import {
    FLEET_PUSH_CREDENTIAL_MINT_FAILED_REASON,
    FLEET_PUSH_CREDENTIAL_NOT_CONFIGURED_REASON,
    FLEET_PUSH_CREDENTIAL_UNRESOLVED_REASON,
} from '@ever-works/contracts';
import { FleetJobStaleLeaseError } from '@ever-works/agent/fleet';
import {
    FleetPushCredentialError,
    FleetPushCredentialService,
} from '../fleet-push-credential.service';

/**
 * Scoped push credentials — the PLATFORM half (self-build slice AM,
 * EW-810).
 *
 * What a review will look for, and what these cases pin:
 *
 *  - the token is narrowed by REPOSITORY IDS taken from the platform's own
 *    installation snapshot, and by `contents: write` alone;
 *  - a caller cannot influence the scope: the request body carries no
 *    repository, and the repositories are re-read from the job's own
 *    payload (which the planner wrote);
 *  - every refusal is a stable token and a fail-closed answer, never a
 *    partial credential and never a wider one;
 *  - the token appears in no log line.
 */

const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const NODE_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = 'user-1';
const OTHER_USER = 'user-2';
const TOKEN = 'ghs_0123456789abcdefghijklmnopqrstuvwxyz';

const jobRow = (overrides: Record<string, unknown> = {}) => ({
    id: JOB_ID,
    userId: USER_ID,
    payload: {
        taskId: 'task-1',
        agentId: '22222222-2222-4222-8222-222222222222',
        runId: '44444444-4444-4444-8444-444444444444',
        git: { commit: true, push: true, commitMessage: 'feat(task): x' },
        workspace: {
            repositoryId: 'ever-works/ever-works',
            repoUrl: 'https://github.com/ever-works/ever-works.git',
            baseRef: 'develop',
            branch: 'task/x',
        },
    },
    ...overrides,
});

const installationRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'inst-entity-1',
    installationId: '9001',
    createdByUserId: USER_ID,
    deletedAt: null,
    suspendedAt: null,
    ...overrides,
});

const snapshotRow = (
    fullName: string,
    githubRepoId: string,
    installationEntityId = 'inst-entity-1',
) => ({
    id: `snap-${fullName}`,
    installationEntityId,
    githubRepoId,
    fullName,
    owner: fullName.split('/')[0],
    repo: fullName.split('/')[1],
});

function build(
    overrides: {
        job?: Record<string, unknown> | null;
        claim?: unknown;
        installations?: Array<Record<string, unknown>>;
        snapshots?: Record<string, Array<Record<string, unknown>>>;
        agent?: Record<string, unknown> | null;
    } = {},
) {
    const claim =
        overrides.claim === undefined
            ? { jobId: JOB_ID, userId: USER_ID, nodeId: NODE_ID }
            : overrides.claim;
    const jobs = {
        authorizeRunSecretRequest: jest.fn(async () => claim),
    };
    const jobRows = {
        findById: jest.fn(async () => (overrides.job === undefined ? jobRow() : overrides.job)),
    };
    const nodes = { findById: jest.fn(async () => ({ id: NODE_ID, name: 'studio-win' })) };
    const rows = overrides.installations ?? [installationRow()];
    const installations = {
        findById: jest.fn(async (id: string) => rows.find((row) => row.id === id) ?? null),
    };
    const snapshots = overrides.snapshots ?? {
        'ever-works/ever-works': [snapshotRow('ever-works/ever-works', '556677')],
    };
    const installationRepos = {
        // Models the REAL repository, which matches CASE-INSENSITIVELY
        // (`LOWER(fullName) = LOWER(:fullName)`). It used to be an exact key
        // lookup here, which faithfully reproduced the defect the slice AM
        // review found (F6) and therefore could never fail on it: `fullName`
        // is stored verbatim from GitHub's `full_name`, and this resolver
        // asks with a lower-cased name.
        findByFullName: jest.fn(async (fullName: string) => {
            const key = Object.keys(snapshots).find(
                (name) => name.toLowerCase() === fullName.toLowerCase(),
            );
            return key === undefined ? [] : snapshots[key];
        }),
    };
    const agents = {
        findByIdAndUser: jest.fn(async () =>
            overrides.agent === undefined
                ? { id: 'agent-1', name: 'Refactor Bot', slug: 'refactor-bot' }
                : overrides.agent,
        ),
    };
    const service = new FleetPushCredentialService(
        jobs as never,
        jobRows as never,
        nodes as never,
        installations as never,
        installationRepos as never,
        agents as never,
    );
    return { service, jobs, jobRows, nodes, installations, installationRepos, agents };
}

const githubOk = (body: unknown) =>
    ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => body,
    }) as unknown as Response;

describe('FleetPushCredentialService', () => {
    let fetchSpy: jest.SpyInstance | undefined;
    const previousEnv = { id: process.env.GITHUB_APP_ID, key: process.env.GITHUB_APP_PRIVATE_KEY };

    beforeEach(() => {
        process.env.GITHUB_APP_ID = '12345';
        process.env.GITHUB_APP_PRIVATE_KEY = privateKey;
    });

    afterEach(() => {
        fetchSpy?.mockRestore();
        fetchSpy = undefined;
        if (previousEnv.id === undefined) delete process.env.GITHUB_APP_ID;
        else process.env.GITHUB_APP_ID = previousEnv.id;
        if (previousEnv.key === undefined) delete process.env.GITHUB_APP_PRIVATE_KEY;
        else process.env.GITHUB_APP_PRIVATE_KEY = previousEnv.key;
    });

    describe('the scope is narrowed from platform state', () => {
        it('mints with repository_ids from the installation SNAPSHOT and contents:write only', async () => {
            fetchSpy = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValue(githubOk({ token: TOKEN, expires_at: '2026-09-06T21:00:00Z' }));
            const { service } = build();

            const answer = await service.mint({
                nodeId: NODE_ID,
                secret: 'a'.repeat(32),
                jobId: JOB_ID,
                leaseGeneration: 4,
            });

            const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
            expect(url).toBe('https://api.github.com/app/installations/9001/access_tokens');
            // The narrowing that makes this a SCOPE. Before this slice every
            // installation token this platform minted was good for every
            // repository in the installation with every permission the App
            // holds — fine for the read-shaped callers, exactly wrong for a
            // write credential handed to an unattended machine.
            expect(JSON.parse(String(init.body))).toEqual({
                repository_ids: [556677],
                permissions: { contents: 'write' },
            });
            expect(answer?.push).toMatchObject({
                token: TOKEN,
                username: 'x-access-token',
                repositories: ['ever-works/ever-works'],
            });
        });

        it('covers every WRITABLE repository the job touches and no read-only mount', async () => {
            fetchSpy = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValue(githubOk({ token: TOKEN }));
            const { service } = build({
                job: jobRow({
                    payload: {
                        ...(jobRow().payload as Record<string, unknown>),
                        workspace: {
                            repositoryId: 'ever-works/ever-works',
                            mounts: [
                                {
                                    repositoryId: 'ever-works/template',
                                    writable: true,
                                    mountDir: 't',
                                },
                                {
                                    repositoryId: 'ever-works/reference',
                                    writable: false,
                                    mountDir: 'r',
                                },
                            ],
                        },
                    },
                }),
                snapshots: {
                    'ever-works/ever-works': [snapshotRow('ever-works/ever-works', '556677')],
                    'ever-works/template': [snapshotRow('ever-works/template', '778899')],
                    'ever-works/reference': [snapshotRow('ever-works/reference', '990011')],
                },
            });

            const answer = await service.mint({
                nodeId: NODE_ID,
                secret: 'a'.repeat(32),
                jobId: JOB_ID,
            });

            expect(answer?.push?.repositories).toEqual([
                'ever-works/ever-works',
                'ever-works/template',
            ]);
            // A credential that could write a read-only reference checkout
            // would be wider than the run it was minted for.
            expect(
                JSON.parse(String((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body)),
            ).toMatchObject({ repository_ids: [556677, 778899] });
        });

        // REGRESSION — a repository whose GitHub name carries any upper-case
        // character resolved to nothing (slice AM review, F6).
        //
        // `fullName` is stored verbatim from GitHub's `full_name`, and this
        // resolver normalizes to lower case before asking, so the old exact
        // (case-sensitive on Postgres) lookup returned zero rows,
        // `byInstallation` stayed empty and the answer was
        // `push-scope-unresolved`. The planner then refused the Task at plan
        // time, indistinguishably from a repository no installation covers —
        // silently removing fleet execution for an entire class of
        // repositories the installation did cover.
        it('resolves a repository whose GitHub name is MIXED CASE', async () => {
            fetchSpy = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValue(githubOk({ token: TOKEN }));
            const { service, installationRepos } = build({
                job: jobRow({
                    payload: {
                        ...(jobRow().payload as Record<string, unknown>),
                        workspace: { repositoryId: 'Ever-Works/Directory-Web-Template' },
                    },
                }),
                // Stored exactly as GitHub reports it.
                snapshots: {
                    'Ever-Works/Directory-Web-Template': [
                        snapshotRow('Ever-Works/Directory-Web-Template', '445566'),
                    ],
                },
            });

            const answer = await service.mint({
                nodeId: NODE_ID,
                secret: 'a'.repeat(32),
                jobId: JOB_ID,
            });

            // The numeric id still comes from the snapshot row, and the name
            // the node compares its remote against is the normalized one.
            expect(
                JSON.parse(String((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body)),
            ).toMatchObject({ repository_ids: [445566] });
            expect(answer?.push?.repositories).toEqual(['ever-works/directory-web-template']);
            // Asked with the normalized name — the repository is what has to
            // be case-insensitive, not this resolver.
            expect(installationRepos.findByFullName).toHaveBeenCalledWith(
                'ever-works/directory-web-template',
            );
        });
    });

    describe('refusals — every one fails closed with a stable token', () => {
        const refusalCases: Array<[string, Parameters<typeof build>[0], string]> = [
            [
                'no installation snapshot names the repository',
                { snapshots: {} },
                FLEET_PUSH_CREDENTIAL_UNRESOLVED_REASON,
            ],
            [
                'the installation belongs to someone else',
                { installations: [installationRow({ createdByUserId: OTHER_USER })] },
                FLEET_PUSH_CREDENTIAL_UNRESOLVED_REASON,
            ],
            [
                'the installation was suspended',
                { installations: [installationRow({ suspendedAt: new Date() })] },
                FLEET_PUSH_CREDENTIAL_UNRESOLVED_REASON,
            ],
            [
                'the installation was deleted',
                { installations: [installationRow({ deletedAt: new Date() })] },
                FLEET_PUSH_CREDENTIAL_UNRESOLVED_REASON,
            ],
            [
                'the job names no repository at all',
                { job: jobRow({ payload: { git: { push: true } } }) },
                FLEET_PUSH_CREDENTIAL_UNRESOLVED_REASON,
            ],
        ];

        it.each(refusalCases)('refuses when %s', async (_name, overrides, reason) => {
            fetchSpy = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValue(githubOk({ token: TOKEN }));
            const { service } = build(overrides);

            await expect(
                service.mint({ nodeId: NODE_ID, secret: 'a'.repeat(32), jobId: JOB_ID }),
            ).rejects.toMatchObject({ reason });
            // Nothing was minted: the refusal happens before GitHub is asked.
            expect(fetchSpy).not.toHaveBeenCalled();
        });

        it('refuses when the repositories span TWO installations rather than picking one', async () => {
            // Picking by listing order would decide which installation's
            // audit trail records the write by luck.
            fetchSpy = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValue(githubOk({ token: TOKEN }));
            const { service } = build({
                job: jobRow({
                    payload: {
                        ...(jobRow().payload as Record<string, unknown>),
                        workspace: {
                            repositoryId: 'ever-works/ever-works',
                            mounts: [
                                {
                                    repositoryId: 'ever-works/template',
                                    writable: true,
                                    mountDir: 't',
                                },
                            ],
                        },
                    },
                }),
                installations: [
                    installationRow(),
                    installationRow({ id: 'inst-entity-2', installationId: '9002' }),
                ],
                snapshots: {
                    'ever-works/ever-works': [
                        snapshotRow('ever-works/ever-works', '556677', 'inst-entity-1'),
                    ],
                    'ever-works/template': [
                        snapshotRow('ever-works/template', '778899', 'inst-entity-2'),
                    ],
                },
            });

            await expect(
                service.mint({ nodeId: NODE_ID, secret: 'a'.repeat(32), jobId: JOB_ID }),
            ).rejects.toMatchObject({ reason: FLEET_PUSH_CREDENTIAL_UNRESOLVED_REASON });
            expect(fetchSpy).not.toHaveBeenCalled();
        });

        it('refuses when the deployment has no GitHub App configured', async () => {
            delete process.env.GITHUB_APP_ID;
            const { service } = build();

            await expect(
                service.mint({ nodeId: NODE_ID, secret: 'a'.repeat(32), jobId: JOB_ID }),
            ).rejects.toMatchObject({ reason: FLEET_PUSH_CREDENTIAL_NOT_CONFIGURED_REASON });
        });

        it('turns a GitHub refusal into a stable token and never echoes its body', async () => {
            fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
                ok: false,
                status: 403,
                statusText: 'installation suspended: app 12345 for org ever-works',
                json: async () => ({}),
            } as unknown as Response);
            const { service } = build();

            const error = await service
                .mint({ nodeId: NODE_ID, secret: 'a'.repeat(32), jobId: JOB_ID })
                .catch((e: unknown) => e);

            expect(error).toBeInstanceOf(FleetPushCredentialError);
            expect((error as FleetPushCredentialError).reason).toBe(
                FLEET_PUSH_CREDENTIAL_MINT_FAILED_REASON,
            );
            expect((error as Error).message).not.toContain('org ever-works');
        });

        it('answers null — one undifferentiated 401 — when the claim proof fails', async () => {
            const { service, jobRows } = build({ claim: null });

            await expect(
                service.mint({ nodeId: NODE_ID, secret: 'a'.repeat(32), jobId: JOB_ID }),
            ).resolves.toBeNull();
            // Nothing is read about the job at all: an unauthenticated
            // caller must not be able to probe which jobs exist.
            expect(jobRows.findById).not.toHaveBeenCalled();
        });

        it('lets a stale lease propagate as its own error, exactly as env-files does', async () => {
            const jobs = {
                authorizeRunSecretRequest: jest.fn(async () => {
                    throw new FleetJobStaleLeaseError();
                }),
            };
            const service = new FleetPushCredentialService(
                jobs as never,
                { findById: jest.fn() } as never,
                { findById: jest.fn() } as never,
                { findById: jest.fn() } as never,
                { findByFullName: jest.fn() } as never,
            );

            await expect(
                service.mint({ nodeId: NODE_ID, secret: 'a'.repeat(32), jobId: JOB_ID }),
            ).rejects.toBeInstanceOf(FleetJobStaleLeaseError);
        });
    });

    describe('the platform re-reads its own plan', () => {
        it('mints NO credential for a job whose plan commits but does not push', async () => {
            fetchSpy = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValue(githubOk({ token: TOKEN }));
            const { service } = build({
                job: jobRow({
                    payload: {
                        ...(jobRow().payload as Record<string, unknown>),
                        git: { commit: true, push: false },
                    },
                }),
            });

            const answer = await service.mint({
                nodeId: NODE_ID,
                secret: 'a'.repeat(32),
                jobId: JOB_ID,
            });

            expect(answer?.push).toBeNull();
            // A write credential that never existed cannot leak.
            expect(fetchSpy).not.toHaveBeenCalled();
            // Attribution is still issued: a commit-only run still needs to
            // say which machine and which agent made it.
            expect(answer?.attribution.nodeId).toBe(NODE_ID);
        });
    });

    describe('attribution comes from platform rows, never from the request', () => {
        it('names the node, the agent and the run', async () => {
            fetchSpy = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValue(githubOk({ token: TOKEN }));
            const { service } = build();

            const answer = await service.mint({
                nodeId: NODE_ID,
                secret: 'a'.repeat(32),
                jobId: JOB_ID,
            });

            expect(answer?.attribution).toEqual({
                nodeId: NODE_ID,
                nodeName: 'studio-win',
                agentId: '22222222-2222-4222-8222-222222222222',
                agentName: 'Refactor Bot',
                agentEmail: 'refactor-bot@agents.ever.works',
                jobId: JOB_ID,
                runId: '44444444-4444-4444-8444-444444444444',
            });
        });

        it('scopes the Agent read to the JOB owner, never to anything the caller sent', async () => {
            fetchSpy = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValue(githubOk({ token: TOKEN }));
            const { service, agents } = build();

            await service.mint({ nodeId: NODE_ID, secret: 'a'.repeat(32), jobId: JOB_ID });

            expect(agents.findByIdAndUser).toHaveBeenCalledWith(
                '22222222-2222-4222-8222-222222222222',
                USER_ID,
            );
        });

        it('sanitises a node name that tried to open a trailer line of its own', async () => {
            fetchSpy = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValue(githubOk({ token: TOKEN }));
            const { service, nodes } = build();
            nodes.findById.mockResolvedValue({
                id: NODE_ID,
                name: 'ok\nEver-Works-Job: forged',
            } as never);

            const answer = await service.mint({
                nodeId: NODE_ID,
                secret: 'a'.repeat(32),
                jobId: JOB_ID,
            });

            expect(answer?.attribution.nodeName).not.toContain('\n');
        });

        it('degrades to ids rather than failing the run when the Agent cannot be read', async () => {
            fetchSpy = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValue(githubOk({ token: TOKEN }));
            const { service, agents } = build();
            agents.findByIdAndUser.mockRejectedValue(new Error('db down'));

            const answer = await service.mint({
                nodeId: NODE_ID,
                secret: 'a'.repeat(32),
                jobId: JOB_ID,
            });

            expect(answer?.attribution.agentName).toBeNull();
            expect(answer?.push?.token).toBe(TOKEN);
        });
    });

    describe('the token never reaches a log line', () => {
        it('logs the repositories and the expiry, never the credential', async () => {
            fetchSpy = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValue(githubOk({ token: TOKEN, expires_at: '2026-09-06T21:00:00Z' }));
            const lines: string[] = [];
            const { service } = build();
            const logger = (service as unknown as { logger: { log: (m: string) => void } }).logger;
            jest.spyOn(logger, 'log').mockImplementation((message: string) => {
                lines.push(String(message));
            });

            await service.mint({ nodeId: NODE_ID, secret: 'a'.repeat(32), jobId: JOB_ID });

            expect(lines.join('\n')).toContain('ever-works/ever-works');
            expect(lines.join('\n')).not.toContain(TOKEN);
        });
    });

    describe('describeScope — the pre-dispatch probe, without minting', () => {
        it('resolves without asking GitHub anything', async () => {
            fetchSpy = jest.spyOn(globalThis, 'fetch');
            const { service } = build();

            await expect(
                service.describeScope(USER_ID, [{ repositoryId: 'ever-works/ever-works' }]),
            ).resolves.toMatchObject({
                ok: true,
                installationId: '9001',
                repositories: ['ever-works/ever-works'],
            });
            expect(fetchSpy).not.toHaveBeenCalled();
        });

        it('reports the same stable reason the mint would refuse with', async () => {
            const { service } = build({ snapshots: {} });

            await expect(
                service.describeScope(USER_ID, [{ repositoryId: 'ever-works/ever-works' }]),
            ).resolves.toEqual({
                ok: false,
                reason: FLEET_PUSH_CREDENTIAL_UNRESOLVED_REASON,
            });
        });

        it('reports the not-configured reason before it looks at any row', async () => {
            delete process.env.GITHUB_APP_PRIVATE_KEY;
            const { service, installationRepos } = build();

            await expect(
                service.describeScope(USER_ID, [{ repositoryId: 'ever-works/ever-works' }]),
            ).resolves.toEqual({
                ok: false,
                reason: FLEET_PUSH_CREDENTIAL_NOT_CONFIGURED_REASON,
            });
            expect(installationRepos.findByFullName).not.toHaveBeenCalled();
        });

        // REGRESSION — `owner/repo` is not an identity (slice AM review, F4).
        //
        // A `git` repo connection's url is a bare `@IsString()` with no host
        // constraint, and `repositoryIdFromCloneUrl` is host-agnostic, so a
        // mount at `https://gitlab.com/ever-works/ever-works` used to yield
        // `ever-works/ever-works`, match the GITHUB installation row of that
        // name, and buy a `contents: write` token for
        // `github.com/ever-works/ever-works` — a repository the run never
        // touches. No attacker required.
        it.each([
            ['a different forge', 'https://gitlab.com/ever-works/ever-works.git'],
            ['a suffix lookalike', 'https://github.com.evil.tld/ever-works/ever-works'],
            ['a non-default port', 'https://github.com:8443/ever-works/ever-works'],
            ['an ssh remote', 'git@github.com:ever-works/ever-works.git'],
            ['a name that disagrees with its own url', 'https://github.com/someone-else/other.git'],
        ])('refuses a push target whose clone URL is %s', async (_label, repoUrl) => {
            const { service } = build();

            await expect(
                service.describeScope(USER_ID, [
                    { repositoryId: 'ever-works/ever-works', repoUrl },
                ]),
            ).resolves.toEqual({
                ok: false,
                reason: FLEET_PUSH_CREDENTIAL_UNRESOLVED_REASON,
            });
        });

        it('accepts the real clone URL and scopes by what the URL says', async () => {
            const { service } = build();

            await expect(
                service.describeScope(USER_ID, [
                    {
                        repositoryId: 'ever-works/ever-works',
                        repoUrl: 'https://github.com/Ever-Works/ever-works.git',
                    },
                ]),
            ).resolves.toMatchObject({ ok: true, repositories: ['ever-works/ever-works'] });
        });

        it('refuses at MINT time too, on the job payload the planner wrote', async () => {
            // The plan-time probe is @Optional() and only moves the failure
            // earlier; this is the gate that actually decides whether a token
            // is issued.
            fetchSpy = jest.spyOn(globalThis, 'fetch');
            const { service } = build({
                job: jobRow({
                    payload: {
                        ...(jobRow().payload as Record<string, unknown>),
                        workspace: {
                            repositoryId: 'ever-works/ever-works',
                            repoUrl: 'https://gitlab.com/ever-works/ever-works.git',
                        },
                    },
                }),
            });

            await expect(
                service.mint({ nodeId: NODE_ID, secret: 'a'.repeat(32), jobId: JOB_ID }),
            ).rejects.toMatchObject({ reason: FLEET_PUSH_CREDENTIAL_UNRESOLVED_REASON });
            // Nothing was minted, so no write credential for a GitHub
            // repository this run has nothing to do with ever existed.
            expect(fetchSpy).not.toHaveBeenCalled();
        });
    });
});
