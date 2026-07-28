// Public surface of the merge-policy matrix (Wave 3, founder decision
// D4): the pure resolution + decision functions, the read-only scope
// repository, the Nest service that is BOTH the one resolution function
// and the one decision point, the `MERGE_POLICY_ENFORCER` token the git
// facade consumes, and the `resolve_merge_policy` chat-tool factory.
export * from './merge-policy';
export * from './merge-policy.enforcer';
export * from './merge-policy.repository';
export * from './merge-policy.service';
// Quality gates — the PR gate every non-worker `createPullRequest` caller
// routes through (audit W3 M3).
export * from './pull-request-gate.service';
export * from './agent-merge-policy-tools';

// Tool-grant matrix (audit item G4) + grant-aware skill activation (G12)
// + `{{cred.key}}` interpolation (G14). Same shape: pure resolution and
// decision functions, a feature-owned repository, the service that is the
// single decision point, the `TOOL_GRANT_ENFORCER` token its consumers
// depend on, and the `resolve_tool_grants` / `check_tool_grant` chat-tool
// factory.
export * from './tool-grant';
export * from './tool-grant.enforcer';
export * from './tool-grant.repository';
export * from './tool-grant.service';
export * from './agent-tool-grant-tools';
export * from './skill-activation';
export * from './credential-interpolation';
export * from './credential-resolver';
export * from './tool-credentials';

export * from './policy.module';
