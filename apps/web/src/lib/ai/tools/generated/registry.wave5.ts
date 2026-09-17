import type { OperationSpec } from './registry';

/**
 * Wave 5 — the single-entity mutation tail not covered by Waves 1-4 or the
 * hand-written tools. Hand-authored (small set) with sensible body hints.
 *
 * Deliberately EXCLUDED (policy, not omission): bulk-capture-images,
 * import-items/validate+execute (bulk file import), anonymous uploads,
 * logout-all (acts on all sessions), and redundant aliases (patch_work ==
 * update_work, analyze_repository == analyzeImportSource).
 */
export const WAVE5_OPERATIONS: OperationSpec[] = [
    // Works lifecycle / generation
    {
        toolName: 'generate_work_details',
        method: 'POST',
        path: '/api/works/generate-details',
        summary: 'AI-generate a work’s name and description from a prompt.',
        kind: 'action',
        body: true,
        bodyHint: 'prompt or topic describing the work (string).',
    },
    {
        toolName: 'cancel_generation',
        method: 'POST',
        path: '/api/works/{id}/cancel-generation',
        summary: 'Cancel a work’s in-progress item generation.',
        kind: 'action',
        params: [
            { name: 'id', in: 'path', required: true, type: 'string', description: 'Work id' },
        ],
        requiresConfirmation: true,
    },
    {
        toolName: 'update_readme',
        method: 'POST',
        path: '/api/works/{id}/update-readme',
        summary: 'Regenerate / update a work’s README.',
        kind: 'action',
        params: [
            { name: 'id', in: 'path', required: true, type: 'string', description: 'Work id' },
        ],
        body: true,
        bodyHint: 'optional content / config; usually no body needed.',
    },
    {
        toolName: 'analyze_repository_for_linking',
        method: 'POST',
        path: '/api/works/import/analyze-for-linking',
        summary: 'Analyze a repository to link it to a work.',
        kind: 'action',
        body: true,
        bodyHint: 'repository URL (and optional provider).',
    },
    {
        toolName: 'process_community_prs',
        method: 'POST',
        path: '/api/works/{id}/process-community-prs',
        summary: 'Process pending community pull requests for a work.',
        kind: 'action',
        params: [
            { name: 'id', in: 'path', required: true, type: 'string', description: 'Work id' },
        ],
    },

    // Webhooks
    {
        toolName: 'redeliver_webhook',
        method: 'POST',
        path: '/api/webhooks/deliveries/{deliveryId}/redeliver',
        summary: 'Re-send a previous webhook delivery.',
        kind: 'action',
        params: [
            {
                name: 'deliveryId',
                in: 'path',
                required: true,
                type: 'string',
                description: 'Delivery id',
            },
        ],
    },

    // Templates
    {
        toolName: 'update_custom_template',
        method: 'PUT',
        path: '/api/templates/custom/{templateId}',
        summary: 'Update a custom website template.',
        kind: 'update',
        params: [
            {
                name: 'templateId',
                in: 'path',
                required: true,
                type: 'string',
                description: 'Template id',
            },
        ],
        body: true,
        bodyHint: 'Any of: name, settings.',
    },

    // Organizations
    {
        toolName: 'register_company',
        method: 'POST',
        path: '/api/organizations/register-company',
        summary: 'Register a company organization.',
        kind: 'create',
        body: true,
        bodyHint: 'name (required), slug, plus company profile fields.',
    },
    {
        toolName: 'upgrade_organization_from_account',
        method: 'POST',
        path: '/api/organizations/{id}/upgrade-from-account',
        summary: 'Upgrade the personal account into an organization.',
        kind: 'action',
        params: [
            {
                name: 'id',
                in: 'path',
                required: true,
                type: 'string',
                description: 'Organization id',
            },
        ],
        body: true,
        bodyHint: 'name, slug.',
        requiresConfirmation: true,
    },

    // Work membership
    {
        toolName: 'leave_work',
        method: 'POST',
        path: '/api/works/{workId}/members/leave',
        summary: 'Leave a work you are a member of.',
        kind: 'destructive',
        params: [
            { name: 'workId', in: 'path', required: true, type: 'string', description: 'Work id' },
        ],
        requiresConfirmation: true,
    },

    // Task attachments
    {
        toolName: 'add_task_attachment',
        method: 'POST',
        path: '/api/tasks/{id}/attachments',
        summary: 'Attach an existing upload to a task.',
        kind: 'create',
        params: [
            { name: 'id', in: 'path', required: true, type: 'string', description: 'Task id' },
        ],
        body: true,
        bodyHint: 'uploadId (the sha256 id of a previously uploaded file).',
    },
    {
        toolName: 'remove_task_attachment',
        method: 'DELETE',
        path: '/api/tasks/{id}/attachments/{attachmentId}',
        summary: 'Remove an attachment from a task.',
        kind: 'destructive',
        params: [
            { name: 'id', in: 'path', required: true, type: 'string', description: 'Task id' },
            {
                name: 'attachmentId',
                in: 'path',
                required: true,
                type: 'string',
                description: 'Attachment id',
            },
        ],
        requiresConfirmation: true,
    },

    // Notification preferences
    {
        toolName: 'set_event_subscription',
        method: 'PUT',
        path: '/api/notifications/preferences/event/{eventKey}',
        summary: 'Update notification settings for a specific event type.',
        kind: 'update',
        params: [
            {
                name: 'eventKey',
                in: 'path',
                required: true,
                type: 'string',
                description: 'Event type key',
            },
        ],
        body: true,
        bodyHint: 'enabled (boolean) and/or channels (array of channel ids).',
    },

    // Memory facts (AW-07) — "remember…" in chat lands as an ACTIVE fact
    // because the author is the person in their own conversation. Not behind
    // confirmation: it is exactly what they asked for, it is reversible (every
    // fact can be forgotten and restored), and the reply reads the stored
    // wording back so a wrong capture is caught on the spot.
    {
        toolName: 'remember_fact',
        method: 'POST',
        path: '/api/memory/facts',
        summary:
            'Remember one durable fact for every agent in this workspace, when the user says "remember…" or asks you to keep something in mind. Store one atomic statement per call, in the words the user used. The response carries the stored wording — read it back to the user in one line so they can check it.',
        kind: 'create',
        body: true,
        bodyHint:
            'body (string, required, 1-500 characters: the exact wording to store); pinned (optional boolean: send it with every run).',
    },
    {
        toolName: 'list_memory_facts',
        method: 'GET',
        path: '/api/memory/facts',
        summary:
            'List or search the facts remembered in this workspace. With q, matches by meaning as well as by exact words.',
        kind: 'read',
        params: [
            { name: 'q', in: 'query', type: 'string', description: 'What to look for' },
            {
                name: 'status',
                in: 'query',
                type: 'string',
                description: 'active (default), proposed or forgotten',
            },
            {
                name: 'limit',
                in: 'query',
                type: 'number',
                description: 'Max facts to return (1-50)',
            },
        ],
    },
];
