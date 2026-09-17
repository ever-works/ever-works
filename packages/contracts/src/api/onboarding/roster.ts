/**
 * AW-20 P1 — the roster vocabulary shared by the API, the agent package
 * and the web wizard step.
 *
 * A **roster** is not a new entity: it is the set of Agents the platform
 * provisions for one person in one workspace scope, each carrying a
 * **lane**. Everything here is a closed vocabulary so the wizard, the
 * provisioning service and the DTO validators cannot drift apart — the
 * same trick `ROLE_OPTIONS` / `TEAM_SIZE_OPTIONS` already use one file
 * over.
 */

/**
 * A lane is a short, stable key naming the area of work one Agent owns
 * (FR-26). Seven ship with the build, and the catalogue is capped at 12
 * (FR-30) so the "add a lane" menu stays a menu rather than a directory.
 *
 * 🛑 A lane is a **label, not a permission** (FR-27). It grants nothing,
 * restricts nothing, and must never be consulted by an authorization
 * decision. It exists so a surface can ask "who owns research here?" and
 * get a stable answer instead of grepping free-text titles.
 */
export const ROSTER_LANE_KEYS = [
	'coordination',
	'research',
	'content',
	'outreach',
	'visibility',
	'social',
	'market-watch'
] as const;

export type RosterLaneKey = (typeof ROSTER_LANE_KEYS)[number];

/**
 * Named starting rosters. Content that ships with the build, not data:
 * a blueprint changes when we deploy, never when a user acts, and it
 * must mean the same thing in a bug report as it does in production.
 */
export const ROSTER_BLUEPRINT_SLUGS = ['general', 'growth', 'revenue', 'insight', 'solo-starter'] as const;

export type RosterBlueprintSlug = (typeof ROSTER_BLUEPRINT_SLUGS)[number];

/**
 * The most lanes one provisioning run will set up (FR-6). A blueprint
 * may declare at most this many, and a user adding lanes by hand stops
 * here too — more agents than this in one go is a fleet, not a start.
 */
export const ROSTER_MAX_LANES = 8;

/** Longest agent name the roster step accepts, in characters (FR-7). */
export const ROSTER_NAME_MAX = 60;
