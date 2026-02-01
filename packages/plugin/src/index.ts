/**
 * @ever-works/plugin
 *
 * Plugin system contracts, helpers, and utilities for Ever Works platform.
 * This package provides everything needed to build plugins for the Ever Works ecosystem.
 *
 * @packageDocumentation
 */

// Core contracts
export * from './contracts/index.js';

// Pipeline types and utilities
export * from './pipeline/index.js';

// Event types
export * from './events/index.js';

// Settings types and schemas
export * from './settings/index.js';

// Common types (domain, item, form-field)
export * from './common/index.js';

// Helper utilities
export * from './helpers/index.js';

// Abstract base classes
export * from './abstract/index.js';

// Testing utilities
export * from './testing/index.js';

// API response utilities (for transforming JsonSchema to API response types)
export {
	toPluginSettingsSchemaProperty,
	toPluginSettingsSchema,
	type PluginSettingsSchemaProperty,
	type PluginSettingsSchema,
	type PluginResponse,
	type UserPluginResponse,
	type DirectoryPluginResponse,
	type PluginListResponse,
	type DirectoryPluginListResponse,
	type SettingScopeApi
} from './api/index.js';
