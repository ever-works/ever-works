// Public surface of the merge-policy matrix (Wave 3, founder decision
// D4): the pure resolution + decision functions, the read-only scope
// repository, the Nest service that is BOTH the one resolution function
// and the one decision point, the `MERGE_POLICY_ENFORCER` token the git
// facade consumes, and the `resolve_merge_policy` chat-tool factory.
export * from './merge-policy';
export * from './merge-policy.enforcer';
export * from './merge-policy.repository';
export * from './merge-policy.service';
export * from './agent-merge-policy-tools';
export * from './policy.module';
