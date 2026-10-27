import * as yaml from 'yaml';
import { WorkAppSpecStateRepository } from '../../database/repositories/work-app-spec-state.repository';
import { APP_BLUEPRINT_TOPIC, AppBlueprintResolverService } from '../app-blueprint-resolver.service';
import {
    APP_BLUEPRINT_APPLY_DISPATCHER,
    APP_BLUEPRINT_APPLY_JOB_ID,
    buildAppBlueprintApplyDispatcherProvider,
} from '../app-blueprint-apply.job';
import { AppBlueprintApplyRunner, AppBlueprintUpgradeListener } from '../app-blueprint-apply.runner';
import {
    APP_BLUEPRINT_RUN_EVENTS,
    APP_BLUEPRINT_RUN_STALE_MS,
    AppBlueprintUpgradeService,
    isBreakingBlueprintUpgrade,
    isNewerBlueprintVersion,
} from '../app-blueprint-upgrade.service';

/**
 * APW-03 T28–T31 (lane aw-blueprints) — the Blueprint apply-after-create and upgrade run,
 * end to end over an in-memory git provider and the REAL resolver (so the release read,
 * its SSRF containment and its acceptance rules are exercised too).
 *
 * ACC-03-29: the upgrade pull request keeps a member field, lists a conflict, and is
 * updated (not duplicated) by a newer version; dismiss hides only that version.
 */

const WORK_ID = '00000000-0000-4000-8000-0000000000c1';
const OWNER_ID = 'user-owner';
const EDITOR_ID = 'user-editor';
const WORK_OWNER = 'member';
const WORK_REPO = 'umami';
const TRACKED = 'main';
const WORK_HEAD = 'a'.repeat(40);
const BP_REPO = 'ever-works/umami-template';
const BP_HEAD = 'b'.repeat(40);
const SPEC = '.works/works.yml';

function blueprintYaml(version: string, env: string[], extra: string[] = []): string {
    return [
        'version: 2',
        'kind: app',
        'name: Umami',
        'spec:',
        '  blueprint:',
        '    id: umami',
        `    version: ${version}`,
        `    repo: ${BP_REPO}`,
        `    sha: '${'0'.repeat(40)}'`,
        '  license:',
        '    spdx: MIT',
        '  display:',
        "    name: 'Umami'",
        '  env:',
        ...env,
        ...extra,
        '',
    ].join('\n');
}

const MARKER = ['    - name: MARKER', '      prompt:', "        description: 'Any text'"];
const V010 = blueprintYaml('0.1.0', [...MARKER, '    - name: LOG_LEVEL', '      value: info']);
const V020 = blueprintYaml('0.2.0', [
    ...MARKER,
    '    - name: LOG_LEVEL',
    '      value: warn',
    '    - name: NEW_FLAG',
    "      value: '1'",
]);

/** The App Work's own file: the Blueprint at 0.1.0 plus its `source`, with a member edit. */
function oursYaml(logLevel = 'debug', version = '0.1.0'): string {
    const doc = yaml.parse(version === '0.1.0' ? V010 : V020) as Record<string, any>;
    doc.spec.source = { relation: 'fork', upstream: { repo: 'umami-software/umami' }, branch: TRACKED };
    const log = doc.spec.env.find((entry: { name: string }) => entry.name === 'LOG_LEVEL');
    log.value = logLevel;
    return `# my analytics\n${yaml.stringify(doc)}`;
}

interface PullRequestRow {
    number: number;
    head: string;
    base: string;
    state: 'open' | 'closed';
    url: string;
    title: string;
    body?: string;
}

