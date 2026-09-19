import { ValidationPipe } from '@nestjs/common';

// `github-slugger@2` is ESM-only and ts-jest loads CommonJS, so the real
// `MarkdownGeneratorService` — which this harness deliberately keeps REAL, because it
// is one of the three things that issue the provider removal — cannot be imported
// through it. Only the slugger is substituted; every line of the delete path stays
// the shipping one.
jest.mock('github-slugger', () => ({
    __esModule: true,
    default: class GithubSlugger {
        slug(value: string): string {
            return String(value)
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-');
        }
    },
}));

import { Work } from '@src/entities/work.entity';
import type { User } from '@src/entities/user.entity';
import { DeleteWorkDto } from '@src/items-generator/dto';
import { DataGeneratorService } from '@src/generators/data-generator/data-generator.service';
import { MarkdownGeneratorService } from '@src/generators/markdown-generator/markdown-generator.service';
import { WebsiteGeneratorService } from '@src/generators/website-generator/website-generator.service';
import type {
    AppWorkDeletionOutcome,
    AppWorkDeletionPort,
    AppWorkDeletionRequest,
} from '@src/app-works/app-work-deletion.port';
import { WorkLifecycleService } from '../work-lifecycle.service';

/**
 * APW-01 T39 — deleting an App Work (Resolution R-15, FR-37 … FR-40b).
 *
 * ## Why this file is the measurement, not a restatement
 *
 * Register item **C23** left one sentence unverified: "the fork itself is untouched
 * (asserted)". `app-work-create.service.ts:1181-1183` writes
 * `relatedRepositories: { website: { owner, repo } }` and nothing else, so for an App
 * Work the `website` role resolves to **the Work Repository itself** — the fork, or
 * for `mode: 'link'` the repository the member registered, which the platform never
 * created. The `data` role has no recorded coordinates at all, so the entity falls
 * back to the DERIVED name `<slug>-data` (`work.entity.ts:867-885`). Both roles are
 * reachable from `deleteWork`'s repository steps, so "the fork is untouched" had to be
 * measured rather than read.
 *
 * Everything below therefore runs the **real** `WorkLifecycleService` with the
 * **real** `DataGeneratorService`, `MarkdownGeneratorService` and
 * `WebsiteGeneratorService`, over a **real `Work` entity instance built the way
 * `AppWorkCreateService.buildWorkData` builds one** (`:1160-1218`), and records every
 * `GitFacadeService.deleteRepository(owner, repo)` the frozen provider boundary
 * receives. The only fakes are that facade (the provider boundary — the thing being
 * measured), the repositories, DNS and ownership lookups. `cleanup()` is stubbed
 * because it is a local-checkout concern that touches no provider.
 *
 * ## What the legacy fields mean for this kind
 *
 * `delete_data_repository` is the App Work's app-code switch — plan §3.3 `:445`
 * ("`delete_data_repository` keeps its meaning (the fork or private copy, FR-38)")
 * and plan §5.2 `:748` (the fork/copy checkbox "send[s] `delete_data_repository: true`
 * only when both are satisfied"). `delete_website_repository` is the legacy "website
 * repository" checkbox, which for an App Work resolves to the same repository.
 * `delete_markdown_repository` names the `work` role, which the kind does not
 * provision at all (`WORK_KIND_CAPABILITIES.app.repos = { data: false, work: false,
 * website: true }`, `work-capabilities.ts:251`).
 *
 * ## The two DTO shapes the delete path actually sees
 *
 * A caller reaches `deleteWork` with either a **transport DTO** — this app's global
 * `ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true })`
 * (`apps/api/src/main.ts:200-204`) instantiating `DeleteWorkDto`, so its class
 * property initialisers (`= false`) are present for every field the body omits — or
 * a **plain object**, which is what `apps/internal-cli`'s direct callers pass
 * (`delete.subcommand.ts:131`, whose prompt defaults all three flags to `true`) and
 * what a positional unit construction passes. The two do NOT agree on an omitted flag,
 * and the delete path's `!== false` tests are sensitive to exactly that difference, so
 * every cell of the matrix below is measured BOTH ways.
 */

