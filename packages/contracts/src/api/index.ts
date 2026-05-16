/**
 * API types for Ever Works platform
 *
 * This module exports types that are shared between the backend API
 * and frontend applications for API request/response contracts.
 */

// Generator types
export * from './generator/index.js';

// Work types
export * from './work/index.js';

// Agent / zero-friction onboarding types
export * from './onboarding/index.js';

// EW-628 data-repo instant-sync — activity-row wire payload shared by
// API (emitter) and web (renderer).
export * from './data-sync/index.js';