function gitFake() {
    const repositories: Record<string, unknown> = {
        [BP_REPO]: {
            owner: 'ever-works',
            name: 'umami-template',
            fullName: BP_REPO,
            defaultBranch: 'main',
            isPrivate: false,
            visibility: 'public',
            topics: [APP_BLUEPRINT_TOPIC],
        },
    };
    const heads: Record<string, string> = {
        [`${BP_REPO}#main`]: BP_HEAD,
        [`${WORK_OWNER}/${WORK_REPO}#${TRACKED}`]: WORK_HEAD,
    };
    const files: Record<string, string> = {
        [`${BP_REPO}@v0.1.0:${SPEC}`]: V010,
        [`${BP_REPO}@${BP_HEAD}:${SPEC}`]: V020,
        [`${WORK_OWNER}/${WORK_REPO}@${WORK_HEAD}:${SPEC}`]: oursYaml(),
    };
    const pulls: PullRequestRow[] = [];
    let seq = 0;
    const key = (owner: string, repo: string) => `${owner}/${repo}`;
    const fake = {
        repositories,
        heads,
        files,
        pulls,
        getInstallationTokenForOwner: jest.fn(async () => 'installation-token'),
        getRepository: jest.fn(async (owner: string, name: string) => repositories[key(owner, name)] ?? null),
        getLatestCommit: jest.fn(async (owner: string, repo: string, branch: string) => {
            const sha = heads[`${key(owner, repo)}#${branch}`];
            return sha ? { sha } : null;
        }),
        getFileContent: jest.fn(async (owner: string, repo: string, path: string, _o: unknown, ref?: string) => {
            const content = files[`${key(owner, repo)}@${ref}:${path}`];
            return content === undefined ? null : { content, encoding: 'utf-8' };
        }),
        createBranchFromSha: jest.fn(async (owner: string, repo: string, name: string, sha: string) => {
            const id = `${key(owner, repo)}#${name}`;
            if (heads[id]) throw Object.assign(new Error('Reference already exists'), { reason: 'unprocessable' });
            heads[id] = sha;
            // A branch starts with the files of its commit.
            return { name, commit: sha, isDefault: false };
        }),
        commitFiles: jest.fn(
            async (
                owner: string,
                repo: string,
                input: { branch: string; baseSha: string; message: string; files: Array<{ path: string; content: string }> },
            ) => {
                const id = `${key(owner, repo)}#${input.branch}`;
                if (heads[id] !== input.baseSha) {
                    throw Object.assign(new Error('not a fast forward'), { code: 'nonFastForward' });
                }
                seq += 1;
                const sha = String(seq).padStart(40, 'c');
                for (const file of input.files) files[`${key(owner, repo)}@${sha}:${file.path}`] = file.content;
                heads[id] = sha;
                return { commitSha: sha };
            },
        ),
        listPullRequests: jest.fn(async (owner: string, _repo: string, options: { state?: string; head?: string }) =>
            pulls.filter((row) => row.state === options.state && `${owner}:${row.head}` === options.head),
        ),
        createPullRequest: jest.fn(
            async (options: { owner: string; repo: string; title: string; head: string; base: string; body?: string }) => {
                const row: PullRequestRow = {
                    number: 40 + pulls.length + 1,
                    head: options.head,
                    base: options.base,
                    state: 'open',
                    url: `https://github.com/${options.owner}/${options.repo}/pull/${40 + pulls.length + 1}`,
                    title: options.title,
                    body: options.body,
                };
                pulls.push(row);
                return { ...row };
            },
        ),
        updatePullRequest: jest.fn(
            async (_owner: string, _repo: string, number: number, changes: { title?: string; body?: string }) => {
                const row = pulls.find((pull) => pull.number === number)!;
                Object.assign(row, changes);
                return { ...row };
            },
        ),
        getPullRequest: jest.fn(async (_owner: string, _repo: string, number: number) => {
            const row = pulls.find((pull) => pull.number === number);
            return row ? { ...row } : null;
        }),
        /** The tracked branch's file — the run must never change it. */
        trackedFile: () => files[`${WORK_OWNER}/${WORK_REPO}@${heads[`${WORK_OWNER}/${WORK_REPO}#${TRACKED}`]}:${SPEC}`],
        /** The spec file at a branch's head. */
        fileOn: (branch: string) => files[`${WORK_OWNER}/${WORK_REPO}@${heads[`${WORK_OWNER}/${WORK_REPO}#${branch}`]}:${SPEC}`],
    };
    return fake;
}

function statesFake(initial: Record<string, unknown>) {
    const row: Record<string, unknown> = {
        workId: WORK_ID,
        trackedBranch: TRACKED,
        blueprintUpgradeStatus: null,
        blueprintUpgradeRequestedAt: null,
        ...initial,
    };
    return {
        row,
        findByWorkId: jest.fn(async () => ({ ...row })),
        claimBlueprintRun: jest.fn(async (_w: string, now: Date, staleBefore: Date) => {
            const inFlight = row.blueprintUpgradeStatus === 'queued' || row.blueprintUpgradeStatus === 'running';
            const requestedAt = row.blueprintUpgradeRequestedAt as Date | null;
            if (inFlight && requestedAt && requestedAt >= staleBefore) return false;
            Object.assign(row, {
                blueprintUpgradeStatus: 'queued',
                blueprintUpgradeError: null,
                blueprintUpgradeRequestedAt: now,
            });
            return true;
        }),
        patchBlueprintRun: jest.fn(async (_w: string, patch: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(patch)) if (v !== undefined) row[k] = v;
            return true;
        }),
        markBlueprintMatched: jest.fn(async (_w: string, id: string, version: string, source: string) => {
            if (row.blueprintId === id && row.blueprintVersion === version && row.blueprintMatchedAt) return false;
            Object.assign(row, {
                blueprintId: id,
                blueprintVersion: version,
                blueprintMatchSource: source,
                blueprintApplyStatus: 'applying',
                blueprintMatchedAt: new Date(),
            });
            return true;
        }),
        patchBlueprint: jest.fn(async (_w: string, patch: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(patch)) if (v !== undefined) row[k] = v;
            return true;
        }),
    };
}

