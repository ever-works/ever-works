import 'server-only';
import { serverFetch } from './server-api';

/**
 * Web client for the Agent Plugins package registry
 * (`apps/api/src/agent-plugins/agent-plugins.controller.ts`).
 *
 * These types MIRROR the API's response shape by hand, as every client in this
 * directory does — there is no generated client. That means a field added on
 * the API side does not appear here until it is added here too, so the two
 * must be changed together.
 */

export type AgentPluginFindingSeverity = 'fatal' | 'error' | 'warning';

export interface AgentPluginFinding {
    severity: AgentPluginFindingSeverity;
    code: string;
    message: string;
    subject?: string;
    scope?: string;
}

export interface AgentPluginPackageSummary {
    errorCount?: number;
    warningCount?: number;
    fatalCount?: number;
}

export interface AgentPluginPackageRow {
    name?: string;
    version?: string;
    specVersion?: string;
    path?: string;
    dirName?: string;
    skills: string[];
    mcpServers: string[];
    findings: AgentPluginFinding[];
    summary?: AgentPluginPackageSummary;
}

export interface AgentPluginRejectedRow {
    dirName?: string;
    path?: string;
    findings: AgentPluginFinding[];
    summary?: AgentPluginPackageSummary;
}

export interface AgentPluginListResponse {
    /**
     * Distinguishes "the feature is off" from "on, with no packages".
     *
     * Without this the page cannot tell an operator who has just flipped the
     * flag which of the two they are looking at — both render as an empty
     * list.
     */
    enabled: boolean;
    roots: string[];
    packages: AgentPluginPackageRow[];
    rejected: AgentPluginRejectedRow[];
    shadowed: Array<{ dirName?: string; name?: string }>;
}

export interface AgentPluginFindingsResponse {
    enabled: boolean;
    findings: Array<
        AgentPluginFinding & {
            package?: string;
            packageLoaded?: boolean;
        }
    >;
}

/** Shape returned when the feature is off or the request fails. */
export const EMPTY_AGENT_PLUGIN_LIST: AgentPluginListResponse = {
    enabled: false,
    roots: [],
    packages: [],
    rejected: [],
    shadowed: [],
};

export const agentPluginsAPI = {
    async list(search?: string): Promise<AgentPluginListResponse> {
        const query = search ? `?search=${encodeURIComponent(search)}` : '';
        return serverFetch<AgentPluginListResponse>(`/agent-plugins${query}`);
    },

    async findings(): Promise<AgentPluginFindingsResponse> {
        return serverFetch<AgentPluginFindingsResponse>('/agent-plugins/findings');
    },
};
