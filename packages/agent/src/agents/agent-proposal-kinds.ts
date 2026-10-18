/**
 * Prompt-injection hardening — the platform-written `payload.kind` values of
 * the Agent Action Approval Queue proposals that stand in for an Agent action
 * which used to take effect immediately (`resolve_escalation`,
 * `editAgentFile`).
 *
 * A LEAF file on purpose (no runtime imports): the chat-tool factories that
 * file these proposals must not gain the runtime graph of the listener that
 * applies them (`AgentProposalExecutionListener` pulls the escalation service,
 * and through it the AI facade).
 */
export const AGENT_ESCALATION_RESOLUTION_PROPOSAL_KIND = 'agent-escalation-resolution' as const;
export const AGENT_FILE_EDIT_PROPOSAL_KIND = 'agent-file-edit' as const;