function workRow() {
    return {
        id: WORK_ID,
        userId: OWNER_ID,
        kind: 'app',
        gitProvider: 'github',
        getRepoOwner: () => WORK_OWNER,
        getWebsiteRepo: () => WORK_REPO,
        sourceRepository: {
            owner: WORK_OWNER,
            repo: WORK_REPO,
            type: 'app_fork',
            upstream: { owner: 'umami-software', repo: 'umami', defaultBranch: 'master' },
        },
    };
}

function moduleRefFor(states: unknown) {
    return {
        get: (token: unknown) => {
            if (token === WorkAppSpecStateRepository) return states;
            throw new Error('unknown');
        },
    };
}

const UPGRADE_STATE = {
    blueprintId: 'umami',
    blueprintVersion: '0.1.0',
    blueprintRepo: BP_REPO,
    blueprintApplyStatus: 'applied',
    blueprintLatestVersion: '0.2.0',
};

function build(
    initial: Record<string, unknown> = UPGRADE_STATE,
    opts: { dispatch?: (payload: unknown) => Promise<string | null>; locks?: unknown; git?: ReturnType<typeof gitFake> } = {},
) {
    const git = opts.git ?? gitFake();
    const states = statesFake(initial);
    const works = { findById: jest.fn(async () => workRow()) };
    const activity = { log: jest.fn(async (_entry: Record<string, unknown>) => ({ id: 'a' })) };
    const dispatcher = { dispatch: jest.fn(opts.dispatch ?? (async () => 'run_1')) };
    const resolver = new AppBlueprintResolverService(git as never);
    const service = new AppBlueprintUpgradeService(
        resolver,
        works as never,
        git as never,
        activity as never,
        (opts.locks ?? undefined) as never,
        dispatcher,
        moduleRefFor(states) as never,
    );
    service.now = () => new Date('2026-10-27T03:00:00.000Z');
    const actions = () => activity.log.mock.calls.map(([entry]) => entry.action);
    return { git, states, works, activity, dispatcher, service, actions };
}

describe('APW-03 T28 — version helpers', () => {
    it('compares versions by semver, v-prefix tolerated, never guessing', () => {
        expect(isNewerBlueprintVersion('0.2.0', '0.1.0')).toBe(true);
        expect(isNewerBlueprintVersion('v1.0.0', '0.9.9')).toBe(true);
        expect(isNewerBlueprintVersion('0.1.0', '0.1.0')).toBe(false);
        expect(isNewerBlueprintVersion('0.0.9', '0.1.0')).toBe(false);
        expect(isNewerBlueprintVersion('0.2.0', null)).toBe(true);
        expect(isNewerBlueprintVersion('latest', '0.1.0')).toBe(false);
        expect(isNewerBlueprintVersion('0.2.0', 'garbage')).toBe(false);
    });

    it('calls only a MAJOR bump breaking', () => {
        expect(isBreakingBlueprintUpgrade('1.4.0', '2.0.0')).toBe(true);
        expect(isBreakingBlueprintUpgrade('0.1.0', '0.2.0')).toBe(false);
        expect(isBreakingBlueprintUpgrade(null, '2.0.0')).toBe(false);
    });
});

