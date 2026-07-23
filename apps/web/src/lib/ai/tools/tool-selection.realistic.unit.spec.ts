import { describe, expect, it } from 'vitest';
import { ALL_OPERATIONS } from './generated/registry.all';
import { STATIC_TOOL_DOMAINS, selectActiveToolNames } from './tool-selection';

/**
 * Regression guard for the "create X from chat does nothing" class of bug.
 *
 * The pre-existing `tool-selection.unit.spec.ts` exercises a hand-written
 * 10-name array, which is why this shipped unnoticed. Measured against the
 * real registry before the fix: 387 tool names, `MAX_ACTIVE_TOOLS = 90`, and
 * the selection saturated at exactly 90 — the always-on core consumed nearly
 * the whole budget, leaving room for only the first 6 tools of the matched
 * domain. `createIdea` was cut on EVERY turn, and the `missions` domain kept
 * just 9 of its 14 tools (losing `resumeMission`, `completeMission`,
 * `deleteMission`, `runMissionNow`, `cloneMission`). A model told by the
 * system prompt that `createIdea` exists then emits a call for a tool absent
 * from `tools`, the AI SDK raises `NoSuchToolError`, and the user sees their
 * answer go nowhere.
 *
 * These specs therefore run against the REAL tool-name universe: every
 * generated operation plus every hand-written/canvas tool in
 * `STATIC_TOOL_DOMAINS`. Chat e2e cannot cover this — CI is deliberately
 * key-less, so no LLM ever runs there.
 */

/**
 * Every tool name the chat agent can expose, IN THE ORDER `buildChatTools`
 * produces them.
 *
 * The order is load-bearing, not cosmetic: `selectActiveToolNames` slices
 * the tail off `[...core, ...matched]`, and both arrays preserve input
 * order. `buildChatTools` spreads `buildGeneratedTools(ALL_OPERATIONS)`
 * FIRST and the hand-written tools LAST (so hand-written wins name
 * collisions), which means the bespoke `createMission` sits at the very
 * end of the `missions` domain — behind every generated `*_mission_*` op.
 * A fixture that listed hand-written tools first would hide the exact bug
 * these specs exist to catch.
 */
const ALL_TOOL_NAMES: string[] = (() => {
    const seen = new Set<string>();
    const names: string[] = [];
    const push = (name: string) => {
        if (!seen.has(name)) {
            seen.add(name);
            names.push(name);
        }
    };
    for (const op of ALL_OPERATIONS) {
        push(op.toolName);
    }
    for (const name of Object.keys(STATIC_TOOL_DOMAINS)) {
        push(name);
    }
    return names;
})();

/**
 * The entry points a user reaches through a "create a <thing>" chat flow.
 * Each is paired with the message + page that flow actually produces —
 * `useStartFromPrompt` prefixes "I want to create a {intent}. " and the
 * composer lives on the matching catalog page.
 */
const CREATE_FLOWS: ReadonlyArray<{
    tool: string;
    text: string;
    pageUrl: string;
}> = [
    {
        tool: 'createMission',
        text: 'I want to create a Mission. Weekly roundup of AI coding tools',
        pageUrl: '/missions',
    },
    {
        tool: 'createIdea',
        text: 'I want to create a Idea. Add a pricing comparison block',
        pageUrl: '/ideas',
    },
    {
        tool: 'create_task',
        text: 'I want to create a Task. Refresh the metadata for every listing',
        pageUrl: '/tasks',
    },
    {
        tool: 'create_agent',
        text: 'I want to create a Agent. A researcher that watches competitor pricing',
        pageUrl: '/agents',
    },
];

describe('selectActiveToolNames — against the real registry', () => {
    it('exposes the full tool universe (sanity: the fixture is not tiny)', () => {
        expect(ALL_TOOL_NAMES.length).toBeGreaterThan(200);
    });

    it.each(CREATE_FLOWS)('keeps $tool active for its create flow', ({ tool, text, pageUrl }) => {
        expect(ALL_TOOL_NAMES).toContain(tool);

        const selected = selectActiveToolNames(ALL_TOOL_NAMES, { text, pageUrl });

        expect(
            selected,
            `${tool} was gated out of the active set — the model will emit a call for an ` +
                `undefined tool and the user sees nothing happen`,
        ).toContain(tool);
    });

    it.each(CREATE_FLOWS)(
        'keeps $tool active on the follow-up turn, when the user only answers a question',
        ({ tool, pageUrl }) => {
            // The chat asks "what should we call it?" and the user replies with a
            // bare name that mentions no domain keyword at all. Gating must not
            // collapse to core-only on that turn.
            const selected = selectActiveToolNames(ALL_TOOL_NAMES, {
                text: 'AI Coding Tools Weekly',
                pageUrl,
            });

            expect(selected).toContain(tool);
        },
    );

    it('reserves budget for matched domains instead of letting core consume the cap', () => {
        const selected = selectActiveToolNames(ALL_TOOL_NAMES, {
            text: 'I want to create a Mission. Weekly roundup of AI coding tools',
            pageUrl: '/missions',
        });

        const missionTools = selected.filter((name) => STATIC_TOOL_DOMAINS[name] === 'missions');
        expect(missionTools.length).toBeGreaterThanOrEqual(8);
    });

    /**
     * The budget floor alone does not save the create tools. On a turn that
     * activates many domains at once, the generated operations are numerous
     * enough to fill the entire floor by themselves — and because
     * `buildChatTools` emits generated tools first, the bespoke `createX`
     * at the tail of each domain would still be sliced off. Ordering
     * hand-written tools ahead of generated ones within `matched` is what
     * actually guarantees they survive.
     */
    it('keeps every create tool active on a turn that activates many domains at once', () => {
        const selected = selectActiveToolNames(ALL_TOOL_NAMES, {
            text:
                'For this mission and its ideas, create a task for the agent, ' +
                'check the work deployment, the plugin integration, the knowledge ' +
                'base document, the notification channel, the team member, the ' +
                'api key, the budget and the webhook',
            pageUrl: '/missions',
        });

        for (const { tool } of CREATE_FLOWS) {
            expect(selected, `${tool} was crowded out by generated operations`).toContain(tool);
        }
    });

    it('orders hand-written tools ahead of generated ones within a matched domain', () => {
        const selected = selectActiveToolNames(ALL_TOOL_NAMES, {
            text: 'I want to create a Mission. Weekly roundup',
            pageUrl: '/missions',
        });

        const handWrittenIndex = selected.indexOf('createMission');
        const generatedIndex = selected.indexOf('list_mission_attachments');
        expect(handWrittenIndex).toBeGreaterThanOrEqual(0);
        expect(generatedIndex).toBeGreaterThanOrEqual(0);
        expect(handWrittenIndex).toBeLessThan(generatedIndex);
    });

    it('still drops domains that are irrelevant to the turn', () => {
        const selected = selectActiveToolNames(ALL_TOOL_NAMES, {
            text: 'I want to create a Mission. Weekly roundup',
            pageUrl: '/missions',
        });

        expect(selected).not.toContain('list_webhooks');
    });
});
