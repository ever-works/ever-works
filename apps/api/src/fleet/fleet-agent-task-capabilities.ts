import { FLEET_PUSH_CAPABILITY } from '@ever-works/contracts';
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
 *
 * `git-push` (self-build slice AM, EW-810) is added UNCONDITIONALLY, and
 * that is deliberate on three counts:
 *
 *  1. It is the pre-dispatch push-capability probe. A node advertises the
 *     tag only when its Git can actually install a scoped, per-run
 *     credential; a node that cannot must never be handed twenty minutes
 *     of model time and then discover it at the push.
 *  2. It is added regardless of whether THIS plan pushes, because the two
 *     callers of this function see different things: the router asks
 *     before a plan exists (settings only) and `enqueueAgentTask` asks
 *     with one in hand. A tag that depended on the plan would make the
 *     router count nodes against one set while the row demanded another —
 *     the exact "placed, but nothing can take it" hole this module was
 *     extracted to prevent. A non-pushing `agent-task` on a push-capable
 *     node costs nothing; the reverse is a stuck queue.
 *  3. The upgrade coupling is intentional and safe. A node running a build
 *     from before this slice reports no `git-push` tag, so it stops
 *     attracting `agent-task` work — and it MUST, because it would push
 *     with the machine's own ambient credential helper. The dispatcher
 *     already treats "no free runner" as a fallback to the cloud, so an
 *     un-upgraded fleet degrades to cloud execution rather than stalling.
 */
export function agentTaskRequiredCapabilities(provider: string | null | undefined): string[] {
    const tags = [...config.fleetNode.getRequiredCapabilities(), FLEET_PUSH_CAPABILITY];
    if (!provider) {
        return Array.from(new Set(tags));
    }
    return Array.from(new Set([...tags, provider]));
}