const user = { id: 'owner-1', username: 'apw-e2e-user' } as User;

/** The global pipe of `apps/api/src/main.ts:200-204`, verbatim. */
const GLOBAL_PIPE = new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
});

interface DeleteCall {
    owner: string;
    repo: string;
}

type PortBehaviour = 'unbound' | 'done' | 'pending' | 'throw';

interface Stack {
    service: WorkLifecycleService;
    calls: DeleteCall[];
    /** Provider removals and App-runtime calls in the order they happened. */
    events: string[];
    portRequests: AppWorkDeletionRequest[];
    workRepository: { delete: jest.Mock; update: jest.Mock; findById: jest.Mock };
    cleanups: Array<jest.SpyInstance>;
}

/** An App Work entity built exactly as `buildWorkData` builds it. */
function appWork(
    mode: 'fork' | 'link' | 'private-copy' | 'adopted-fork',
    overrides: Record<string, unknown> = {},
): Work {
    const createdByThisWork = mode === 'fork' || mode === 'private-copy';
    const workRepositoryOwner = 'apw-e2e-user';
    const workRepositoryRepo = 'cal-diy';

    return Object.assign(new Work(), {
        id: 'w-app',
        kind: 'app',
        name: workRepositoryRepo,
        slug: workRepositoryRepo,
        owner: workRepositoryOwner,
        userId: user.id,
        gitProvider: 'github',
        deployProvider: null,
        user,
        // `buildWorkData` — `sourceRepository.relatedRepositories` carries the
        // `website` role ONLY: the Work Repository, i.e. the fork / copy / linked
        // repository. No `data` coordinates are ever recorded for the kind.
        sourceRepository: {
            url: `https://github.com/${workRepositoryOwner}/${workRepositoryRepo}`,
            owner: workRepositoryOwner,
            repo: workRepositoryRepo,
            type:
                mode === 'link'
                    ? 'app_link'
                    : mode === 'private-copy'
                      ? 'app_private_copy'
                      : 'app_fork',
            importedAt: new Date(),
            relatedRepositories: {
                website: { owner: workRepositoryOwner, repo: workRepositoryRepo },
            },
            ...(mode === 'link'
                ? {}
                : {
                      upstream: {
                          owner: 'apw-e2e-upstream',
                          repo: 'cal-diy',
                          defaultBranch: 'main',
                      },
                  }),
            createdByThisWork,
        },
        ...overrides,
    });
}

/** A non-app control Work, with every role provisioned and a plain derived shape. */
function controlWork(kind: string): Work {
    return Object.assign(new Work(), {
        id: 'w-control',
        kind,
        name: 'Best Tools',
        slug: 'best-tools',
        owner: 'acme',
        userId: user.id,
        gitProvider: 'github',
        deployProvider: null,
        user: { id: user.id, username: 'acme' } as User,
        sourceRepository: undefined,
    });
}

