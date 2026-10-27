import { beforeEach, describe, expect, it, vi } from 'vitest';

// Network layer mocked — these specs pin the rows, their gates and their body allowlists.
vi.mock('./api-call', () => ({
    callApi: vi.fn(async () => ({ success: true, data: { ok: true } })),
}));

import { callApi } from './api-call';
import { buildGeneratedTools } from './factory';
import { ALL_OPERATIONS } from './registry.all';
import { APP_WORKS_OPERATIONS } from './registry.app-works';
import { createUserConfirmationCheck } from './confirmation';
import { STATIC_TOOL_DOMAINS, selectActiveToolNames } from '../tool-selection';

/**
 * Chat and MCP parity (lane B1, 2026-10-27) — the App Works chat tools for the Deploy, Builds,
 * env, dependencies, App spec, licence, provisioning and upstream routes.
 *
 * Pinned: each row points at the route that exists; reads run at once; every state-changing row
 * is behind the user-turn confirmation of the destructive tools; the person's own decisions
 * ("Sync anyway", a cluster change) are privileged fields with a preview; nothing that would make
 * the model carry a secret or destroy stored data is reachable; and the rows are REACHABLE (their
 * keyword slot) without crowding unrelated turns.
 */

const byName = (toolName: string) => ALL_OPERATIONS.find((op) => op.toolName === toolName);

/** toolName → [method, path] for every row this lane added. */
const ROWS: Record<string, [string, string]> = {
    get_app_status: ['GET', '/api/works/{id}/app-status'],
    refresh_app_status: ['POST', '/api/works/{id}/app-status/refresh'],
    list_app_deployments: ['GET', '/api/works/{id}/app-deployments'],
    request_app_logs: ['POST', '/api/works/{id}/app-logs'],
    get_app_logs: ['GET', '/api/works/{id}/app-logs/{requestId}'],
    get_app_target: ['GET', '/api/works/{id}/app-target'],
    run_app_smoke: ['POST', '/api/works/{id}/app-smoke'],
    run_app_job: ['POST', '/api/works/{id}/app-jobs/{name}/run'],
    deploy_app_work: ['POST', '/api/works/{id}/deploy'],
    rollback_app: ['POST', '/api/works/{id}/app-rollback'],
    change_app_lifecycle: ['POST', '/api/works/{id}/app-lifecycle'],
    get_app_deletion_preview: ['GET', '/api/works/{id}/app-deletion-preview'],
    list_app_builds: ['GET', '/api/works/{id}/builds'],
    get_app_build: ['GET', '/api/works/{id}/builds/{buildId}'],
    request_app_build: ['POST', '/api/works/{id}/builds'],
    cancel_app_build: ['POST', '/api/works/{id}/builds/{buildId}/cancel'],
    get_app_env: ['GET', '/api/works/{id}/app-env'],
    rotate_app_env_value: ['POST', '/api/works/{id}/app-env/{name}/rotate'],
    list_app_dependencies: ['GET', '/api/works/{id}/app-dependencies'],
    configure_app_dependency: ['PUT', '/api/works/{id}/app-dependencies/{kind}'],
    retry_app_dependency: ['POST', '/api/works/{id}/app-dependencies/{kind}/provision'],
    get_app_spec: ['GET', '/api/works/{id}/app-spec'],
    validate_app_spec: ['POST', '/api/works/{id}/app-spec/validate'],
    apply_app_blueprint: ['POST', '/api/works/{id}/app-spec/blueprint'],
    upgrade_app_blueprint: ['POST', '/api/works/{id}/app-spec/blueprint/upgrade'],
    dismiss_app_blueprint_upgrade: ['POST', '/api/works/{id}/app-spec/blueprint/dismiss'],
    get_app_license: ['GET', '/api/works/{id}/app-license'],
    list_app_catalog_entries: ['GET', '/api/apps-catalog'],
    get_app_catalog_entry: ['GET', '/api/apps-catalog/{id}'],
    list_app_blueprints: ['GET', '/api/apps-catalog/blueprints'],
    list_app_licenses: ['GET', '/api/apps-catalog/licenses'],
    cancel_app_provisioning: ['POST', '/api/works/{id}/provision/cancel'],
    get_app_upstream: ['GET', '/api/works/{id}/upstream'],
    sync_app_upstream: ['POST', '/api/works/{id}/upstream/sync'],
    retry_app_readiness: ['POST', '/api/works/{id}/upstream/readiness/retry'],
};

