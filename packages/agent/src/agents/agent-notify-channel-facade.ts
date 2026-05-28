/**
 * Notifications v2 (EW-663 / EW-673) — token + contract for the Agent
 * `notifyChannel` tool.
 *
 * Same circular-dep dodge as `agent-email-facade.ts` /
 * `agent-git-facade.ts`: `agent-tool.service.ts` injects this via
 * `@Optional() @Inject(AGENT_NOTIFY_CHANNEL_FACADE)` so unit tests +
 * non-API contexts build the descriptor list without a runtime
 * `NotificationChannelFacadeService` dependency. The platform-side
 * adapter forwards to `NotificationChannelFacadeService.sendDirect`.
 *
 * When the token is unbound the tool is omitted from the Agent's
 * descriptor list — the model never sees it.
 */

export interface AgentNotifyChannelInput {
    userId: string;
    agentId: string;
    /**
     * The `notification_channels.id` to deliver to. The model is
     * expected to pick from the agent's enabled channels (the adapter
     * rejects an id the user doesn't own / that's disabled).
     */
    channelId: string;
    /** Plain-text message body. */
    text: string;
}

export interface AgentNotifyChannelResult {
    status: 'delivered' | 'failed';
    providerMessageId?: string;
    error?: string;
}

export interface AgentEnabledChannelSummary {
    id: string;
    name: string;
    pluginId: string;
}

export interface AgentNotifyChannelFacade {
    /**
     * Deliver an ad-hoc message to one of the user's notification
     * channels. MUST reject when the channel id is unknown / disabled /
     * not owned by the agent's user.
     */
    notifyChannel(input: AgentNotifyChannelInput): Promise<AgentNotifyChannelResult>;

    /**
     * Optional: list the user's enabled channels so the run loop can
     * surface valid ids to the model. When unimplemented the model must
     * already know a channel id (e.g. from prior context).
     */
    listEnabledChannels?(userId: string): Promise<AgentEnabledChannelSummary[]>;
}

export const AGENT_NOTIFY_CHANNEL_FACADE = 'AGENT_NOTIFY_CHANNEL_FACADE' as const;
