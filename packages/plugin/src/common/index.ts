/**
 * Re-export types from @ever-works/contracts that are commonly used by plugins.
 *
 * For API types (DTOs, enums like GenerationMethod), import directly from:
 * import { ... } from '@ever-works/contracts/api';
 *
 * This limited re-export avoids ambiguity about which package owns which types.
 */

// Domain types commonly used in plugins
export type {
	ItemData,
	MutableItemData,
	Category,
	Tag,
	Brand,
	DomainAnalysis,
	WebPageData,
	RelevanceAssessment,
	Badge,
	ItemBadges,
	BadgeEvaluationResult,
	Identifiable
} from '@ever-works/contracts';

// Enums commonly used in plugins
export { DomainType } from '@ever-works/contracts';

// Form types commonly used in form-schema providers
export type { FormFieldDefinition, FormFieldGroup, FormSchema, FormFieldType } from '@ever-works/contracts';