describe('APW-03 T29 — request (the route half)', () => {
    it('refuses an upgrade for a Work that follows no Blueprint', async () => {
        const { service } = build({ blueprintId: null, blueprintVersion: null });
        await expect(service.request({ workId: WORK_ID, mode: 'upgrade', version: '0.2.0' })).resolves.toMatchObject({
            status: 'refused',
            code: 'noBlueprint',
            httpStatus: 422,
        });
    });

    it('refuses a version that is not newer than the applied one (noUpgrade)', async () => {
        const { service, git } = build();
        await expect(service.request({ workId: WORK_ID, mode: 'upgrade', version: '0.1.0' })).resolves.toMatchObject({
            status: 'refused',
            code: 'noUpgrade',
            httpStatus: 422,
        });
        // Refused before any provider read.
        expect(git.getRepository).not.toHaveBeenCalled();
    });

    it('refuses a version the Blueprint repository does not carry', async () => {
        const { service } = build();
        await expect(service.request({ workId: WORK_ID, mode: 'upgrade', version: '0.3.0' })).resolves.toMatchObject({
            status: 'refused',
            code: 'blueprintVersionNotFound',
            httpStatus: 404,
        });
    });

    it('claims the run, writes the audit row with the actor, and dispatches the job', async () => {
        const { service, states, dispatcher, activity } = build();
        const outcome = await service.request({ workId: WORK_ID, userId: EDITOR_ID, mode: 'upgrade', version: '0.2.0' });
        expect(outcome).toEqual({
            status: 'queued',
            mode: 'upgrade',
            blueprintId: 'umami',
            version: '0.2.0',
            runId: 'run_1',
            inProcess: false,
        });
        expect(states.row.blueprintUpgradeStatus).toBe('queued');
        expect(dispatcher.dispatch).toHaveBeenCalledWith(
            expect.objectContaining({ workId: WORK_ID, mode: 'upgrade', blueprintId: 'umami', version: '0.2.0', userId: EDITOR_ID }),
        );
        expect(activity.log).toHaveBeenCalledWith(
            expect.objectContaining({
                action: APP_BLUEPRINT_RUN_EVENTS.upgradeRequested,
                userId: EDITOR_ID,
                actionType: 'app_blueprint',
                details: expect.objectContaining({ blueprintId: 'umami', version: '0.2.0', fromVersion: '0.1.0' }),
            }),
        );
    });

    it('uses the recorded latest version when the body names none', async () => {
        const { service } = build();
        await expect(service.request({ workId: WORK_ID, mode: 'upgrade' })).resolves.toMatchObject({
            status: 'queued',
            version: '0.2.0',
        });
    });

    it('refuses a second request while a run is in flight (applyInProgress), and retakes a stale claim', async () => {
        const { service, states } = build({
            ...UPGRADE_STATE,
            blueprintUpgradeStatus: 'running',
            blueprintUpgradeRequestedAt: new Date('2026-10-27T02:55:00.000Z'),
        });
        await expect(service.request({ workId: WORK_ID, mode: 'upgrade', version: '0.2.0' })).resolves.toMatchObject({
            status: 'refused',
            code: 'applyInProgress',
            httpStatus: 409,
        });
        states.row.blueprintUpgradeRequestedAt = new Date(
            new Date('2026-10-27T03:00:00.000Z').getTime() - APP_BLUEPRINT_RUN_STALE_MS - 1,
        );
        await expect(service.request({ workId: WORK_ID, mode: 'upgrade', version: '0.2.0' })).resolves.toMatchObject({
            status: 'queued',
        });
    });

    it('runs the job in-process when no job runtime takes it, and nothing is dropped', async () => {
        const { service, git, states } = build(UPGRADE_STATE, { dispatch: async () => null });
        const outcome = await service.request({ workId: WORK_ID, mode: 'upgrade', version: '0.2.0' });
        expect(outcome).toMatchObject({ status: 'queued', runId: null, inProcess: true });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(git.createPullRequest).toHaveBeenCalledTimes(1);
        expect(states.row.blueprintUpgradeStatus).toBe('proposed');
    });

    it('answers an open proposal for the same version instead of queueing another', async () => {
        const { service, dispatcher } = build();
        await service.run({ workId: WORK_ID, mode: 'upgrade', blueprintId: 'umami', version: '0.2.0' });
        const outcome = await service.request({ workId: WORK_ID, mode: 'upgrade', version: '0.2.0' });
        expect(outcome).toMatchObject({
            status: 'existing',
            version: '0.2.0',
            pullRequest: expect.objectContaining({ number: 41, version: '0.2.0' }),
        });
        expect(dispatcher.dispatch).not.toHaveBeenCalled();
    });

    it('refuses apply when a Blueprint is already applied, and apply of an unknown id', async () => {
        const { service } = build();
        await expect(service.request({ workId: WORK_ID, mode: 'apply', blueprintId: 'umami' })).resolves.toMatchObject({
            code: 'blueprintAlreadyApplied',
            httpStatus: 409,
        });
        const fresh = build({ blueprintId: null, blueprintVersion: null });
        await expect(
            fresh.service.request({ workId: WORK_ID, mode: 'apply', blueprintId: 'not-a-blueprint' }),
        ).resolves.toMatchObject({ code: 'blueprintNotFound', httpStatus: 404 });
        await expect(
            fresh.service.request({ workId: WORK_ID, mode: 'apply', blueprintId: '../../etc' }),
        ).resolves.toMatchObject({ code: 'blueprintNotFound' });
        // Only the ever-works Blueprint repository is ever read.
        for (const [owner] of fresh.git.getRepository.mock.calls) expect(owner).toBe('ever-works');
    });

    it('records app.blueprint.matched once when a Blueprint is chosen after create', async () => {
        const { service, states, actions } = build({ blueprintId: null, blueprintVersion: null });
        await expect(service.request({ workId: WORK_ID, mode: 'apply', blueprintId: 'umami' })).resolves.toMatchObject({
            status: 'queued',
            mode: 'apply',
            version: '0.2.0',
        });
        expect(states.row).toMatchObject({
            blueprintId: 'umami',
            blueprintVersion: '0.2.0',
            blueprintMatchSource: 'explicit',
            blueprintApplyStatus: 'applying',
            blueprintRepo: BP_REPO,
        });
        expect(actions()).toEqual([APP_BLUEPRINT_RUN_EVENTS.matched, APP_BLUEPRINT_RUN_EVENTS.applyRequested]);
    });
});