function makeStack(work: Work, port: PortBehaviour = 'unbound'): Stack {
    const calls: DeleteCall[] = [];
    const events: string[] = [];
    const portRequests: AppWorkDeletionRequest[] = [];

    // The provider boundary. Every repository removal the platform issues lands
    // here, with the exact `(owner, repo)` the real generators derived.
    const gitFacade = {
        deleteRepository: jest.fn(async (owner: string, repo: string) => {
            calls.push({ owner, repo });
            events.push(`remove ${owner}/${repo}`);
        }),
        getLocalDir: (provider: string, owner: string, repo: string) =>
            `${process.cwd()}/.tmp-spec-checkouts/${provider}/${owner}__${repo}`,
        removeLocalDir: jest.fn().mockResolvedValue(undefined),
    };

    const dataGenerator = new DataGeneratorService(
        gitFacade as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
    );
    const markdownGenerator = new MarkdownGeneratorService(gitFacade as never, {} as never);
    const websiteGenerator = new WebsiteGeneratorService(
        gitFacade as never,
        {} as never,
        {} as never,
    );
    const cleanups = [dataGenerator, markdownGenerator, websiteGenerator].map((generator) =>
        jest.spyOn(generator, 'cleanup').mockResolvedValue(undefined as never),
    );

    let rowDeleted = false;
    const workRepository = {
        delete: jest.fn(async () => {
            rowDeleted = true;
            events.push('row delete');
            return true;
        }),
        update: jest.fn().mockResolvedValue(undefined),
        findById: jest.fn(async () => (rowDeleted ? null : work)),
    };
    const ownership = { ensureIsOwner: jest.fn().mockResolvedValue({ work }) };

    let deletionPort: AppWorkDeletionPort | undefined;
    if (port !== 'unbound') {
        deletionPort = {
            requestDeletion: jest.fn(async (input: AppWorkDeletionRequest) => {
                portRequests.push(input);
                events.push('port requestDeletion');
                if (port === 'throw') {
                    throw Object.assign(new Error('runtime unavailable'), { code: 'no_runtime' });
                }
                return {
                    status: port === 'pending' ? 'pending' : 'done',
                    target: 'your-cluster',
                    ...(port === 'pending' ? { reason: 'workloads_pending' } : {}),
                } as AppWorkDeletionOutcome;
            }),
        };
    }

    const service = new WorkLifecycleService(
        workRepository as never,
        {} as never,
        dataGenerator,
        markdownGenerator,
        websiteGenerator,
        {} as never,
        ownership as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        { removeWorkSubdomain: jest.fn().mockResolvedValue(undefined) } as never,
        {} as never,
        { emit: jest.fn(), emitAsync: jest.fn() } as never,
        {} as never,
        gitFacade as never,
        // 18th slot: `activityLog`, then `appWorkCreate`, then the App deletion port
        // that T39 appends LAST.
        undefined,
        undefined,
        deletionPort,
    );

    return { service, calls, events, portRequests, workRepository, cleanups };
}

/** A call log as `owner/repo`, in order — the table's cell. */
function callNames(calls: DeleteCall[]): string[] {
    return calls.map((call) => `${call.owner}/${call.repo}`);
}

/** The transport DTO the API route's global pipe produces from a JSON body. */
async function viaGlobalPipe(body: Record<string, unknown>): Promise<DeleteWorkDto> {
    return (await GLOBAL_PIPE.transform(body, {
        type: 'body',
        metatype: DeleteWorkDto,
    })) as DeleteWorkDto;
}

interface Cell {
    kind: string;
    source: string;
    dto: string;
    shape: 'plain' | 'pipe';
    calls: string[];
    rowDeleted: boolean;
    outcome: string;
}

/**
 * One measured delete.
 *
 * `shape: 'plain'` passes the body straight through, exactly as
 * `apps/internal-cli`'s direct callers do; `shape: 'pipe'` runs it through the API's
 * global `ValidationPipe` first, exactly as `POST /api/works/:id/delete` does.
 */
async function measure(
    work: Work,
    body: Record<string, unknown>,
    shape: 'plain' | 'pipe',
): Promise<Cell> {
    const stack = makeStack(work);
    const dto = shape === 'pipe' ? await viaGlobalPipe(body) : (body as unknown as DeleteWorkDto);

    let outcome: string;
    try {
        const result = await stack.service.deleteWork(work.id, dto, user);
        outcome = `200 ${JSON.stringify(result)}`;
    } catch (error) {
        const http = error as { status?: number; response?: unknown };
        outcome = `${http.status ?? 'throw'} ${JSON.stringify(http.response ?? String(error))}`;
    }

    return {
        kind: work.kind ?? '',
        source: String(
            (work.sourceRepository as { type?: string } | undefined)?.type ?? work.kind ?? '',
        ),
        dto: JSON.stringify(body),
        shape,
        calls: callNames(stack.calls),
        rowDeleted: stack.workRepository.delete.mock.calls.length > 0,
        outcome,
    };
}

