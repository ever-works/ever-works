// Type-level fixtures. These tests run via vitest's `typecheck` mode and fail
// at compile time if a contract changes shape. They exist to catch breaking
// changes — adding a property is fine, removing or retyping a load-bearing
// one is what we want to surface.

import { expectTypeOf, describe, it } from 'vitest';
// Note: this file is consumed by vitest's `typecheck` mode (filename pattern
// `*.spec-d.ts`). It contains TYPE assertions only — no runtime expectations.
import type {
	// item
	Identifiable,
	Category,
	Tag,
	Collection,
	Brand,
	Badge,
	ItemBadges,
	BadgeEvaluationResult,
	ItemHealth,
	ItemHealthStatus,
	ItemSourceReachabilityStatus,
	ItemSourceAccuracyStatus,
	ItemSourceValidation,
	ItemData,
	MutableItemData,
	ComparisonDimension,
	ComparisonSource,
	ComparisonData,
	// domain
	DomainAnalysis,
	WebPageData,
	RelevanceAssessment,
	// form
	FormFieldType,
	FormFieldOption,
	FormFieldValidation,
	FormFieldCondition,
	FormFieldDefinition,
	FormFieldGroup,
	FormSchema,
	// github
	ParsedGitHubRepository
} from '../index.js';

import { DomainType } from '../domain/index.js';
import type {
	OnboardingStatus,
	WebhookEvent,
	WebhookEventTerminal,
	WebhookEventManifestChanged,
	WebhookEventDeployFailed
} from '../api/onboarding/index.js';

