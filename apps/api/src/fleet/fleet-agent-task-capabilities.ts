import { config } from '@ever-works/agent/config';

/**
 * The capability tags an `agent-task` job requires (self-build slice S).
 *
 * ONE definition, used at both ends of the dispatch path:
 *
 *   - the router, BEFORE the routing decision, to count only the nodes
 *     that could actually lease the job (eligibility-aware availability);
 *   - `enqueueAgentTask`, to stamp `requiredCapabilities` on the row the
 *     lease CAS filters on.
 *
 * Extracted so the two cannot disagree — a router that counted nodes
 * against one tag set while the row demanded another would re-create the
 * exact "placed, but nothing can take it" hole this slice closes.
 *
 * The operator's `FLEET_NODE_REQUIRED_CAPABILITIES` always applies. In
 * `model-cli` mode the resolved provider is added: the tag is backed by a
 * resolved executable on the node, which is what keeps a Claude job off a
 * machine that only has Codex (and vice versa). `null` is the legacy
 * `command` mode, where only the operator tags apply.
 */
export function agentTaskRequiredCapabilities(provider: string | null | undefined): string[] {
    const tags = config.fleetNode.getRequiredCapabilities();
    if (!provider) {
        return tags;
    }
    return Array.from(new Set([...tags, provider]));
}
