/**
 * Facade interfaces for pipeline step execution.
 *
 * These interfaces define what services are available to pipeline steps
 * via the StepExecutionContext. The actual implementations live in packages/agent
 * as NestJS services.
 */
export * from './facade-options.interface.js';
export * from './base-facade.interface.js';
export * from './ai-facade.interface.js';
export * from './search-facade.interface.js';
export * from './screenshot-facade.interface.js';
export * from './content-extractor-facade.interface.js';
export * from './data-source-facade.interface.js';
export * from './git-facade.interface.js';
export * from './oauth-facade.interface.js';
export * from './deploy-facade.interface.js';
export * from './prompt-facade.interface.js';
export * from './kb-tools-facade.interface.js';