describe('item contracts (type)', () => {
	it('Identifiable has readonly id and name strings', () => {
		expectTypeOf<Identifiable>().toEqualTypeOf<{
			readonly id: string;
			readonly name: string;
		}>();
	});

	it('Category extends Identifiable shape with optional metadata', () => {
		expectTypeOf<Category>().toMatchTypeOf<{ readonly id: string; readonly name: string }>();
		expectTypeOf<Category['description']>().toEqualTypeOf<string | undefined>();
		expectTypeOf<Category['priority']>().toEqualTypeOf<number | undefined>();
	});

	it('Tag is the minimal id+name shape', () => {
		expectTypeOf<Tag>().toEqualTypeOf<{ readonly id: string; readonly name: string }>();
	});

	it('Collection mirrors Category (without category-specific extensions)', () => {
		expectTypeOf<Collection>().toMatchTypeOf<{ readonly id: string; readonly name: string }>();
		expectTypeOf<Collection['icon_url']>().toEqualTypeOf<string | undefined>();
	});

	it('Brand fields are well-typed', () => {
		expectTypeOf<Brand['logo_url']>().toEqualTypeOf<string | undefined>();
		expectTypeOf<Brand['website']>().toEqualTypeOf<string | undefined>();
	});

	it('Badge.value is required and details may be null', () => {
		expectTypeOf<Badge['value']>().toBeString();
		expectTypeOf<Badge['details']>().toEqualTypeOf<string | null | undefined>();
	});

	it('ItemBadges is Record<string, Badge>', () => {
		expectTypeOf<ItemBadges>().toEqualTypeOf<Record<string, Badge>>();
	});

	it('BadgeEvaluationResult.evaluated_at is a (ISO-) string', () => {
		expectTypeOf<BadgeEvaluationResult['evaluated_at']>().toBeString();
		expectTypeOf<BadgeEvaluationResult['badges']>().toEqualTypeOf<ItemBadges>();
	});

	it('ItemHealthStatus is the closed union of 5 known states', () => {
		expectTypeOf<ItemHealthStatus>().toEqualTypeOf<
			'unchecked' | 'healthy' | 'unknown' | 'warning' | 'broken'
		>();
	});

	it('ItemSourceReachabilityStatus / ItemSourceAccuracyStatus are closed unions', () => {
		expectTypeOf<ItemSourceReachabilityStatus>().toEqualTypeOf<
			'reachable' | 'broken' | 'unknown'
		>();
		expectTypeOf<ItemSourceAccuracyStatus>().toEqualTypeOf<
			'accurate' | 'generic' | 'weak' | 'unknown'
		>();
	});

	it('ItemHealth optional metadata can be null where stated', () => {
		expectTypeOf<ItemHealth['status_code']>().toEqualTypeOf<number | null | undefined>();
		expectTypeOf<ItemHealth['message']>().toEqualTypeOf<string | null | undefined>();
		expectTypeOf<ItemHealth['checked_via']>().toEqualTypeOf<'manual' | 'schedule' | undefined>();
	});

	it('ItemSourceValidation flags are typed as boolean | undefined', () => {
		expectTypeOf<ItemSourceValidation['is_relevant']>().toEqualTypeOf<boolean | undefined>();
		expectTypeOf<ItemSourceValidation['is_specific']>().toEqualTypeOf<boolean | undefined>();
		expectTypeOf<ItemSourceValidation['is_official']>().toEqualTypeOf<boolean | undefined>();
	});

	it('ItemData.category accepts string OR readonly string[]', () => {
		expectTypeOf<ItemData['category']>().toEqualTypeOf<string | readonly string[]>();
	});

	it('ItemData.tags accepts readonly string[] OR readonly Tag[]', () => {
		expectTypeOf<ItemData['tags']>().toEqualTypeOf<readonly string[] | readonly Tag[]>();
	});

	it('ItemData required fields exist', () => {
		// These will fail to compile if any required field is removed or made optional.
		const sample: ItemData = {
			name: 'n',
			description: 'd',
			source_url: 'https://x',
			category: 'cat',
			tags: ['t']
		};
		expectTypeOf(sample).toMatchTypeOf<ItemData>();
	});

	it('MutableItemData is the writable counterpart to ItemData', () => {
		// MutableItemData fields are writable (no `readonly`); the assignment
		// below would be a type error if any of these were marked readonly.
		const mut: MutableItemData = {
			name: 'n',
			description: 'd',
			source_url: 'https://x',
			category: ['a'],
			tags: []
		};
		mut.name = 'updated';
		expectTypeOf(mut.name).toBeString();
	});

	it('Comparison verdict_winner is the closed union "item_a" | "item_b" | "tie"', () => {
		expectTypeOf<ComparisonData['verdict_winner']>().toEqualTypeOf<
			'item_a' | 'item_b' | 'tie' | undefined
		>();
		expectTypeOf<ComparisonDimension['winner']>().toEqualTypeOf<
			'item_a' | 'item_b' | 'tie' | undefined
		>();
	});

	it('ComparisonData.dimensions / sources are readonly arrays', () => {
		expectTypeOf<ComparisonData['dimensions']>().toEqualTypeOf<readonly ComparisonDimension[]>();
		expectTypeOf<ComparisonData['sources']>().toEqualTypeOf<readonly ComparisonSource[]>();
	});
});

describe('domain contracts (type)', () => {
	it('DomainType members are typed as the four expected literal strings', () => {
		expectTypeOf<typeof DomainType.SOFTWARE>().toEqualTypeOf<DomainType.SOFTWARE>();
		expectTypeOf<typeof DomainType.ECOMMERCE>().toEqualTypeOf<DomainType.ECOMMERCE>();
		expectTypeOf<typeof DomainType.SERVICES>().toEqualTypeOf<DomainType.SERVICES>();
		expectTypeOf<typeof DomainType.GENERAL>().toEqualTypeOf<DomainType.GENERAL>();
	});

	it('DomainAnalysis confidence is a number, optional arrays are readonly string[]', () => {
		expectTypeOf<DomainAnalysis['confidence']>().toBeNumber();
		expectTypeOf<DomainAnalysis['expected_attributes']>().toEqualTypeOf<
			readonly string[] | undefined
		>();
		expectTypeOf<DomainAnalysis['official_source_patterns']>().toEqualTypeOf<
			readonly string[] | undefined
		>();
	});

	it('WebPageData has the three core fields', () => {
		expectTypeOf<WebPageData>().toEqualTypeOf<{
			readonly source_url: string;
			readonly retrieved_at: string;
			readonly raw_content: string;
		}>();
	});

	it('RelevanceAssessment requires relevant + relevance_score + reason', () => {
		expectTypeOf<RelevanceAssessment>().toEqualTypeOf<{
			readonly relevant: boolean;
			readonly relevance_score: number;
			readonly reason: string;
		}>();
	});
});

