export * from './dto';
export * from './interfaces/items-generator.interfaces';
export * from './item-submission.service';
export * from './items-generator.module';
export * from './schemas/item-extraction.schemas';
export * from './constants/steps';

// Re-export types from plugin package for backwards compatibility
export type { ItemData, MutableItemData, Category, Tag, Brand } from '@ever-works/plugin';

// Re-export DomainType as value (it's an enum, not just a type)
export { DomainType } from '@ever-works/plugin';
