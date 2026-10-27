import YAML from 'yaml';
import {
    FLEET_SESSION_ACTION_IDS,
    FLEET_SESSION_ACTION_TEMPLATE_MAX_LENGTH,
    FLEET_SESSION_BRANCH_PREFIX_MAX_LENGTH,
    isFleetSessionActionId,
    type FleetSessionActionId,
} from '@ever-works/contracts';

/**
 * Session git & actions (FL-06, spec FR-13, FR-27, S12; plan §4) — the
 * optional `fleet` block of an Agent's `agent.yml`:
 *
 * ```yaml
 * fleet:
 *     branchPrefix: nina          # default: the Agent's slug
 *     actions:
 *         commit: '…{branch}…'    # any of the seven; the platform default otherwise
 * ```
 *
 * How an Agent commits, describes a pull request or writes a recap is part of
 * how that Agent works, so it lives with the Agent's instructions and nothing
 * new is stored. The block is optional; a file without it reads as "all
 * defaults". Unknown keys INSIDE the block are refused (an action id that is
 * not one of the seven is a typo the person should see), naming the field.
 */

export interface AgentFleetBlock {
    branchPrefix: string | null;
    actions: Partial<Record<FleetSessionActionId, string>>;
}

export interface AgentFleetBlockError {
    /** `fleet.actions.comit`, `fleet.branchPrefix`, … */
    field: string;
    message: string;
}

const EMPTY: AgentFleetBlock = { branchPrefix: null, actions: {} };

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Read the `fleet` block. A file that is not YAML, or has no `fleet` key,
 * reads as all defaults (no error: `agent.yml` is free text the person owns,
 * and the rest of it is not this epic's to judge). A malformed `fleet` block
 * answers the defaults AND the first error.
 */
export function readAgentFleetBlock(agentYml: string | null | undefined): {
    block: AgentFleetBlock;
    error: AgentFleetBlockError | null;
} {
    if (typeof agentYml !== 'string' || agentYml.trim() === '')
        return { block: EMPTY, error: null };
    let parsed: unknown;
    try {
        parsed = YAML.parse(agentYml);
    } catch {
        return { block: EMPTY, error: null };
    }
    if (!isRecord(parsed) || parsed.fleet === undefined || parsed.fleet === null)
        return { block: EMPTY, error: null };
    const fleet = parsed.fleet;
    if (!isRecord(fleet)) {
        return {
            block: EMPTY,
            error: { field: 'fleet', message: 'fleet must be a map of branchPrefix and actions' },
        };
    }
    for (const key of Object.keys(fleet)) {
        if (key !== 'branchPrefix' && key !== 'actions') {
            return {
                block: EMPTY,
                error: { field: `fleet.${key}`, message: `unknown key "${key}" in fleet` },
            };
        }
    }
    const block: AgentFleetBlock = { branchPrefix: null, actions: {} };
    if (fleet.branchPrefix !== undefined && fleet.branchPrefix !== null) {
        const prefix = fleet.branchPrefix;
        if (
            typeof prefix !== 'string' ||
            prefix.trim().length === 0 ||
            prefix.length > FLEET_SESSION_BRANCH_PREFIX_MAX_LENGTH ||
            !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(prefix.trim())
        ) {
            return {
                block: EMPTY,
                error: {
                    field: 'fleet.branchPrefix',
                    message: `branchPrefix is 1–${FLEET_SESSION_BRANCH_PREFIX_MAX_LENGTH} letters, digits, dots, dashes or underscores`,
                },
            };
        }
        block.branchPrefix = prefix.trim();
    }
    if (fleet.actions !== undefined && fleet.actions !== null) {
        if (!isRecord(fleet.actions)) {
            return {
                block: EMPTY,
                error: { field: 'fleet.actions', message: 'actions must be a map of action ids' },
            };
        }
        for (const [id, text] of Object.entries(fleet.actions)) {
            if (!isFleetSessionActionId(id)) {
                return {
                    block: EMPTY,
                    error: {
                        field: `fleet.actions.${id}`,
                        message: `"${id}" is not an action (one of ${FLEET_SESSION_ACTION_IDS.join(', ')})`,
                    },
                };
            }
            if (text === null || text === undefined || text === '') continue;
            if (
                typeof text !== 'string' ||
                text.length > FLEET_SESSION_ACTION_TEMPLATE_MAX_LENGTH
            ) {
                return {
                    block: EMPTY,
                    error: {
                        field: `fleet.actions.${id}`,
                        message: `the ${id} template is text of at most ${FLEET_SESSION_ACTION_TEMPLATE_MAX_LENGTH} characters`,
                    },
                };
            }
            block.actions[id] = text;
        }
    }
    return { block, error: null };
}

/**
 * Write the `fleet` block into an `agent.yml`, keeping everything else in the
 * file — its other keys, comments and order (the YAML document API). An
 * empty template or prefix removes that key; an empty block removes `fleet`.
 * A file that is not YAML at all is refused (null): the editor then says so
 * instead of overwriting what the person wrote.
 */
export function writeAgentFleetBlock(
    agentYml: string | null | undefined,
    block: AgentFleetBlock,
): string | null {
    const text = typeof agentYml === 'string' ? agentYml : '';
    let document: YAML.Document;
    try {
        document = text.trim() === '' ? new YAML.Document({}) : YAML.parseDocument(text);
        if (document.errors.length > 0) return null;
    } catch {
        return null;
    }
    const contents = document.toJS() as unknown;
    if (text.trim() !== '' && !isRecord(contents)) return null;
    if (block.branchPrefix && block.branchPrefix.trim())
        document.setIn(['fleet', 'branchPrefix'], block.branchPrefix.trim());
    else if (document.hasIn(['fleet', 'branchPrefix']))
        document.deleteIn(['fleet', 'branchPrefix']);
    for (const id of FLEET_SESSION_ACTION_IDS) {
        const value = block.actions[id];
        if (typeof value === 'string' && value.trim())
            document.setIn(['fleet', 'actions', id], value);
        else if (document.hasIn(['fleet', 'actions', id]))
            document.deleteIn(['fleet', 'actions', id]);
    }
    const actions = document.getIn(['fleet', 'actions']) as unknown;
    if (actions && YAML.isMap(actions) && actions.items.length === 0)
        document.deleteIn(['fleet', 'actions']);
    const fleet = document.get('fleet') as unknown;
    if (fleet && YAML.isMap(fleet) && fleet.items.length === 0) document.delete('fleet');
    return document.toString();
}
