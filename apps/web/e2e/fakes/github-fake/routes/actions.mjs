/**
 * GitHub Actions routes for the APW-13 fake GitHub (task T2, plan §8.3).
 *
 * Covers the consumer-derived rows of plan §8.3 that belong to Actions:
 * workflow listing, **disable/enable per workflow id** (APW-02's Actions
 * hygiene), the Actions-secrets public key and secret write (APW-05's build
 * secrets), and runs / a run / its jobs / its artifacts (APW-05's
 * `run-observer` and result artifact).
 *
 * `POST …/actions/workflows/:id/dispatches` is served too: APW-05's
 * `dispatchWorkflow` exists in `packages/plugins/github/src/github-actions.service.ts`
 * and a lane that writes a build workflow must be able to dispatch it. It is an
 * additive route beyond the plan's table, recorded as such in
 * `fixtures/README.md`.
 */

const NOT_FOUND = { status: 404, body: { message: 'Not Found' } };

function sha(seed) {
    let hash = 0x811c9dc5;
    for (const ch of String(seed)) {
        hash ^= ch.charCodeAt(0);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0').repeat(5).slice(0, 40);
}

function requireRepo(ctx) {
    const repo = ctx.locate(ctx.params.owner, ctx.params.repo);
    if (!repo) return { error: NOT_FOUND };
    return { repo };
}

function requireRun(ctx, repo) {
    const run = repo.workflowRuns.find(
        (candidate) => String(candidate.id) === String(ctx.params.runId),
    );
    if (!run) return { error: NOT_FOUND };
    return { run };
}

/** The public key `libsodium` needs; the fake never uses it to encrypt anything. */
const PUBLIC_KEY = {
    key_id: 'apw-e2e-fake-key-id-0001',
    key: 'YXB3LWUyZS1mYWtlLWdpdGh1Yi1wdWJsaWMta2V5LW5vdC1yZWFsbHktdXNlZA==',
};

export const routes = [
    {
        name: 'get-actions-permissions',
        method: 'GET',
        pattern: '/repos/:owner/:repo/actions/permissions',
        fixture: 'actions-permissions',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            return { status: 200, body: { ...repo.actionsPermissions } };
        },
    },
    {
        name: 'set-actions-permissions',
        method: 'PUT',
        pattern: '/repos/:owner/:repo/actions/permissions',
        fixture: 'actions-permissions-put',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            repo.actionsPermissions = {
                enabled: ctx.jsonBody?.enabled ?? repo.actionsPermissions.enabled,
                allowed_actions:
                    ctx.jsonBody?.allowed_actions ?? repo.actionsPermissions.allowed_actions,
                selected_actions_url: null,
            };
            return { status: 204, body: null };
        },
    },
    {
        name: 'list-actions-workflows',
        method: 'GET',
        pattern: '/repos/:owner/:repo/actions/workflows',
        fixture: 'actions-workflows',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            if (repo.workflows.length === 0) {
                repo.workflows.push(
                    {
                        id: 900001,
                        name: 'ever-works-build',
                        path: '.github/workflows/ever-works-build.yml',
                        state: 'active',
                    },
                    {
                        id: 900002,
                        name: 'upstream-ci',
                        path: '.github/workflows/upstream-ci.yml',
                        state: 'active',
                    },
                );
            }
            return {
                status: 200,
                body: {
                    total_count: repo.workflows.length,
                    workflows: repo.workflows.map((workflow) =>
                        ctx.projectWorkflow(repo, workflow),
                    ),
                },
            };
        },
    },
    {
        name: 'disable-actions-workflow',
        method: 'PUT',
        pattern: '/repos/:owner/:repo/actions/workflows/:workflowId/disable',
        fixture: 'workflow-disable',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            const workflow = repo.workflows.find(
                (candidate) => String(candidate.id) === String(ctx.params.workflowId),
            );
            if (!workflow) return NOT_FOUND;
            workflow.state = 'disabled_manually';
            return { status: 204, body: null };
        },
    },
    {
        name: 'enable-actions-workflow',
        method: 'PUT',
        pattern: '/repos/:owner/:repo/actions/workflows/:workflowId/enable',
        fixture: 'workflow-enable',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            const workflow = repo.workflows.find(
                (candidate) => String(candidate.id) === String(ctx.params.workflowId),
            );
            if (!workflow) return NOT_FOUND;
            workflow.state = 'active';
            return { status: 204, body: null };
        },
    },
    {
        name: 'dispatch-actions-workflow',
        method: 'POST',
        pattern: '/repos/:owner/:repo/actions/workflows/:workflowId/dispatches',
        fixture: 'workflow-dispatch',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            const workflow = repo.workflows.find(
                (candidate) => String(candidate.id) === String(ctx.params.workflowId),
            );
            if (!workflow) return NOT_FOUND;
            const id = 950000 + repo.workflowRuns.length + 1;
            repo.workflowRuns.push({
                id,
                name: workflow.name,
                workflowId: workflow.id,
                status: 'queued',
                conclusion: null,
                headSha: ctx.jsonBody?.head_sha ?? sha(`${repo.owner}/${repo.name}/dispatched`),
                headBranch: ctx.jsonBody?.ref ?? repo.defaultBranch,
                runNumber: repo.workflowRuns.length + 1,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                startedAt: new Date().toISOString(),
                jobs: [],
            });
            return { status: 204, body: null };
        },
    },
    {
        name: 'get-actions-secret-public-key',
        method: 'GET',
        pattern: '/repos/:owner/:repo/actions/secrets/public-key',
        fixture: 'actions-secret-public-key',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            return { status: 200, body: { ...PUBLIC_KEY } };
        },
    },
    {
        name: 'put-actions-secret',
        method: 'PUT',
        pattern: '/repos/:owner/:repo/actions/secrets/:secretName',
        fixture: 'actions-secret-put',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            // The value is encrypted with the fake's public key, so it is opaque
            // here — the fake stores the ciphertext, never a plaintext secret,
            // which is what keeps a leaked attachment scan meaningful.
            repo.actionsSecrets.set(ctx.params.secretName, {
                encrypted_value: String(ctx.jsonBody?.encrypted_value ?? ''),
                key_id: String(ctx.jsonBody?.key_id ?? ''),
            });
            return { status: 201, body: null };
        },
    },
    {
        name: 'list-workflow-runs',
        method: 'GET',
        pattern: '/repos/:owner/:repo/actions/runs',
        fixture: 'actions-runs',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            seedRuns(repo);
            const runs = repo.workflowRuns.map((run) => ctx.projectRun(repo, run));
            return {
                status: 200,
                body: { total_count: runs.length, workflow_runs: runs },
            };
        },
    },
    {
        name: 'get-workflow-run',
        method: 'GET',
        pattern: '/repos/:owner/:repo/actions/runs/:runId',
        fixture: 'actions-run',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            seedRuns(repo);
            const { run, error: runError } = requireRun(ctx, repo);
            if (runError) return runError;
            return { status: 200, body: ctx.projectRun(repo, run) };
        },
    },
    {
        name: 'list-workflow-run-jobs',
        method: 'GET',
        pattern: '/repos/:owner/:repo/actions/runs/:runId/jobs',
        fixture: 'actions-run-jobs',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            seedRuns(repo);
            const { run, error: runError } = requireRun(ctx, repo);
            if (runError) return runError;
            const jobs = run.jobs.map((job) => ctx.projectJob(repo, job));
            return { status: 200, body: { total_count: jobs.length, jobs } };
        },
    },
    {
        name: 'list-workflow-run-artifacts',
        method: 'GET',
        pattern: '/repos/:owner/:repo/actions/runs/:runId/artifacts',
        fixture: 'actions-run-artifacts',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            seedRuns(repo);
            const { run, error: runError } = requireRun(ctx, repo);
            if (runError) return runError;
            return {
                status: 200,
                body: {
                    total_count: 1,
                    artifacts: [
                        {
                            id: 990000 + run.id,
                            name: 'build-result',
                            size_in_bytes: 4096,
                            archive_download_url: `${ctx.origin}/repos/${repo.owner}/${repo.name}/actions/artifacts/${990000 + run.id}/zip`,
                            expired: false,
                            created_at: run.updatedAt,
                            expires_at: run.updatedAt,
                        },
                    ],
                },
            };
        },
    },
];

/**
 * A repository that has never run a workflow still answers one completed run,
 * so APW-05's `run-observer` has a deterministic success to observe without a
 * spec having to stage it.
 */
function seedRuns(repo) {
    if (repo.workflowRuns.length > 0) return;
    const head = sha(`${repo.owner}/${repo.name}/build-head`);
    const created = repo.pushedAt;
    repo.workflowRuns.push({
        id: 960001,
        name: 'ever-works-build',
        workflowId: 900001,
        status: 'completed',
        conclusion: 'success',
        headSha: head,
        headBranch: repo.defaultBranch,
        runNumber: 1,
        createdAt: created,
        updatedAt: created,
        startedAt: created,
        jobs: [
            {
                id: 970001,
                runId: 960001,
                name: 'build',
                status: 'completed',
                conclusion: 'success',
                startedAt: created,
                completedAt: created,
                steps: [
                    { name: 'Set up job', status: 'completed', conclusion: 'success', number: 1 },
                    { name: 'docker build', status: 'completed', conclusion: 'success', number: 2 },
                    { name: 'push image', status: 'completed', conclusion: 'success', number: 3 },
                ],
            },
        ],
    });
}