function printTable(cells: Cell[]): void {
    const lines = [
        '| kind | source | dto | shape | removeRepository → deleteRepository(owner, repo) | row deleted | outcome |',
        '| --- | --- | --- | --- | --- | --- | --- |',
        ...cells.map(
            (cell) =>
                `| ${cell.kind} | ${cell.source} | ${cell.dto} | ${cell.shape} | ` +
                `${cell.calls.length === 0 ? '(none)' : cell.calls.join(' → ')} | ` +
                `${cell.rowDeleted ? 'yes' : 'no'} | ${cell.outcome} |`,
        ),
    ];
    // eslint-disable-next-line no-console
    console.log(`\n${lines.join('\n')}\n`);
}

const APP_DTOS: Array<[string, Record<string, unknown>]> = [
    ['{}', {}],
    ['{delete_data_repository: false}', { delete_data_repository: false }],
    ['{delete_data_repository: true}', { delete_data_repository: true }],
    ['{delete_markdown_repository: false}', { delete_markdown_repository: false }],
    ['{delete_website_repository: false}', { delete_website_repository: false }],
    ['{delete_website_repository: true}', { delete_website_repository: true }],
    [
        '{} the CLI prompt defaults',
        {
            delete_data_repository: true,
            delete_markdown_repository: true,
            delete_website_repository: true,
        },
    ],
];

describe('deleteWork — measured matrix (the C23 question, the failure table)', () => {
    const cells: Cell[] = [];

    afterAll(() => {
        printTable(cells);
    });

    it.each(APP_DTOS)('app/fork + app/link + controls: %s', async (_label, body) => {
        for (const shape of ['plain', 'pipe'] as const) {
            cells.push(await measure(appWork('fork'), body, shape));
            cells.push(await measure(appWork('link'), body, shape));
            cells.push(await measure(appWork('adopted-fork'), body, shape));
        }
    });

    it('the control kinds', async () => {
        for (const shape of ['plain', 'pipe'] as const) {
            for (const [label, body] of APP_DTOS.slice(0, 3)) {
                expect(label).toBeTruthy();
                cells.push(await measure(controlWork('website'), body, shape));
                cells.push(await measure(controlWork('directory'), body, shape));
                cells.push(await measure(controlWork('repo'), body, shape));
            }
        }
    });
});