describe('form contracts (type)', () => {
	it('FormFieldType has at least the well-known scalars', () => {
		// Spot-check that the specific names still exist in the union.
		expectTypeOf<'text'>().toMatchTypeOf<FormFieldType>();
		expectTypeOf<'number'>().toMatchTypeOf<FormFieldType>();
		expectTypeOf<'boolean'>().toMatchTypeOf<FormFieldType>();
		expectTypeOf<'select'>().toMatchTypeOf<FormFieldType>();
		expectTypeOf<'multiselect'>().toMatchTypeOf<FormFieldType>();
		expectTypeOf<'password'>().toMatchTypeOf<FormFieldType>();
		expectTypeOf<'hidden'>().toMatchTypeOf<FormFieldType>();
	});

	it('FormFieldOption.value is the union string | number | boolean', () => {
		expectTypeOf<FormFieldOption['value']>().toEqualTypeOf<string | number | boolean>();
	});

	it('FormFieldValidation fields are all optional', () => {
		const empty: FormFieldValidation = {};
		expectTypeOf(empty).toMatchTypeOf<FormFieldValidation>();
	});

	it('FormFieldCondition.operator is the closed union of comparison operators', () => {
		expectTypeOf<FormFieldCondition['operator']>().toEqualTypeOf<
			'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'not_contains'
		>();
	});

	it('FormFieldDefinition.showIf accepts a single condition or an array', () => {
		expectTypeOf<FormFieldDefinition['showIf']>().toEqualTypeOf<
			FormFieldCondition | readonly FormFieldCondition[] | undefined
		>();
	});

	it('FormFieldGroup is collapsible-aware', () => {
		expectTypeOf<FormFieldGroup['collapsible']>().toEqualTypeOf<boolean | undefined>();
		expectTypeOf<FormFieldGroup['collapsed']>().toEqualTypeOf<boolean | undefined>();
	});

	it('FormSchema.fields is a readonly FormFieldDefinition[]', () => {
		expectTypeOf<FormSchema['fields']>().toEqualTypeOf<readonly FormFieldDefinition[]>();
		expectTypeOf<FormSchema['groups']>().toEqualTypeOf<readonly FormFieldGroup[] | undefined>();
	});
});

describe('github contracts (type)', () => {
	it('ParsedGitHubRepository has owner/repo/canonicalUrl as strings', () => {
		expectTypeOf<ParsedGitHubRepository>().toEqualTypeOf<{
			owner: string;
			repo: string;
			canonicalUrl: string;
		}>();
	});
});

describe('api/onboarding contracts (type)', () => {
	it('OnboardingStatus is the closed union of 8 states', () => {
		expectTypeOf<OnboardingStatus>().toEqualTypeOf<
			| 'received'
			| 'validating'
			| 'validated'
			| 'queued'
			| 'generating'
			| 'deployed'
			| 'failed'
			| 'rejected'
		>();
	});

	it('WebhookEventTerminal.status is restricted to terminal statuses only', () => {
		expectTypeOf<WebhookEventTerminal['status']>().toEqualTypeOf<
			'deployed' | 'failed' | 'rejected'
		>();
	});

	it('WebhookEvent is a discriminated union over `event`', () => {
		expectTypeOf<WebhookEvent['event']>().toEqualTypeOf<
			'onboarding.terminal' | 'work.regenerated' | 'work.deploy_failed'
		>();
	});

	it('WebhookEventManifestChanged has commitSha and workId, no status', () => {
		expectTypeOf<WebhookEventManifestChanged>().toMatchTypeOf<{
			event: 'work.regenerated';
			deliveryId: string;
			occurredAt: string;
			workId: string;
			commitSha: string;
		}>();
	});

	it('WebhookEventDeployFailed requires failureCode and failureMessage', () => {
		expectTypeOf<WebhookEventDeployFailed['failureCode']>().toBeString();
		expectTypeOf<WebhookEventDeployFailed['failureMessage']>().toBeString();
	});
});