describe('APW-03 T28 — run (the job)', () => {
    it('proposes ONE pull request that keeps the member value, lists the conflict and never pushes (ACC-03-29)', async () => {
        const { service, git, states, actions } = build();
        const trackedBefore = git.trackedFile();

        const result = await service.run({ workId: WORK_ID, mode: 'upgrade', blueprintId: 'umami', version: '0.2.0', userId: EDITOR_ID });

        expect(result).toMatchObject({ status: 'proposed', pullRequest: { number: 41 }, conflictCount: 1 });
        // Nothing reached the tracked branch.
        expect(git.trackedFile()).toBe(trackedBefore);
        expect(git.heads[`${WORK_OWNER}/${WORK_REPO}#${TRACKED}`]).toBe(WORK_HEAD);
        for (const [, , input] of git.commitFiles.mock.calls as unknown as Array<[string, string, { branch: string }]>) {
            expect(input.branch).toBe('ever-works/blueprint-upgrade/umami');
        }

        const proposed = yaml.parse(git.fileOn('ever-works/blueprint-upgrade/umami'));
        expect(proposed.spec.source).toEqual({ relation: 'fork', upstream: { repo: 'umami-software/umami' }, branch: TRACKED });
        expect(proposed.spec.blueprint.version).toBe('0.2.0');
        expect(proposed.spec.env).toEqual([
            { name: 'MARKER', prompt: { description: 'Any text' } },
            { name: 'LOG_LEVEL', value: 'debug' },
            { name: 'NEW_FLAG', value: '1' },
        ]);
        const text = git.fileOn('ever-works/blueprint-upgrade/umami');
        expect(text).toContain('# my analytics');
        expect(text).toContain('# ever-works: Blueprint 0.2.0 proposes "warn"; your value was kept.');

        const [pull] = git.pulls;
        expect(pull).toMatchObject({ head: 'ever-works/blueprint-upgrade/umami', base: TRACKED, title: 'Upgrade the umami Blueprint to 0.2.0' });
        expect(pull.body).toContain('spec.env[name=LOG_LEVEL].value');
        expect(pull.body).toContain('the Blueprint proposes "warn"');
        expect(pull.body).toContain('spec.env[name=NEW_FLAG]');
        // The member's own value never travels in the description.
        expect(pull.body).not.toContain('debug');

        expect(states.row).toMatchObject({ blueprintUpgradeStatus: 'proposed', blueprintUpgradeError: null });
        expect(states.row.blueprintUpgradePr).toMatchObject({
            number: 41,
            version: '0.2.0',
            breaking: false,
            mode: 'upgrade',
            fromVersion: '0.1.0',
            branch: 'ever-works/blueprint-upgrade/umami',
            blueprintSha: BP_HEAD,
            baseKnown: true,
            conflictCount: 1,
            conflicts: [{ path: 'spec.env[name=LOG_LEVEL].value', kind: 'both_changed', proposed: '"warn"' }],
        });
        // The applied version only moves when the member merges.
        expect(states.row.blueprintVersion).toBe('0.1.0');
        expect(actions()).toEqual([APP_BLUEPRINT_RUN_EVENTS.upgradeProposed]);
    });

    it('updates the open pull request for a newer version instead of opening a second (FR-51)', async () => {
        const { service, git } = build();
        await service.run({ workId: WORK_ID, mode: 'upgrade', blueprintId: 'umami', version: '0.2.0' });

        // The Blueprint publishes 0.3.0 on its default branch.
        const V030 = V020.replace('version: 0.2.0', 'version: 0.3.0').replace("value: '1'", "value: '2'");
        const next = 'd'.repeat(40);
        git.heads[`${BP_REPO}#main`] = next;
        git.files[`${BP_REPO}@${next}:${SPEC}`] = V030;

        const result = await service.run({ workId: WORK_ID, mode: 'upgrade', blueprintId: 'umami', version: '0.3.0' });
        expect(result).toMatchObject({ status: 'proposed', pullRequest: { number: 41 } });
        expect(git.createPullRequest).toHaveBeenCalledTimes(1);
        expect(git.updatePullRequest).toHaveBeenCalledWith(
            WORK_OWNER,
            WORK_REPO,
            41,
            expect.objectContaining({ title: 'Upgrade the umami Blueprint to 0.3.0' }),
            expect.anything(),
        );
        expect(yaml.parse(git.fileOn('ever-works/blueprint-upgrade/umami')).spec.blueprint.version).toBe('0.3.0');
    });

    it('opens a fresh branch when a closed proposal left the first name taken', async () => {
        const { service, git } = build();
        git.heads[`${WORK_OWNER}/${WORK_REPO}#ever-works/blueprint-upgrade/umami`] = 'e'.repeat(40);
        const result = await service.run({ workId: WORK_ID, mode: 'upgrade', blueprintId: 'umami', version: '0.2.0' });
        expect(result.status).toBe('proposed');
        expect(git.pulls[0].head).toBe('ever-works/blueprint-upgrade/umami-0.2.0');
    });

    it('degrades to a two-way merge when the applied version cannot be read, and says so', async () => {
        const { service, git, states } = build();
        delete git.files[`${BP_REPO}@v0.1.0:${SPEC}`];
        const result = await service.run({ workId: WORK_ID, mode: 'upgrade', blueprintId: 'umami', version: '0.2.0' });
        expect(result.status).toBe('proposed');
        expect(states.row.blueprintUpgradePr).toMatchObject({ baseKnown: false });
        expect(git.pulls[0].body).toContain('could not be read');
        // The member value still wins; the Blueprint's new entry is still added.
        const proposed = yaml.parse(git.fileOn(git.pulls[0].head));
        expect(proposed.spec.env.map((e: { name: string }) => e.name)).toEqual(['MARKER', 'LOG_LEVEL', 'NEW_FLAG']);
        expect(proposed.spec.env[1].value).toBe('debug');
    });

    it('reads the base at the sha recorded when it was applied', async () => {
        const recorded = 'f'.repeat(40);
        const { service, git } = build({ ...UPGRADE_STATE, blueprintSha: recorded });
        git.files[`${BP_REPO}@${recorded}:${SPEC}`] = V010;
        delete git.files[`${BP_REPO}@v0.1.0:${SPEC}`];
        await service.run({ workId: WORK_ID, mode: 'upgrade', blueprintId: 'umami', version: '0.2.0' });
        expect(git.getFileContent).toHaveBeenCalledWith('ever-works', 'umami-template', SPEC, expect.anything(), recorded);
    });

    it('labels a MAJOR bump Breaking', async () => {
        const { service, git, states } = build({ ...UPGRADE_STATE, blueprintVersion: '1.0.0' });
        git.files[`${BP_REPO}@v1.0.0:${SPEC}`] = V010.replace('version: 0.1.0', 'version: 1.0.0');
        git.files[`${BP_REPO}@${BP_HEAD}:${SPEC}`] = V020.replace('version: 0.2.0', 'version: 2.0.0');
        git.files[`${WORK_OWNER}/${WORK_REPO}@${WORK_HEAD}:${SPEC}`] = oursYaml().replace('version: 0.1.0', 'version: 1.0.0');
        await service.run({ workId: WORK_ID, mode: 'upgrade', blueprintId: 'umami', version: '2.0.0' });
        expect(git.pulls[0].title).toBe('Breaking: Upgrade the umami Blueprint to 2.0.0');
        expect(git.pulls[0].body).toContain('**Breaking:**');
        expect(states.row.blueprintUpgradePr).toMatchObject({ breaking: true });
    });

    it('records nothing to propose when the file already matches the new version', async () => {
        const { service, git, states } = build();
        git.files[`${WORK_OWNER}/${WORK_REPO}@${WORK_HEAD}:${SPEC}`] = oursYaml('warn', '0.2.0');
        const result = await service.run({ workId: WORK_ID, mode: 'upgrade', blueprintId: 'umami', version: '0.2.0' });
        expect(result.status).toBe('unchanged');
        expect(states.row.blueprintUpgradeStatus).toBe('unchanged');
        expect(git.createBranchFromSha).not.toHaveBeenCalled();
        expect(git.createPullRequest).not.toHaveBeenCalled();
    });

    it('fails with a named code (and an audit row) when the tracked branch is gone', async () => {
        const { service, git, states, actions } = build();
        delete git.heads[`${WORK_OWNER}/${WORK_REPO}#${TRACKED}`];
        const result = await service.run({ workId: WORK_ID, mode: 'upgrade', blueprintId: 'umami', version: '0.2.0' });
        expect(result).toMatchObject({ status: 'failed', reason: 'trackedBranchMissing' });
        expect(states.row).toMatchObject({ blueprintUpgradeStatus: 'failed', blueprintUpgradeError: 'trackedBranchMissing' });
        expect(actions()).toEqual([APP_BLUEPRINT_RUN_EVENTS.upgradeFailed]);
        expect(git.createPullRequest).not.toHaveBeenCalled();
    });

    it('refuses a works.yml that declares another kind, writing nothing', async () => {
        const { service, git } = build();
        git.files[`${WORK_OWNER}/${WORK_REPO}@${WORK_HEAD}:${SPEC}`] = 'version: 2\nkind: directory\n';
        const result = await service.run({ workId: WORK_ID, mode: 'upgrade', blueprintId: 'umami', version: '0.2.0' });
        expect(result).toMatchObject({ status: 'failed', reason: 'worksYmlOtherKind' });
        expect(git.commitFiles).not.toHaveBeenCalled();
    });

    it('refuses a malformed payload without touching anything', async () => {
        const { service, states } = build();
        const result = await service.run({ workId: WORK_ID, mode: 'upgrade', blueprintId: '../x', version: '0.2.0' });
        expect(result).toMatchObject({ status: 'failed', reason: 'invalidPayload' });
        expect(states.patchBlueprintRun).not.toHaveBeenCalled();
    });

    it('skips when another run holds the per-Work lock', async () => {
        const locks = { runExclusive: jest.fn(async () => ({ acquired: false })) };
        const { service, git } = build(UPGRADE_STATE, { locks });
        const result = await service.run({ workId: WORK_ID, mode: 'upgrade', blueprintId: 'umami', version: '0.2.0' });
        expect(result).toMatchObject({ status: 'skipped', reason: 'locked' });
        expect(locks.runExclusive).toHaveBeenCalledWith(`app-blueprint-apply:${WORK_ID}`, expect.any(Function), expect.anything());
        expect(git.getLatestCommit).not.toHaveBeenCalled();
    });

    it('applies a Blueprint to a source-only file as a pull request on ever-works/blueprint/<id>', async () => {
        const { service, git, states } = build({ blueprintId: null, blueprintVersion: null });
        git.files[`${WORK_OWNER}/${WORK_REPO}@${WORK_HEAD}:${SPEC}`] = [
            'version: 2',
            'kind: app',
            'spec:',
            '  source:',
            '    relation: fork',
            '    upstream:',
            '      repo: umami-software/umami',
            `    branch: ${TRACKED}`,
            '',
        ].join('\n');
        await service.request({ workId: WORK_ID, mode: 'apply', blueprintId: 'umami' });
        const result = await service.run({ workId: WORK_ID, mode: 'apply', blueprintId: 'umami', version: '0.2.0' });
        expect(result).toMatchObject({ status: 'proposed', conflictCount: 0 });
        expect(git.pulls[git.pulls.length - 1]).toMatchObject({
            head: 'ever-works/blueprint/umami',
            title: 'Apply the umami Blueprint 0.2.0',
        });
        const proposed = yaml.parse(git.fileOn('ever-works/blueprint/umami'));
        expect(proposed.spec.source.relation).toBe('fork');
        expect(proposed.spec.blueprint).toMatchObject({ id: 'umami', version: '0.2.0' });
        expect(proposed.spec.env).toHaveLength(3);
        expect(states.row.blueprintUpgradePr).toMatchObject({ mode: 'apply', fromVersion: null });
    });

    it('marks an apply run that failed as a failed apply, so it can be retried', async () => {
        const { service, git, states, actions } = build({ blueprintId: null, blueprintVersion: null });
        await service.request({ workId: WORK_ID, mode: 'apply', blueprintId: 'umami' });
        delete git.heads[`${WORK_OWNER}/${WORK_REPO}#${TRACKED}`];
        await service.run({ workId: WORK_ID, mode: 'apply', blueprintId: 'umami', version: '0.2.0' });
        expect(states.row).toMatchObject({ blueprintApplyStatus: 'failed', blueprintApplyError: 'trackedBranchMissing' });
        expect(actions()).toContain(APP_BLUEPRINT_RUN_EVENTS.applyFailed);
    });
});