describe('deleteWork — an App Work keeps the fork and never reaches a derived name', () => {
    it('never asks the provider to remove the DERIVED "<slug>-data" name, in any cell', async () => {
        for (const [label, body] of APP_DTOS) {
            for (const mode of ['fork', 'link', 'adopted-fork'] as const) {
                const stack = makeStack(appWork(mode));
                const dto = await viaGlobalPipe(body);

                await stack.service.deleteWork('w-app', dto, user).catch(() => undefined);

                // The label rides inside the asserted value, so a failure quotes both
                // the cell that produced it and the call that was issued.
                expect({
                    cell: `${mode} ${label}`,
                    calls: callNames(stack.calls).filter((name) => name.endsWith('-data')),
                }).toEqual({ cell: `${mode} ${label}`, calls: [] });
            }
        }
    });

    it('keeps the fork when nothing asked for it — including the plain DTO the CLI passes', async () => {
        const keepCells: Array<[string, Record<string, unknown>]> = [
            ['{} (transport)', {}],
            ['{} (plain)', {}],
            ['{delete_data_repository: false}', { delete_data_repository: false }],
            ['{delete_website_repository: false}', { delete_website_repository: false }],
            ['{delete_markdown_repository: false}', { delete_markdown_repository: false }],
            [
                '{delete_stored_data: true, confirm_slug: slug}',
                {
                    delete_stored_data: true,
                    confirm_slug: 'cal-diy',
                },
            ],
        ];

        for (const [label, body] of keepCells) {
            for (const shape of ['plain', 'pipe'] as const) {
                const stack = makeStack(appWork('fork'));
                const dto = shape === 'pipe' ? await viaGlobalPipe(body) : (body as DeleteWorkDto);

                await stack.service.deleteWork('w-app', dto, user).catch(() => undefined);

                expect({ cell: `${label} (${shape})`, calls: callNames(stack.calls) }).toEqual({
                    cell: `${label} (${shape})`,
                    calls: [],
                });
            }
        }
    });

    it('removes the fork only on an explicit request, and then only the fork', async () => {
        for (const body of [
            { delete_data_repository: true },
            { delete_website_repository: true },
            { delete_data_repository: true, delete_markdown_repository: true },
            // The internal CLI's own prompt defaults, verbatim.
            {
                delete_data_repository: true,
                delete_markdown_repository: true,
                delete_website_repository: true,
            },
        ]) {
            const stack = makeStack(appWork('fork'));
            const dto = await viaGlobalPipe(body);

            const result = await stack.service.deleteWork('w-app', dto, user);

            expect({ body, calls: callNames(stack.calls) }).toEqual({
                body,
                calls: ['apw-e2e-user/cal-diy'],
            });
            expect(result.deleted_repositories).toEqual(['apw-e2e-user/cal-diy']);
        }
    });

    it('a LINK is never deleted: both repository flags are refused 400 and nothing is removed', async () => {
        for (const body of [
            { delete_data_repository: true },
            { delete_website_repository: true },
            { delete_data_repository: true, delete_website_repository: true },
        ]) {
            for (const shape of ['plain', 'pipe'] as const) {
                const stack = makeStack(appWork('link'));
                const dto = shape === 'pipe' ? await viaGlobalPipe(body) : (body as DeleteWorkDto);

                await expect(stack.service.deleteWork('w-app', dto, user)).rejects.toMatchObject({
                    status: 400,
                    response: expect.objectContaining({
                        code: 'linked_repository_not_deletable',
                    }),
                });
                expect({ body, shape, calls: callNames(stack.calls) }).toEqual({
                    body,
                    shape,
                    calls: [],
                });
                expect(stack.workRepository.delete).not.toHaveBeenCalled();
            }
        }
    });

    it('an ADOPTED fork (createdByThisWork false) is refused for the same reason', async () => {
        const stack = makeStack(appWork('adopted-fork'));

        await expect(
            stack.service.deleteWork(
                'w-app',
                await viaGlobalPipe({ delete_data_repository: true }),
                user,
            ),
        ).rejects.toMatchObject({
            status: 400,
            response: expect.objectContaining({
                code: 'app_repository_not_created_by_this_work',
            }),
        });
        expect(callNames(stack.calls)).toEqual([]);
        expect(stack.workRepository.delete).not.toHaveBeenCalled();
    });

    it('a repository that IS the upstream is never removed, even when this Work created the row', async () => {
        // A fork whose recorded coordinates were hand-edited to the upstream's own
        // full name: the platform must not delete what it did not create.
        const work = appWork('fork');
        (
            work as unknown as {
                sourceRepository: {
                    relatedRepositories: { website: { owner: string; repo: string } };
                };
            }
        ).sourceRepository.relatedRepositories.website = {
            owner: 'apw-e2e-upstream',
            repo: 'cal-diy',
        };
        const stack = makeStack(work);

        const result = await stack.service.deleteWork(
            'w-app',
            await viaGlobalPipe({ delete_data_repository: true }),
            user,
        );

        expect(callNames(stack.calls)).toEqual([]);
        expect(result.deleted_repositories).toEqual([]);
        expect(result.message).toContain('upstream');
    });
});

