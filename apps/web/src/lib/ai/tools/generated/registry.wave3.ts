import type { OperationSpec } from './registry';

/**
 * Wave 3 - remaining READ (GET) tools, generated deterministically from the
 * operations inventory (GET takes no body, so no DTO guesswork). Deduped by
 * GET path against Waves 1-2 and the hand-written read tools. These power
 * 'show me / ask / report' flows and feed the canvas renderers.
 */
export const WAVE3_OPERATIONS: OperationSpec[] = [
    {
        toolName: 'get_export_items_settings',
        method: 'GET',
        path: '/api/works/{id}/export-items/settings',
        summary: 'Get export feature flag',
        kind: 'read',
        params: [
            {
                name: 'id',
                in: 'path',
                required: true,
                type: 'string',
            },
        ],
    },
    {
        toolName: 'export_work_items',
        method: 'GET',
        path: '/api/works/{id}/export-items',
        summary: 'Export work items as CSV or Excel',
        kind: 'read',
        params: [
            {
                name: 'id',
                in: 'path',
                required: true,
                type: 'string',
            },
        ],
    },
    {
        toolName: 'get_import_items_settings',
        method: 'GET',
        path: '/api/works/{id}/import-items/settings',
        summary: 'Get import feature flag and max rows',
        kind: 'read',
        params: [
            {
                name: 'id',
                in: 'path',
                required: true,
                type: 'string',
            },
        ],
    },
    {
        toolName: 'get_import_items_sample',
        method: 'GET',
        path: '/api/works/{id}/import-items/sample',
        summary: 'Download item import template',
        kind: 'read',
        params: [
            {
                name: 'id',
                in: 'path',
                required: true,
                type: 'string',
            },
        ],
    },
    {
        toolName: 'get_global_generator_form_schema',
        method: 'GET',
        path: '/api/generator-form',
        summary: 'Get global generator form schema',
        kind: 'read',
    },
    {
        toolName: 'get_user_repositories',
        method: 'GET',
        path: '/api/works/import/repositories',
        summary: 'List user repositories',
        kind: 'read',
        canvas: 'RepositoriesList',
    },
    {
        toolName: 'list_git_providers',
        method: 'GET',
        path: '/api/git-providers',
        summary: 'List available git providers',
        kind: 'read',
    },
    {
        toolName: 'get_github_app_setup',
        method: 'GET',
        path: '/api/github-app/setup',
        summary: 'Begin GitHub App installation setup',
        kind: 'read',
    },
    {
        toolName: 'list_oauth_providers',
        method: 'GET',
        path: '/api/oauth/providers',
        summary: 'List available OAuth providers',
        kind: 'read',
    },
    {
        toolName: 'get_oauth_auth_url',
        method: 'GET',
        path: '/api/oauth/{providerId}/url',
        summary: 'Generate OAuth authorization URL for user login',
        kind: 'read',
        params: [
            {
                name: 'providerId',
                in: 'path',
                required: true,
                type: 'string',
            },
        ],
    },
    {
        toolName: 'list_agent_templates',
        method: 'GET',
        path: '/api/agent-templates',
        summary: 'List agent templates from the ever-works/agents catalog',
        kind: 'read',
        canvas: 'TemplateGallery',
    },
    {
        toolName: 'list_task_attachments',
        method: 'GET',
        path: '/api/tasks/{id}/attachments',
        summary: 'List task attachments (FK pointers to work_knowledge_upload rows)',
        kind: 'read',
        params: [
            {
                name: 'id',
                in: 'path',
                required: true,
                type: 'string',
            },
        ],
        canvas: 'AttachmentListCard',
    },
    {
        toolName: 'get_skill_catalog_entry',
        method: 'GET',
        path: '/api/skills/catalog/{slug}',
        summary: 'Get one catalog skill entry by slug',
        kind: 'read',
        params: [
            {
                name: 'slug',
                in: 'path',
                required: true,
                type: 'string',
            },
        ],
        canvas: 'SkillDetailCard',
    },
    {
        toolName: 'get_work_member',
        method: 'GET',
        path: '/api/works/{workId}/members/{memberId}',
        summary: 'Get a specific work member',
        kind: 'read',
        params: [
            {
                name: 'workId',
                in: 'path',
                required: true,
                type: 'string',
            },
            {
                name: 'memberId',
                in: 'path',
                required: true,
                type: 'string',
            },
        ],
        canvas: 'MemberDetailCard',
    },
    {
        toolName: 'get_auth_providers',
        method: 'GET',
        path: '/api/auth/providers',
        summary: 'Get configured authentication providers',
        kind: 'read',
        canvas: 'ProviderConfigCard',
    },
    {
        toolName: 'get_fresh_user_profile',
        method: 'GET',
        path: '/api/auth/profile/fresh',
        summary: 'Get fresh user profile from database',
        kind: 'read',
        canvas: 'UserProfileCard',
    },
    {
        toolName: 'export_work_usage_csv',
        method: 'GET',
        path: '/api/works/{workId}/usage/export',
        summary: 'Download per-Work usage events as CSV for the billing period',
        kind: 'read',
        params: [
            {
                name: 'workId',
                in: 'path',
                required: true,
                type: 'string',
            },
        ],
    },
    {
        toolName: 'get_admin_usage_report',
        method: 'GET',
        path: '/admin/usage',
        summary:
            'Cross-user and cross-Work spend for self-hosted platform admins (requires platform admin role)',
        kind: 'read',
        canvas: 'AdminUsageTable',
    },
    {
        toolName: 'export_activity_log_csv',
        method: 'GET',
        path: '/api/activity-log/export',
        summary: 'Export activity log entries as CSV file',
        kind: 'read',
    },
    {
        toolName: 'serve_upload',
        method: 'GET',
        path: '/api/uploads/{userId}/{filename}',
        summary: 'Serve previously uploaded file (owner-only access)',
        kind: 'read',
        params: [
            {
                name: 'userId',
                in: 'path',
                required: true,
                type: 'string',
            },
            {
                name: 'filename',
                in: 'path',
                required: true,
                type: 'string',
            },
        ],
    },
];
