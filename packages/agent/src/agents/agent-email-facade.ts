/**
 * Notifications v2 (EW-650 / EW-670) — token + contract for the Agent
 * `sendEmail` (T23) and `messageAgent` (T24) tools.
 *
 * Same circular-dep dodge as `agent-git-facade.ts`: the
 * `agent-tool.service.ts` injects this via `@Optional() @Inject(AGENT_EMAIL_FACADE)`
 * so unit tests + non-API contexts can build the descriptor list
 * without a runtime `EmailFacadeService` dependency. The platform-side
 * adapter forwards to `EmailFacadeService` (packages/agent/src/facades/email.facade.ts),
 * resolving the Agent's outbound assignment + tenant address.
 *
 * When the token is unbound the tools are simply omitted from the
 * Agent's descriptor list — the model never sees them.
 */

/**
 * Input for the `sendEmail` Agent tool. Stays semantic — the adapter
 * resolves the actual from-address + provider from the Agent's
 * `agent_email_assignments` (lowest-priority outbound = default).
 */
/**
 * Handle for a registered React-Email template. When provided, the
 * adapter renders it server-side (via `@ever-works/email-templates`)
 * into the HTML + text bodies — the Agent supplies structured `props`
 * instead of raw HTML.
 */
export interface AgentEmailTemplateRef {
    slug: string;
    props: Record<string, unknown>;
}

export interface AgentSendEmailInput {
    userId: string;
    agentId: string;
    workId?: string;
    taskId?: string;
    to: string[];
    cc?: string[];
    subject: string;
    /** Plain-text body. Optional when `template` is supplied (rendered then). */
    bodyText?: string;
    bodyHtml?: string;
    /** Render a registered React-Email template instead of raw bodies. */
    template?: AgentEmailTemplateRef;
    /** Optional explicit from-address id (tenant_email_addresses.id). */
    fromAddressId?: string;
}

export interface AgentSendEmailResult {
    providerMessageId: string;
    accepted: string[];
    rejected: { address: string; reason: string }[];
}

/**
 * Input for the higher-level `messageAgent` tool (T24, spec §12.4).
 * The adapter resolves the *target* Agent's primary inbound address +
 * routes with `conversation` dispatch-mode metadata.
 */
export interface AgentMessageAgentInput {
    userId: string;
    /** The agent sending the message. */
    fromAgentId: string;
    /** The agent to deliver to (resolved to its primary inbound address). */
    targetAgentId: string;
    subject: string;
    body: string;
    attachReferences?: { workId?: string; taskId?: string; missionId?: string }[];
}

export interface AgentMessageAgentResult {
    providerMessageId: string;
    targetAddress: string;
}

export interface AgentEmailFacade {
    /**
     * Send a raw email from one of the Agent's assigned outbound
     * addresses. MUST reject (throw) when the Agent has no outbound
     * `agent_email_assignments` row so the model receives an actionable
     * "no outbound address assigned" error.
     */
    sendEmail(input: AgentSendEmailInput): Promise<AgentSendEmailResult>;

    /**
     * Send a message to a peer Agent (T24). MUST reject when the target
     * Agent has no inbound address.
     */
    messageAgent?(input: AgentMessageAgentInput): Promise<AgentMessageAgentResult>;
}

export const AGENT_EMAIL_FACADE = 'AGENT_EMAIL_FACADE' as const;