describe('deleteWork — the APP_WORK_DELETION_PORT contract (T39)', () => {
    it('is called exactly once, BEFORE any repository step, with deleteStoredData false by default', async () => {
        const stack = makeStack(appWork('fork'), 'done');

        await stack.service.deleteWork(
            'w-app',
            await viaGlobalPipe({ delete_data_repository: true }),
            user,
        );

        expect(stack.portRequests).toEqual([
            { workId: 'w-app', userId: 'owner-1', deleteStoredData: false },
        ]);
        expect(stack.events).toEqual([
            'port requestDeletion',
            'remove apw-e2e-user/cal-diy',
            'row delete',
        ]);
    });

    it('receives deleteStoredData: true only on the explicit flag, and the fork decision is identical', async () => {
        const withoutStoredData = makeStack(appWork('fork'), 'done');
        const withStoredData = makeStack(appWork('fork'), 'done');

        const resultA = await withoutStoredData.service.deleteWork(
            'w-app',
            await viaGlobalPipe({ delete_data_repository: true }),
            user,
        );
        const resultB = await withStoredData.service.deleteWork(
            'w-app',
            await viaGlobalPipe({
                delete_data_repository: true,
                delete_stored_data: true,
                confirm_slug: 'cal-diy',
            }),
            user,
        );

        expect(withoutStoredData.portRequests[0].deleteStoredData).toBe(false);
        expect(withStoredData.portRequests[0].deleteStoredData).toBe(true);
        expect(callNames(withStoredData.calls)).toEqual(callNames(withoutStoredData.calls));
        expect(resultB.deleted_repositories).toEqual(resultA.deleted_repositories);
    });

    it('refuses delete_stored_data without the matching slug with 422 confirmation_mismatch, before the port', async () => {
        for (const body of [
            { delete_stored_data: true },
            { delete_stored_data: true, confirm_slug: 'not-the-slug' },
            { delete_stored_data: true, confirm_slug: '' },
        ]) {
            const stack = makeStack(appWork('fork'), 'pending');

            await expect(
                stack.service.deleteWork('w-app', await viaGlobalPipe(body), user),
            ).rejects.toMatchObject({
                status: 422,
                response: expect.objectContaining({ code: 'confirmation_mismatch' }),
            });

            expect({ body, portRequests: stack.portRequests }).toEqual({
                body,
                portRequests: [],
            });
            expect({ body, calls: callNames(stack.calls) }).toEqual({ body, calls: [] });
            expect(stack.workRepository.delete).not.toHaveBeenCalled();
        }
    });

    it('proceeds on the matching pair, and the port is called before any repository step', async () => {
        const stack = makeStack(appWork('fork'), 'done');

        const result = await stack.service.deleteWork(
            'w-app',
            await viaGlobalPipe({
                delete_data_repository: true,
                delete_stored_data: true,
                confirm_slug: 'cal-diy',
            }),
            user,
        );

        expect(stack.portRequests).toHaveLength(1);
        expect(stack.events[0]).toBe('port requestDeletion');
        expect(stack.events).toContain('remove apw-e2e-user/cal-diy');
        expect(result.status).toBe('success');
        expect(result.deleting).toBeUndefined();
        expect(stack.workRepository.delete).toHaveBeenCalledWith('w-app');
    });

    it('done ⇒ the row is deleted in the request', async () => {
        const stack = makeStack(appWork('fork'), 'done');

        const result = await stack.service.deleteWork('w-app', await viaGlobalPipe({}), user);

        expect(result.status).toBe('success');
        expect(stack.workRepository.delete).toHaveBeenCalledWith('w-app');
        for (const cleanup of stack.cleanups) {
            expect(cleanup).toHaveBeenCalledTimes(1);
        }
    });

    it('pending ⇒ the row STAYS, the answer says deleting, and completeAppWorkDeletion finishes it once', async () => {
        const stack = makeStack(appWork('fork'), 'pending');

        const result = await stack.service.deleteWork('w-app', await viaGlobalPipe({}), user);

        expect(result).toMatchObject({ status: 'pending', deleting: true, slug: 'cal-diy' });
        expect(stack.workRepository.delete).not.toHaveBeenCalled();
        for (const cleanup of stack.cleanups) {
            expect(cleanup).not.toHaveBeenCalled();
        }

        // APW-06 calls back once the workloads are gone.
        await expect(stack.service.completeAppWorkDeletion('w-app')).resolves.toBe(true);
        expect(stack.workRepository.delete).toHaveBeenCalledWith('w-app');
        for (const cleanup of stack.cleanups) {
            expect(cleanup).toHaveBeenCalledTimes(1);
        }

        // Idempotent: a second (or replayed) completion is a no-op, not an error.
        await expect(stack.service.completeAppWorkDeletion('w-app')).resolves.toBe(false);
        expect(stack.workRepository.delete).toHaveBeenCalledTimes(1);
        expect(callNames(stack.calls)).toEqual([]);
    });

    it('unbound ⇒ the deletion proceeds exactly as before, and no port is involved', async () => {
        const stack = makeStack(appWork('fork'), 'unbound');

        const result = await stack.service.deleteWork('w-app', await viaGlobalPipe({}), user);

        expect(result).toMatchObject({ status: 'success', slug: 'cal-diy' });
        expect(result.deleting).toBeUndefined();
        expect(stack.workRepository.delete).toHaveBeenCalledWith('w-app');
        expect(stack.events).toEqual(['row delete']);
    });

    it('a throw is taken as done, the row is deleted, and the message names the target and the code', async () => {
        const stack = makeStack(appWork('fork', { deployProvider: 'k8s-self-hosted' }), 'throw');

        const result = await stack.service.deleteWork('w-app', await viaGlobalPipe({}), user);

        expect(result.status).toBe('success');
        expect(stack.workRepository.delete).toHaveBeenCalledWith('w-app');
        expect(stack.events).toContain('port requestDeletion');
        expect(result.message).toContain('your-cluster');
        expect(result.message).toContain('no_runtime');
    });

    it('non-app kinds never call the port', async () => {
        for (const kind of ['directory', 'website', 'repo']) {
            const stack = makeStack(controlWork(kind), 'pending');

            await stack.service.deleteWork('w-control', await viaGlobalPipe({}), user);

            expect({ kind, portRequests: stack.portRequests }).toEqual({ kind, portRequests: [] });
            expect({ kind, events: stack.events }).toEqual({ kind, events: ['row delete'] });
        }
    });
});

