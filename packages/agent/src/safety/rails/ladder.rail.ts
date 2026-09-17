import { UNCLASSIFIED_ACTION_POLICY, isLadderedCategory } from '@ever-works/contracts';
import { ladderEntry } from '../trust-ladder';
import { buildVerdict, type SafetyRailMiddleware } from '../safety-rails';

/**
 * Rail 5 — the trust ladder. The one genuinely new rail in the chain.
 *
 * Everything above and below it delegates to a decision Ever Works already
 * makes. This rail is the dial an owner has never had: per KIND OF WORK,
 * resolved down platform default → Workspace → Agent, narrow-only.
 *
 * ## What each rung does here
 *
 *   off   — refused. Nothing prepared, nothing queued. The agent is told
 *           which category refused it.
 *   draft — held. P2 stores the prepared artefact and executes it verbatim on
 *           approval; P1 records the hold and tells the run.
 *   ask   — held, same posture.
 *   auto  — passes to the caps rail, exactly as before this epic existed.
 *
 * ## `read.internal` is not laddered
 *
 * FR-2: what an agent may READ inside the workspace is decided by connections
 * and tool grants (rail 4, immediately above). This rail never has an opinion
 * about it, and creating a second way to express it is explicitly out of
 * scope.
 *
 * ## An untouched default is displayed, not enforced — in P1
 *
 * `ResolvedLadderEntry.enforced` is false for a shipped default while
 * `SHIPPED_DEFAULT_RUNG_POLICY` is `display`. Holding an action nobody asked
 * to hold, in a phase where no approval can release it, would stop work that
 * runs today for no reachable benefit. An EXPLICIT rung is always enforced.
 *
 * ## An unclassified action
 *
 * In P1 it proceeds and is counted (`UNCLASSIFIED_ACTION_POLICY = 'warn'`);
 * the gate records the count. It is never guessed into a permissive category.
 */
export const ladderRail: SafetyRailMiddleware = async (context, next) => {
    const { category, ladder } = context;

    if (!category) {
        // FR-3 / FR-24 — handled once, here, by the published policy. The
        // gate records the observation; nothing is guessed.
        if (UNCLASSIFIED_ACTION_POLICY === 'refuse') {
            return buildVerdict({
                decision: 'refused',
                railId: 'taxonomy',
                reasonCode: 'unclassified-action',
                context,
                summary: `Nothing classifies "${context.entryPointId}", so it stops for a person to say which kind of work it is.`,
            });
        }
        return next();
    }

    if (!isLadderedCategory(category)) return next();

    const entry = ladderEntry(ladder, category);
    if (!entry || !entry.enforced) return next();

    const ceiling = {
        rung: entry.rung,
        ceiling: entry.ceiling,
        decidedBy: entry.decidedBy,
    };

    if (entry.rung === 'off') {
        return buildVerdict({
            decision: 'refused',
            railId: 'ladder',
            reasonCode: 'rung-off',
            context,
            summary: `"${category}" is switched off for this workspace, so nothing was prepared or queued.`,
            rung: entry.rung,
            ceiling,
        });
    }

    if (entry.rung === 'draft' || entry.rung === 'ask') {
        return buildVerdict({
            decision: 'held',
            railId: 'ladder',
            reasonCode: 'rung-held',
            context,
            summary:
                entry.rung === 'draft'
                    ? `"${category}" waits for you. Nothing was sent; the decision carries what would have happened.`
                    : `"${category}" waits for your approval before it happens.`,
            rung: entry.rung,
            ceiling,
        });
    }

    return next();
};
