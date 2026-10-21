import { FLEET_CLI_EXIT as CONTRACT_FLEET_CLI_EXIT, fleetCliExitFor } from '@ever-works/contracts';

/**
 * `ever-works fleet …` exit codes (FL-19, spec FR-20, CONTRACTS §11.3):
 * `0` success · `1` the action failed or was refused · `2` usage error or a
 * missing confirmation · `124` a command timed out. One map for every verb.
 */
export const FLEET_EXIT = CONTRACT_FLEET_CLI_EXIT;

/** The exit code a refusal's CONTRACTS §8 code maps to. */
export const fleetExitFor = fleetCliExitFor;
