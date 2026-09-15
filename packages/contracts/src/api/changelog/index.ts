/**
 * What's new (AW-14) — in-product changelog API contracts.
 *
 * Wire-types and closed vocabularies shared between the API and every client
 * that renders the What's new panel. Pure types plus two literal tuples, so
 * they can be imported from both server and client code.
 */
export * from './changelog.enum.js';
export * from './changelog.dto.js';