describe('deleteWork — every other kind keeps the behaviour it had', () => {
    it('a directory Work still deletes all three repositories on the legacy defaults', async () => {
        const stack = makeStack(controlWork('directory'));

        const result = await stack.service.deleteWork(
            'w-control',
            await viaGlobalPipe({
                delete_data_repository: true,
                delete_markdown_repository: true,
                delete_website_repository: true,
            }),
            user,
        );

        expect(callNames(stack.calls)).toEqual([
            'acme/best-tools-data',
            'acme/best-tools',
            'acme/best-tools-website',
        ]);
        expect(result.message).not.toContain('Kept:');
    });

    it('a company Work still skips the website role it never provisions', async () => {
        const stack = makeStack(controlWork('company'));

        const result = await stack.service.deleteWork(
            'w-control',
            await viaGlobalPipe({
                delete_data_repository: true,
                delete_markdown_repository: true,
                delete_website_repository: true,
            }),
            user,
        );

        expect(callNames(stack.calls)).toEqual(['acme/best-tools-data', 'acme/best-tools']);
        expect(result.message).not.toContain('Kept:');
    });

    it('a repository Work still refuses an explicit delete_data_repository with 400', async () => {
        const stack = makeStack(controlWork('repo'));

        await expect(
            stack.service.deleteWork(
                'w-control',
                await viaGlobalPipe({ delete_data_repository: true }),
                user,
            ),
        ).rejects.toMatchObject({ status: 400 });
        expect(stack.calls).toEqual([]);
    });
});