describe('APW-03 T28 — reconcile (the member merged)', () => {
    it('records the new version when the effective spec names it, and only then', async () => {
        const { service, states, actions } = build();
        await service.run({ workId: WORK_ID, mode: 'upgrade', blueprintId: 'umami', version: '0.2.0' });

        states.row.effectiveSpec = { blueprint: { id: 'umami', version: '0.1.0' } };
        await expect(service.reconcile(WORK_ID)).resolves.toBe(false);
        expect(states.row.blueprintVersion).toBe('0.1.0');

        states.row.effectiveSpec = { blueprint: { id: 'umami', version: '0.2.0' } };
        await expect(service.reconcile(WORK_ID)).resolves.toBe(true);
        expect(states.row).toMatchObject({
            blueprintVersion: '0.2.0',
            blueprintSha: BP_HEAD,
            blueprintApplyStatus: 'applied',
            blueprintApplyRef: { kind: 'pull_request', number: 41 },
            blueprintUpgradePr: null,
            blueprintUpgradeStatus: null,
        });
        expect(actions()).toContain(APP_BLUEPRINT_RUN_EVENTS.upgraded);
        // Idempotent.
        await expect(service.reconcile(WORK_ID)).resolves.toBe(false);
    });

    it('is reached from app.spec.applied by the listener', async () => {
        const reconcile = jest.fn(async () => true);
        const listener = new AppBlueprintUpgradeListener({ reconcile } as never);
        await listener.onSpecApplied({ workId: WORK_ID } as never);
        expect(reconcile).toHaveBeenCalledWith(WORK_ID);
        await expect(new AppBlueprintUpgradeListener().onSpecApplied({ workId: WORK_ID } as never)).resolves.toBeUndefined();
    });
});

