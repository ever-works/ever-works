import * as yaml from 'yaml';
import { WorksConfigService } from '../../works-config/services/works-config.service';
import {
    APP_SOURCE_INITIALIZER_FILE,
    APP_SOURCE_SETUP_BRANCH,
    AppSourceInitializerService,
} from '../../app-works/app-source-initializer.service';
import {
    APP_BLUEPRINT_ACTIVITY_EVENTS,
    APP_BLUEPRINT_APPLY_CODES,
    AppBlueprintApplyService,
    adaptBlueprintForRelation,
} from '../app-blueprint-apply.service';
import { WorkAppSpecStateRepository } from '../../database/repositories/work-app-spec-state.repository';

/**
 * APW-03 T28 — the Blueprint apply, alone and through the ready handler.
 *
 * ACC-03-26: a fresh Fork App Work gets exactly ONE commit holding the Blueprint spec
 * and `spec.source`; a Link App Work gets a pull request and no push. GAP-02: a Link
 * drops `upstreamSync` and forces `upstreamPullRequests.enabled: false`.
 */

const WORK_ID = '00000000-0000-4000-8000-0000000000b1';
const USER_ID = 'user-b1';
const HEAD = 'sha-head-b1';

const BLUEPRINT_YAML = [
    'version: 2',
    'kind: app',
    'name: Cal',
    'spec:',
    '  blueprint:',
    '    id: cal',
    '    version: 0.1.0',
    '    repo: ever-works/cal-template',
    "    sha: '0000000000000000000000000000000000000000'",
    '  license:',
    '    spdx: MIT',
    '  display:',
    '    name: Cal (community build)',
    '  upstreamSync:',
    '    schedule: daily',
    '  upstreamPullRequests:',
    '    enabled: true',
    '  __proto__:',
    '    polluted: true',
    '',
].join('\n');

function resolverDouble(found = true) {
    return {
        readBlueprintDocument: jest.fn(async (id: string) =>
            found && id === 'cal'
                ? {
                      hit: {
                          status: 'hit',
                          source: 'explicit',
                          repo: 'ever-works/cal-template',
                          id: 'cal',
                          version: '0.1.0',
                          name: 'Cal (community build)',
                          displayName: 'Cal (community build)',
                          spdx: 'MIT',
                          prompts: [],
                      },
                      text: BLUEPRINT_YAML,
                      defaultBranch: 'main',
                  }
                : null,
        ),
    };
}

function statesDouble(initial: Record<string, unknown> = {}) {
    const row: Record<string, unknown> = { workId: WORK_ID, ...initial };
    return {
        row,
        findByWorkId: jest.fn(async () => ({ ...row })),
        markBlueprintMatched: jest.fn(async (_w: string, id: string, version: string) => {
            row.blueprintId = id;
            row.blueprintVersion = version;
            row.blueprintApplyStatus = 'applying';
            return true;
        }),
        patchBlueprint: jest.fn(async (_w: string, patch: Record<string, unknown>) => {
            Object.assign(row, patch);
            return true;
        }),
    };
}

/** `ModuleRef` double: answers the state repository by class, nothing else. */
function moduleRefFor(states: unknown) {
    return {
        get: (token: unknown) => {
            if (token === WorkAppSpecStateRepository) return states;
            throw new Error('unknown');
        },
    };
}

function workRow(relation: 'fork' | 'link') {
    return {
        id: WORK_ID,
        userId: USER_ID,
        slug: 'cal',
        owner: 'member',
        gitProvider: 'github',
        tenantId: null,
        organizationId: null,
        sourceRepository: {
            url: 'https://github.com/member/cal.diy',
            owner: 'member',
            repo: 'cal.diy',
            type: relation === 'fork' ? 'app_fork' : 'app_link',
            importedAt: new Date(),
            relatedRepositories: { website: { owner: 'member', repo: 'cal.diy' } },
            ...(relation === 'fork'
                ? { upstream: { owner: 'calcom', repo: 'cal.diy', defaultBranch: 'main' } }
                : {}),
            createdByThisWork: relation === 'fork',
            blueprintId: 'cal',
            blueprintMatchSource: 'probe',
        },
    };
}

