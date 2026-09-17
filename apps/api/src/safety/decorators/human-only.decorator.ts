import { SetMetadata } from '@nestjs/common';

/** Metadata key `HumanActorGuard` reads. */
export const HUMAN_ONLY_KEY = 'safety:humanOnly';

/**
 * Safety rails (AW-24) — this route may only be operated by a PERSON acting
 * in an interactive session (FR-31, FR-47).
 *
 * An API key, an agent, a schedule, a trigger, a webhook or any other
 * automation is refused, the attempt is recorded as a refusal with the actor,
 * and a decision is raised naming the requester.
 *
 * That is not ceremony. A rung, a pause and a resume are the controls an
 * owner uses when they have decided the agents are doing the wrong thing —
 * and a control an agent can operate is not a control at all. "An agent that
 * asks to be resumed gets a decision raised instead" is the product promise
 * this decorator is the enforcement of.
 */
export const HumanOnly = () => SetMetadata(HUMAN_ONLY_KEY, true);
