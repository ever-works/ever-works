import type { EverStatsConfig } from '@ever-works/agent/ever-instance';

/** The module's configuration, read from the environment once when the module is created. */
export const INSTANCE_STATS_CONFIG = Symbol('INSTANCE_STATS_CONFIG');
export type InstanceStatsRuntimeConfig = EverStatsConfig;

/** The clock the schedule reads (a test replaces it). */
export const INSTANCE_STATS_CLOCK = Symbol('INSTANCE_STATS_CLOCK');
export type InstanceStatsClock = () => Date;

/**
 * The random source of the daily send time: an integer in `[0, max)`. A test
 * replaces it; the default is `crypto.randomInt`.
 */
export const INSTANCE_STATS_RANDOM = Symbol('INSTANCE_STATS_RANDOM');
export type InstanceStatsRandom = (max: number) => number;