function fakeGit() {
    const heads: Record<string, string> = { main: HEAD };
    const files: Record<string, string> = {};
    let seq = 0;
    return {
        heads,
        files,
        commitFiles: jest.fn(
            async (
                _o: string,
                _r: string,
                input: {
                    branch: string;
                    baseSha: string;
                    files: Array<{ path: string; content: string }>;
                },
            ) => {
                if (heads[input.branch] !== input.baseSha) {
                    throw Object.assign(new Error('nonFastForward'), { code: 'nonFastForward' });
                }
                seq += 1;
                const sha = `sha-commit-${seq}`;
                for (const file of input.files) {
                    files[`${input.branch}::${file.path}`] = file.content;
                    files[`${sha}::${file.path}`] = file.content;
                }
                heads[input.branch] = sha;
                return { commitSha: sha };
            },
        ),
        getLatestCommit: jest.fn(async (_o: string, _r: string, branch: string) =>
            heads[branch] ? { sha: heads[branch] } : null,
        ),
        getFileContent: jest.fn(
            async (_o: string, _r: string, path: string, _opts: unknown, ref?: string) => {
                const content = files[`${ref}::${path}`];
                return content === undefined ? null : { content, encoding: 'utf-8' };
            },
        ),
        createBranchFromSha: jest.fn(async (_o: string, _r: string, name: string, sha: string) => {
            heads[name] = sha;
            return { name, commit: sha, isDefault: false };
        }),
        listPullRequests: jest.fn(async () => []),
        createPullRequest: jest.fn(
            async (options: { head: string; base: string; title: string }) => ({
                number: 11,
                state: 'open',
                head: options.head,
                url: 'https://github.com/member/cal.diy/pull/11',
            }),
        ),
        cloneOrPull: jest.fn(async () => {
            throw new Error('never clone');
        }),
    };
}

function build(relation: 'fork' | 'link', opts: { found?: boolean } = {}) {
    const states = statesDouble();
    const works = { findById: jest.fn(async () => workRow(relation)) };
    const activity = { log: jest.fn(async (_entry: unknown) => ({ id: 'a' })) };
    const apply = new AppBlueprintApplyService(
        resolverDouble(opts.found ?? true) as never,
        works as never,
        activity as never,
        moduleRefFor(states) as never,
    );
    const git = fakeGit();
    const appSpec = {
        initialize: jest.fn(async () => ({ workId: WORK_ID })),
        hasValidAppSpec: jest.fn(async () => true),
        requestEvaluation: jest.fn(async () => ({ requested: true })),
    };
    const license = { request: jest.fn(async () => undefined) };
    const initializer = new AppSourceInitializerService(
        works as never,
        { findByWorkId: jest.fn(async () => ({ dataDefaultBranch: 'main' })) } as never,
        git as never,
        appSpec as never,
        new WorksConfigService({} as never) as never,
        activity as never,
        apply as never,
        license as never,
        undefined,
    );
    return { apply, states, works, activity, git, appSpec, license, initializer };
}