/** Non-GET rows that change nothing about the app, its data or its spend. */
const READ_SHAPED = new Set(['refresh_app_status', 'request_app_logs', 'validate_app_spec']);

/**
 * Routes that accept a secret value or destroy stored data. No chat row may target them: the
 * model would carry the value (and the conversation store keeps tool arguments), or would type
 * the slug the Deploy tab asks a person to type.
 */
const NEVER_CHAT: Array<[string, string]> = [
    ['PUT', '/api/works/{id}/app-env'],
    ['POST', '/api/works/{id}/app-env/import-preview'],
    ['PUT', '/api/works/{id}/builds/pull-token'],
    ['PUT', '/api/works/{id}/app-target'],
    ['POST', '/api/works/{id}/app-target/check'],
    ['DELETE', '/api/works/{id}/app-dependencies/{kind}'],
    ['POST', '/api/works/{id}/app-license/attest'],
];

type Exec = (args: Record<string, unknown>, opts: unknown) => Promise<Record<string, unknown>>;
const run = (tool: unknown, args: Record<string, unknown>) =>
    ((tool as { execute: Exec }).execute as Exec)(args, {});

function toolsConfirming(toolName: string, cardArgs: Record<string, unknown>) {
    return buildGeneratedTools(ALL_OPERATIONS, {
        userConfirmed: createUserConfirmationCheck({
            latestUserText: `Yes, I confirm — proceed with ${toolName} (confirmed: true).`,
            pending: [{ toolName, args: cardArgs }],
        }),
    });
}
const unconfirmedTools = () =>
    buildGeneratedTools(ALL_OPERATIONS, {
        userConfirmed: createUserConfirmationCheck({ latestUserText: 'what is new?', pending: [] }),
    });

beforeEach(() => vi.mocked(callApi).mockClear());

describe('App Works chat rows (lane B1)', () => {
    it.each(Object.entries(ROWS))(
        'registers %s once, against the route that exists',
        (name, [method, path]) => {
            expect(byName(name)).toMatchObject({ method, path });
            expect(ALL_OPERATIONS.filter((op) => op.toolName === name)).toHaveLength(1);
        },
    );

    it('gates every state-changing row; reads and the read-shaped trio run at once', () => {
        for (const name of Object.keys(ROWS)) {
            const op = byName(name)!;
            if (op.method === 'GET' || READ_SHAPED.has(name)) {
                expect(op.requiresConfirmation, name).toBeUndefined();
            } else {
                expect(op.requiresConfirmation, name).toBe(true);
            }
        }
    });

    it('holds the rule for every App Works row, the earlier ones included', () => {
        for (const op of APP_WORKS_OPERATIONS) {
            if (op.method === 'GET' || READ_SHAPED.has(op.toolName)) continue;
            expect(op.requiresConfirmation, op.toolName).toBe(true);
        }
    });

    it.each(NEVER_CHAT)('has no chat row for %s %s', (method, path) => {
        expect(ALL_OPERATIONS.filter((op) => op.method === method && op.path === path)).toEqual([]);
    });

    it('allowlists every App Works body, so a new DTO field never rides along unseen', () => {
        for (const name of Object.keys(ROWS)) {
            const op = byName(name)!;
            if (op.body) expect(op.bodyFields, name).toBeDefined();
        }
    });
});

