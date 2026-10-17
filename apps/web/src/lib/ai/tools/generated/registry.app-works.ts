import type { OperationSpec } from './registry';

/**
 * APW-08 T26 (web half) — the App Works chat tools, so the docked assistant on an App Work
 * ("Chat about this App") can change the app, not just talk about it.
 *
 * `request_app_change` is plan §4's row: `POST /api/works/{id}/evolve` files a Task on the
 * App Work and starts an agent run that edits the fork on a branch and opens a pull request.
 * It is behind confirmation (it starts a paid run). The answer carries `taskUrl`, and
 * `list_app_changes` carries `prUrl` once the run opened one — so the reply can link both.
 *
 * Keyword slot: the `appworks` domain in `tool-selection.ts` (APW08-G20) — a generated row
 * with no slot is gated out of every turn.
 */
const workIdParam = {
    name: 'id',
    in: 'path' as const,
    required: true,
    type: 'string' as const,
    description: 'The App Work id (the Work this conversation is about).',
};

export const APP_WORKS_OPERATIONS: OperationSpec[] = [
    {
        toolName: 'request_app_change',
        method: 'POST',
        path: '/api/works/{id}/evolve',
        summary:
            'Ask an agent to change an App Work (a running app): creates a Task on it with the request as the ' +
            'brief and starts a run that edits the app’s repository on a branch and opens a pull request for ' +
            'review. Returns taskId and taskUrl (link the Task in the reply). A 409 agentRequired answer lists ' +
            'candidate agents — ask which one, then call again with agentId; with createFromTemplate, offer to ' +
            'create one by calling again with createAgentFromTemplate: true.',
        kind: 'action',
        params: [workIdParam],
        body: true,
        bodyHint:
            'request (what to change, in the user’s words verbatim, 1–4000 chars), agentId (optional), ' +
            'createAgentFromTemplate (optional boolean, owner only), channel: "chat".',
        requiresConfirmation: true,
        canvas: 'TaskDetail',
    },
    {
        toolName: 'list_app_changes',
        method: 'GET',
        path: '/api/works/{id}/evolve',
        summary:
            'List the change requests of an App Work, newest first, with each Task’s status, taskUrl, branch, ' +
            'pull request link (prUrl) and CI state — use it to report where a requested change got to.',
        kind: 'read',
        params: [
            workIdParam,
            { name: 'limit', in: 'query', type: 'number', description: '1–100, default 20' },
        ],
    },
    {
        toolName: 'provision_app_work',
        method: 'POST',
        path: '/api/works/{id}/provision',
        summary:
            'Work out how to build and run an App Work’s repository and write its App spec: inspects the ' +
            'repository, drafts and validates .works/works.yml and files a provisioning Task for an agent. ' +
            'dryRun: true only inspects.',
        kind: 'action',
        params: [workIdParam],
        body: true,
        bodyHint:
            'note (optional, ≤ 500 chars), agentId (optional), restart (optional), dryRun (optional boolean).',
        requiresConfirmation: true,
    },
    {
        toolName: 'get_app_provisioning',
        method: 'GET',
        path: '/api/works/{id}/provisioning',
        summary:
            'The open and recent provisioning Tasks of an App Work (status, pull request link).',
        kind: 'read',
        params: [workIdParam],
    },
];
