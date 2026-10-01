/**
 * Agents/Skills/Tasks PR #1017 — Phase 16.6 + 16.7.
 *
 * Token + contract for the Agent `commitToRepo` and `openPullRequest`
 * tools. Same circular-dep dodge as `task-dispatcher.ts` (Phase 15.3 /
 * 15.4) and `agent-run-post-processor.ts` (Phase 15.5): the
 * `agent-tool.service.ts` injects this via `@Optional()` so that
 * unit tests + non-API contexts can build the descriptor list without
 * a runtime `GitFacadeService` dependency.
 *
 * The platform-side adapter resolves the Work's repo provider + dir +
 * auth from `GitFacadeService`'s lookup helpers and forwards. When
 * the token is unbound the two tools are simply not included in the
 * Agent's tool descriptor list — the model never sees them.
 */

/**
 * Input for the `commitToRepo` Agent tool. Stays semantic — the
 * adapter is responsible for resolving the actual provider, repo dir,
 * branch, and committer identity from the Work's git settings.
 */
export interface AgentCommitToRepoInput {
    userId: string;
    agentId: string;
    /** Work id whose git provider settings drive the commit target. */
    workId: string;
    /** Commit message (must already be agent-authored — no signature spoofing). */
    message: string;
    /**
     * Optional file edits to stage before committing. When omitted, the
     * adapter commits whatever is currently staged via prior `addAll`
     * calls. The tool is intentionally narrow — Agents commit batches
     * of edits they've already produced via `editAgentFile` or KB-write
     * tools, not arbitrary unstaged changes.
     */
    files?: { path: string; body: string }[];
    /**
     * Branch name to commit against.
     *
     * **Pass a feature branch.** When omitted, the target is the Work's Task base
     * branch (`taskIsolationBaseBranch` when the Work declares one, else the
     * repository's own default branch) and the adapter then REFUSES the commit,
     * because that branch is protected — `main`, `master` and `stage` are a
     * non-configurable floor (APW-08 P0), and the Work's effective merge policy
     * can protect more at any scope, never fewer. An Agent push straight to a
     * release branch is the thing the refusal exists to make impossible; commit
     * to a feature branch and open a pull request instead.
     */
    branch?: string;
}

export interface AgentCommitToRepoResult {
    /** Resulting commit SHA, or null when nothing was staged. */
    sha: string | null;
    branch: string;
    filesChanged: number;
}

/**
 * Input for the `openPullRequest` Agent tool. Mirrors the semantic
 * shape — adapter resolves owner / repo / token from Work settings.
 */
export interface AgentOpenPullRequestInput {
    userId: string;
    agentId: string;
    workId: string;
    title: string;
    body: string;
    /**
     * Head branch (the branch the Agent committed to). It must EXIST in the Work
     * Repository: the adapter asks the provider for its branch list and refuses
     * with FR-5's copy — naming the missing branch and the repository — when it
     * does not, before any pull request is opened (APW-08 P0).
     */
    head: string;
    /**
     * Base branch. Defaults to the Work's Task base branch
     * (`taskIsolationBaseBranch` when the Work declares one, else the
     * repository's own default branch) — never a literal `main`.
     */
    base?: string;
    draft?: boolean;
}

export interface AgentOpenPullRequestResult {
    number: number;
    url: string;
    state: 'open' | 'closed' | 'merged' | 'draft';
}

export interface AgentGitFacade {
    commitToRepo(input: AgentCommitToRepoInput): Promise<AgentCommitToRepoResult>;
    openPullRequest(input: AgentOpenPullRequestInput): Promise<AgentOpenPullRequestResult>;
}

export const AGENT_GIT_FACADE = 'AGENT_GIT_FACADE' as const;