describe('App Works chat rows — what reaches the API', () => {
    it('a remove never deletes stored data from chat', async () => {
        const args = { id: 'w1', body: { action: 'remove' } };
        const out = await run(toolsConfirming('change_app_lifecycle', args).change_app_lifecycle, {
            id: 'w1',
            body: { action: 'remove', deleteData: true, confirmSlug: 'cal' },
            confirmed: true,
        });
        expect(callApi).toHaveBeenCalledTimes(1);
        expect(callApi).toHaveBeenCalledWith(
            expect.objectContaining({
                method: 'POST',
                path: '/api/works/{id}/app-lifecycle',
                body: { action: 'remove' },
            }),
        );
        expect(out.ignoredFields).toEqual(['deleteData', 'confirmSlug']);
    });

    it('a dependency change never carries provider settings (credentials)', async () => {
        const args = { id: 'w1', kind: 'postgres', body: { sizeGiB: 20 } };
        await run(toolsConfirming('configure_app_dependency', args).configure_app_dependency, {
            id: 'w1',
            kind: 'postgres',
            body: { sizeGiB: 20, config: { password: 'hunter2' } },
            confirmed: true,
        });
        expect(callApi).toHaveBeenCalledWith(expect.objectContaining({ body: { sizeGiB: 20 } }));
    });

    it('a rotation is a card first, then runs once on the user’s own confirmation', async () => {
        const args = { id: 'w1', name: 'SESSION_SECRET', body: { confirmName: 'SESSION_SECRET' } };
        const card = await run(unconfirmedTools().rotate_app_env_value, {
            ...args,
            confirmed: true,
        });
        expect(card.__confirmationRequired).toBe(true);
        expect(callApi).not.toHaveBeenCalled();

        await run(toolsConfirming('rotate_app_env_value', args).rotate_app_env_value, {
            ...args,
            confirmed: true,
        });
        expect(callApi).toHaveBeenCalledTimes(1);
    });

    it('"Sync anyway" is a privileged card that shows the held head being accepted', async () => {
        const card = await run(unconfirmedTools().sync_app_upstream, {
            id: 'w1',
            body: { confirmWorkflowChanges: true, workflowHeadSha: 'abcdef1' },
        });
        expect(card.__confirmationRequired).toBe(true);
        expect(card.confirmationKind).toBe('privileged');
        expect(card.preview).toContain('abcdef1');
        expect(callApi).not.toHaveBeenCalled();
    });

    it('a plain sync is still a card (it writes to the fork)', async () => {
        const card = await run(unconfirmedTools().sync_app_upstream, { id: 'w1' });
        expect(card.__confirmationRequired).toBe(true);
        expect(callApi).not.toHaveBeenCalled();
    });

    it('reads and the log request run at once', async () => {
        const tools = unconfirmedTools();
        await run(tools.get_app_env, { id: 'w1' });
        await run(tools.request_app_logs, { id: 'w1', body: { component: 'web', lines: 50 } });
        expect(callApi).toHaveBeenCalledTimes(2);
        expect(callApi).toHaveBeenLastCalledWith(
            expect.objectContaining({ body: { component: 'web', lines: 50 } }),
        );
    });
});

describe('App Works chat rows are reachable, and stay out of unrelated turns', () => {
    const ALL_NAMES = [
        ...ALL_OPERATIONS.map((op) => op.toolName),
        ...Object.keys(STATIC_TOOL_DOMAINS),
    ];
    const select = (text: string, pageUrl?: string) =>
        selectActiveToolNames(ALL_NAMES, { text, pageUrl });

    it.each([
        ['is my app up?', 'get_app_status'],
        ['show me the logs of the web component', 'request_app_logs'],
        ['show me the logs of the web component', 'get_app_logs'],
        ['run the smoke checks on my app', 'run_app_smoke'],
        ['why did the build fail?', 'list_app_builds'],
        // (Not "SESSION_SECRET": `session` also pulls the large `account` domain in, and on a
        // turn that hits the 128-tool cap the App rows — last in registry order — are cut.)
        ['rotate the APP_SECRET env value', 'rotate_app_env_value'],
        ['which environment variables are not set?', 'get_app_env'],
        ['retry the postgres dependency', 'retry_app_dependency'],
        ['upgrade the blueprint', 'upgrade_app_blueprint'],
        ['sync the fork with upstream', 'sync_app_upstream'],
        ['sync anyway', 'sync_app_upstream'],
        ['which license does it have', 'list_app_licenses'],
        ['can I fork github.com/calcom/cal.com?', 'inspectAppSource'],
        ['roll back the app', 'rollback_app'],
    ])('%j reaches %s', (text, expected) => {
        expect(select(text)).toContain(expected);
    });

    it('is reached from the App Work tabs by their page URL alone', () => {
        expect(select('what is going on here', '/en/works/abc/builds')).toContain(
            'list_app_builds',
        );
        expect(select('what is going on here', '/en/works/abc/upstream')).toContain(
            'get_app_upstream',
        );
    });

    it.each(['rotate my api key', 'approve the pending item', 'what happened yesterday', 'hello'])(
        'leaves the App tools out of %j',
        (text) => {
            const selected = select(text);
            for (const name of ['get_app_status', 'rotate_app_env_value', 'sync_app_upstream']) {
                expect(selected, name).not.toContain(name);
            }
        },
    );
});
