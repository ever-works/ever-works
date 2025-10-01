/**
 * GitHub OAuth Scopes Configuration
 * https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps
 */

export const GitHubScopes = {
    // Basic user info
    USER: ['user:email', 'read:user'],

    // Repository permissions
    REPO_READ: ['public_repo'],
    REPO_FULL: ['repo', 'delete_repo'], // Full control of private repositories

    // Repository sub-permissions
    REPO_STATUS: ['repo:status'], // Commit statuses
    REPO_DEPLOYMENT: ['repo_deployment'], // Deployment statuses
    REPO_INVITE: ['repo:invite'], // Repository invitations

    // Workflow permissions
    WORKFLOW: ['workflow'], // Update GitHub Action workflows

    // Organization permissions
    ORG_READ: ['read:org'],
    ORG_WRITE: ['write:org'],
    ORG_ADMIN: ['admin:org'],

    // Package permissions
    PACKAGES: ['write:packages', 'read:packages', 'delete:packages'],

    // GPG key permissions
    GPG: ['admin:gpg_key'],

    // Public key permissions
    PUBLIC_KEY: ['admin:public_key'],

    // Repository hooks
    HOOKS: ['admin:repo_hook', 'write:repo_hook', 'read:repo_hook'],

    // Notifications
    NOTIFICATIONS: ['notifications'],

    // Gists
    GIST: ['gist'],

    // Projects
    PROJECT: ['read:project', 'write:project'],
};

/**
 * Scope presets for common use cases
 */
export const GitHubScopePresets = {
    // Basic read-only access
    BASIC: [...GitHubScopes.USER, ...GitHubScopes.REPO_READ],

    // Developer access - create repos, push code
    DEVELOPER: [
        ...GitHubScopes.USER,
        ...GitHubScopes.REPO_FULL,
        ...GitHubScopes.REPO_STATUS,
        'read:org',
    ],

    // CI/CD access - manage workflows, deployments, secrets
    CICD: [
        ...GitHubScopes.USER,
        ...GitHubScopes.REPO_FULL,
        ...GitHubScopes.REPO_STATUS,
        ...GitHubScopes.REPO_DEPLOYMENT,
        ...GitHubScopes.WORKFLOW,
        'admin:repo_hook',
    ],

    // Full admin access
    ADMIN: [
        ...GitHubScopes.USER,
        ...GitHubScopes.REPO_FULL,
        ...GitHubScopes.REPO_STATUS,
        ...GitHubScopes.REPO_DEPLOYMENT,
        ...GitHubScopes.WORKFLOW,
        ...GitHubScopes.HOOKS,
        ...GitHubScopes.ORG_ADMIN,
        ...GitHubScopes.PACKAGES,
        ...GitHubScopes.PROJECT,
    ],

    // Agent-specific preset for Ever Works
    AGENT: [
        'user:email',
        'read:user',
        'repo', // Full control of private repositories
        'delete_repo', // Delete repositories
        'workflow', // Update GitHub Action workflows
        'write:repo_hook', // Create webhooks
        'read:org', // Read org membership
        'project', // Full project access
    ],
};

/**
 * Get human-readable descriptions for scopes
 */
export const GitHubScopeDescriptions: Record<string, string> = {
    repo: 'Full control of private and public repositories',
    public_repo: 'Access public repositories',
    'repo:status': 'Access commit status',
    repo_deployment: 'Access deployment status',
    'repo:invite': 'Access repository invitations',
    workflow: 'Update GitHub Action workflows',
    'write:packages': 'Upload packages to GitHub Package Registry',
    'read:packages': 'Download packages from GitHub Package Registry',
    'delete:packages': 'Delete packages from GitHub Package Registry',
    'admin:org': 'Full control of orgs and teams, read and write org projects',
    'write:org': 'Read and write org and team membership, read and write org projects',
    'read:org': 'Read org and team membership, read org projects',
    'admin:public_key': 'Full control of user public keys',
    'write:public_key': 'Create user public keys',
    'read:public_key': 'Access user public keys',
    'admin:repo_hook': 'Full control of repository hooks',
    'write:repo_hook': 'Write repository hooks',
    'read:repo_hook': 'Read repository hooks',
    'admin:org_hook': 'Full control of organization hooks',
    gist: 'Create gists',
    notifications: 'Access notifications',
    user: 'Update ALL user data',
    'read:user': 'Access user profile data',
    'user:email': 'Access user email addresses',
    project: 'Full control of projects',
    'read:project': 'Read access to projects',
};

/**
 * Check if a token has all required scopes for agent operations
 */
export function hasRequiredAgentScopes(currentScopes: string[]): {
    hasAll: boolean;
    missing: string[];
} {
    const required = GitHubScopePresets.AGENT;
    const missing = required.filter((scope) => !currentScopes.includes(scope));

    return {
        hasAll: missing.length === 0,
        missing,
    };
}
