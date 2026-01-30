/**
 * API types for plugin endpoints.
 *
 * These types define the shape of plugin data in API responses.
 * Import from '@ever-works/plugin/api' for these types.
 */
export * from './api-response.types.js';

// Re-export core types that are commonly used with API responses
export type { PluginCategory, PluginAuthor, PluginIcon, PluginIconType } from '../contracts/plugin-manifest.types.js';
export type { PluginState } from '../contracts/lifecycle.types.js';
export type { ConfigurationMode } from '../settings/settings.types.js';