describe('APW-03 T29 — dismiss', () => {
    it('hides the notice for that version only, and audits it', async () => {
        const { service, states, actions } = build();
        await expect(service.dismiss({ workId: WORK_ID, userId: EDITOR_ID, version: '0.2.0' })).resolves.toEqual({
            status: 'dismissed',
            version: '0.2.0',
        });
        expect(states.row.blueprintUpgradeDismissedVersion).toBe('0.2.0');
        expect(actions()).toEqual([APP_BLUEPRINT_RUN_EVENTS.upgradeDismissed]);
        await expect(service.dismiss({ workId: WORK_ID, version: '0.1.0' })).resolves.toMatchObject({ code: 'noUpgrade' });
    });
});

describe('APW-03 T28 — the job wiring', () => {
    it('binds the dispatcher to the active runtime, and answers null without one', async () => {
        const provider = buildAppBlueprintApplyDispatcherProvider();
        expect(provider.provide).toBe(APP_BLUEPRINT_APPLY_DISPATCHER);
        const dispatchAppBlueprintApply = jest.fn(async () => 'run_9');
        const bound = (provider.useFactory as (r: unknown) => { dispatch: (p: unknown) => Promise<string | null> })({
            getActive: () => ({ dispatchers: { dispatchAppBlueprintApply } }),
        });
        await expect(bound.dispatch({ workId: WORK_ID })).resolves.toBe('run_9');
        const none = (provider.useFactory as (r: unknown) => { dispatch: (p: unknown) => Promise<string | null> })(undefined);
        await expect(none.dispatch({ workId: WORK_ID })).resolves.toBeNull();
        expect(APP_BLUEPRINT_APPLY_JOB_ID).toBe('app-blueprint-apply');
    });

    it('the RPC runner delegates to the service and only exposes run', async () => {
        const run = jest.fn(async () => ({ status: 'proposed' }));
        const runner = new AppBlueprintApplyRunner({ run } as never);
        await runner.run({ workId: WORK_ID, mode: 'upgrade', blueprintId: 'umami', version: '0.2.0' });
        expect(run).toHaveBeenCalled();
        expect(Object.getOwnPropertyNames(AppBlueprintApplyRunner.prototype).filter((name) => name !== 'constructor')).toEqual(['run']);
        await expect(new AppBlueprintApplyRunner().run({ workId: WORK_ID } as never)).resolves.toMatchObject({
            status: 'failed',
            reason: 'dependenciesUnavailable',
        });
    });
});