describe('AppBlueprintApplyService (APW-03 T28)', () => {
    describe('adaptBlueprintForRelation (GAP-02)', () => {
        it('drops upstreamSync and forces upstream pull requests off for a link, listing both', () => {
            const { document, dropped } = adaptBlueprintForRelation(
                {
                    spec: {
                        upstreamSync: { schedule: 'daily' },
                        upstreamPullRequests: { enabled: true },
                    },
                },
                'link',
            );
            expect((document.spec as Record<string, unknown>).upstreamSync).toBeUndefined();
            expect((document.spec as Record<string, any>).upstreamPullRequests.enabled).toBe(false);
            expect(dropped).toEqual(['spec.upstreamSync', 'spec.upstreamPullRequests.enabled']);
        });

        it('keeps both for a fork, and never keeps a Blueprint-declared source block', () => {
            const { document, dropped } = adaptBlueprintForRelation(
                { spec: { source: { relation: 'link' }, upstreamSync: { schedule: 'daily' } } },
                'fork',
            );
            expect((document.spec as Record<string, unknown>).upstreamSync).toEqual({
                schedule: 'daily',
            });
            expect((document.spec as Record<string, unknown>).source).toBeUndefined();
            expect(dropped).toEqual(['spec.source']);
        });
    });

    describe('compose', () => {
        it('answers the Blueprint document and records the match on the state row', async () => {
            const h = build('fork');
            const composed = await h.apply.compose({
                workId: WORK_ID,
                blueprintId: 'cal',
                relation: 'fork',
                matchSource: 'probe',
            });
            expect(composed.status).toBe('composed');
            const doc = yaml.parse((composed as { text: string }).text);
            expect(doc.spec.blueprint.id).toBe('cal');
            expect(doc.spec.source).toBeUndefined();
            // The prototype-pollution key never survives.
            expect(Object.prototype.hasOwnProperty.call(doc.spec, '__proto__')).toBe(false);
            expect(h.states.markBlueprintMatched).toHaveBeenCalledWith(
                WORK_ID,
                'cal',
                '0.1.0',
                'probe',
            );
            expect(h.states.row.blueprintRepo).toBe('ever-works/cal-template');
            expect(h.states.row.displayName).toBe('Cal (community build)');
        });

        it('answers blueprintNotFound for an id with no Blueprint', async () => {
            const h = build('fork', { found: false });
            const composed = await h.apply.compose({
                workId: WORK_ID,
                blueprintId: 'cal',
                relation: 'fork',
            });
            expect(composed).toEqual({
                status: 'refused',
                code: APP_BLUEPRINT_APPLY_CODES.blueprintNotFound,
            });
        });
    });

    describe('request', () => {
        it('refuses a second apply of the same Blueprint while one is in flight', async () => {
            const h = build('fork');
            h.states.row.blueprintId = 'cal';
            h.states.row.blueprintApplyStatus = 'applying';
            await expect(
                h.apply.request(WORK_ID, 'cal', { confirmForkMatch: false }),
            ).resolves.toEqual({
                code: APP_BLUEPRINT_APPLY_CODES.applyInProgress,
            });
        });
    });

    describe('through the ready handler (ACC-03-26)', () => {
        it('a fresh Fork App Work gets exactly ONE commit with the Blueprint spec and source', async () => {
            const h = build('fork');

            const outcome = await h.initializer.onDataRepositoryReady({ workId: WORK_ID });

            expect(outcome).toEqual({ result: 'initialized' });
            expect(h.git.commitFiles).toHaveBeenCalledTimes(1);
            expect(h.git.cloneOrPull).not.toHaveBeenCalled();
            const committed = yaml.parse(h.git.files[`main::${APP_SOURCE_INITIALIZER_FILE}`]);
            expect(committed.kind).toBe('app');
            expect(committed.spec.blueprint).toMatchObject({ id: 'cal', version: '0.1.0' });
            expect(committed.spec.source).toMatchObject({
                relation: 'fork',
                upstream: { repo: 'calcom/cal.diy' },
                branch: 'main',
            });
            expect(committed.spec.upstreamSync).toEqual({ schedule: 'daily' });
            expect(h.states.row.blueprintApplyStatus).toBe('applied');
            expect(h.states.row.blueprintApplyRef).toMatchObject({
                kind: 'commit',
                sha: 'sha-commit-1',
            });
            expect(h.appSpec.requestEvaluation).toHaveBeenCalledWith(
                WORK_ID,
                'blueprint_applied',
                expect.any(Object),
            );
            expect(h.license.request).toHaveBeenCalledWith(WORK_ID);
            const actions = h.activity.log.mock.calls.map(
                (call) => (call[0] as { action: string }).action,
            );
            expect(actions).toContain(APP_BLUEPRINT_ACTIVITY_EVENTS.applied);

            // Idempotent: a second run finds the Blueprint recorded and commits nothing.
            const again = await h.initializer.onDataRepositoryReady({ workId: WORK_ID });
            expect(again).toEqual({ result: 'unchanged' });
            expect(h.git.commitFiles).toHaveBeenCalledTimes(1);
        });

        it('a Link App Work gets a setup pull request and never a push to its default branch', async () => {
            const h = build('link');

            const outcome = await h.initializer.onDataRepositoryReady({ workId: WORK_ID });

            expect(outcome).toMatchObject({
                result: 'waiting_for_setup_pr',
                setupPullRequestNumber: 11,
            });
            const branches = h.git.commitFiles.mock.calls.map(
                (call) => (call[2] as { branch: string }).branch,
            );
            expect(branches).toEqual([APP_SOURCE_SETUP_BRANCH]);
            const proposed = yaml.parse(
                h.git.files[`${APP_SOURCE_SETUP_BRANCH}::${APP_SOURCE_INITIALIZER_FILE}`],
            );
            expect(proposed.spec.upstreamSync).toBeUndefined();
            expect(proposed.spec.upstreamPullRequests.enabled).toBe(false);
            expect(proposed.spec.source).toMatchObject({ relation: 'link' });
            expect(h.states.row.blueprintApplyRef).toMatchObject({
                kind: 'pull_request',
                number: 11,
            });
            expect(h.states.row.blueprintApplyStatus).toBe('applying');
        });

        it('a missing Blueprint fails the hand-off by name and writes nothing', async () => {
            const h = build('fork', { found: false });

            const outcome = await h.initializer.onDataRepositoryReady({ workId: WORK_ID });

            expect(outcome).toEqual({ result: 'failed', reason: 'blueprint_blueprintNotFound' });
            expect(h.git.commitFiles).not.toHaveBeenCalled();
        });
    });
});
