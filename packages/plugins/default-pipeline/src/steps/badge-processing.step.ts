import { z } from 'zod';
import type {
	MutableGenerationContext,
	StepExecutionContext,
	PipelineMetrics,
	MutableItemData,
	ItemBadges
} from '@ever-works/plugin';
import { DomainType } from '@ever-works/plugin';
import { BasePipelineStep } from '../base-pipeline-step.js';

interface BadgeEvaluationResult {
	badges: ItemBadges;
	evaluation_summary: string;
	evaluated_at: string;
	domain_type: DomainType;
}

type DomainBadgeConfig = Record<string, { values: string[]; description: string; required?: boolean }>;

const DOMAIN_BADGES: Record<DomainType, DomainBadgeConfig> = {
	software: {
		security: {
			values: ['A', 'F'],
			description: 'A = no known vulnerabilities, F = has vulnerabilities'
		},
		license: {
			values: ['A', 'F'],
			description: 'A = permissive license (MIT/Apache/BSD), F = restrictive/no license'
		},
		quality: {
			values: ['A', 'F'],
			description: 'A = well-maintained, F = unmaintained/broken'
		}
	},
	ecommerce: {
		verified: { values: ['yes', 'no'], description: 'Is this an official/brand source?' },
		price_range: { values: ['$', '$$', '$$$'], description: 'Indicative price range' },
		availability: {
			values: ['in_stock', 'limited', 'out_of_stock'],
			description: 'Availability signal'
		}
	},
	services: {
		availability: {
			values: ['online', 'in_person', 'both'],
			description: 'Service delivery mode'
		},
		booking: { values: ['instant', 'contact'], description: 'How to book' },
		verified: { values: ['yes', 'no'], description: 'Official/verified provider' }
	},
	general: {
		verified: { values: ['yes', 'no'], description: 'Official/verified source' }
	}
};

const BADGE_PROMPT = `You are an expert evaluator assigning badges for a directory item.

Item:
- Name: {name}
- Description: {description}
- Source URL: {source_url}
- Domain: {domain_type}

Badges to evaluate:
{badge_criteria}

Return a JSON object with badges and evaluation_summary. Omit badges you cannot determine with confidence.` as const;

/**
 * Badge Processing Step
 *
 * Evaluates and assigns badges to items based on domain type.
 */
export class BadgeProcessingStep extends BasePipelineStep {
	readonly name = 'Badges Processing';
	readonly stepId = 'badges-processing' as const;
	private readonly CONCURRENCY_LIMIT = 10;

	async run(context: MutableGenerationContext, execContext: StepExecutionContext): Promise<MutableGenerationContext> {
		const { request, finalItems, metrics, domainAnalysis } = context;
		const { logger, aiFacade } = execContext;
		const config = request.config || {};
		const domainType: DomainType = domainAnalysis?.domain_type ?? DomainType.SOFTWARE;

		if (config.badge_evaluation_enabled) {
			const processedItems = await this.processBadges(finalItems, domainType, metrics, logger, aiFacade);
			context.finalItems = processedItems;
		}

		context.metrics = {
			...metrics,
			itemsProcessed: context.finalItems.length
		};

		return context;
	}

	private async processBadges(
		items: MutableItemData[],
		domainType: DomainType,
		metrics: PipelineMetrics,
		logger: StepExecutionContext['logger'],
		aiFacade: StepExecutionContext['aiFacade']
	): Promise<MutableItemData[]> {
		try {
			const eligibleItems = items.filter((item) => this.isEligibleForBadgeEvaluation(item, domainType));

			if (eligibleItems.length === 0) {
				return items;
			}

			const badgeResults = await this.evaluateItemsBadges(eligibleItems, domainType, metrics, logger, aiFacade);

			return items.map((item) => {
				const badgeResult = badgeResults.get(item.source_url || '');
				if (badgeResult) {
					return { ...item, badges: badgeResult.badges };
				}
				return item;
			});
		} catch (error) {
			logger.error(`Failed to process badges: ${this.formatError(error)}`);
			return items;
		}
	}

	private async evaluateItemsBadges(
		items: MutableItemData[],
		domainType: DomainType,
		metrics: PipelineMetrics,
		logger: StepExecutionContext['logger'],
		aiFacade: StepExecutionContext['aiFacade']
	): Promise<Map<string, BadgeEvaluationResult>> {
		const results = new Map<string, BadgeEvaluationResult>();
		const chunks = this.chunkArray(items, this.CONCURRENCY_LIMIT);

		for (const chunk of chunks) {
			const promises = chunk.map(async (item) => {
				const result = await this.evaluateItemBadges(item, domainType, metrics, logger, aiFacade);
				if (result && item.source_url) {
					results.set(item.source_url, result);
				}
			});
			await Promise.all(promises);
		}

		return results;
	}

	private async evaluateItemBadges(
		item: MutableItemData,
		domainType: DomainType,
		metrics: PipelineMetrics,
		logger: StepExecutionContext['logger'],
		aiFacade: StepExecutionContext['aiFacade']
	): Promise<BadgeEvaluationResult | null> {
		try {
			if (domainType === 'software' && !this.isRepositoryUrl(item.source_url || '')) {
				return null;
			}

			if (!aiFacade.isConfigured()) {
				return null;
			}

			const schema = this.buildSchema(domainType);

			const { result, usage, cost } = await aiFacade.askJson(BADGE_PROMPT, schema, {
				temperature: 0,
				variables: {
					name: item.name,
					description: item.description || '',
					source_url: item.source_url || '',
					domain_type: domainType,
					badge_criteria: this.buildBadgeCriteria(domainType)
				},
				routing: {
					complexity: 'medium',
					taskId: 'badge-evaluation'
				}
			});

			const nowIso = new Date().toISOString();
			const badges: ItemBadges = {};

			if (result.badges) {
				Object.entries(result.badges).forEach(([key, badgeValue]) => {
					const bv = badgeValue as { value?: string; details?: string | null } | null;
					if (bv?.value) {
						badges[key] = {
							value: bv.value,
							evaluated_at: nowIso,
							details: bv.details ?? null
						};
					}
				});
			}

			this.accumulateMetrics(metrics, usage, cost);

			return {
				badges,
				evaluation_summary: result.evaluation_summary,
				evaluated_at: nowIso,
				domain_type: domainType
			};
		} catch (error) {
			logger.error(`Failed to evaluate badges for ${item.name}: ${this.formatError(error)}`);
			return null;
		}
	}

	private isEligibleForBadgeEvaluation(item: MutableItemData, domainType: DomainType): boolean {
		if (!item.source_url) {
			return false;
		}
		if (domainType === 'software') {
			return this.isRepositoryUrl(item.source_url);
		}
		return true;
	}

	private isRepositoryUrl(url: string): boolean {
		const patterns = [
			/github\.com\/[^\/]+\/[^\/]+/i,
			/gitlab\.com\/[^\/]+\/[^\/]+/i,
			/bitbucket\.org\/[^\/]+\/[^\/]+/i,
			/codeberg\.org\/[^\/]+\/[^\/]+/i,
			/sourceforge\.net\/projects\/[^\/]+/i
		];
		return patterns.some((p) => p.test(url));
	}

	private chunkArray<T>(array: T[], chunkSize: number): T[][] {
		const chunks: T[][] = [];
		for (let i = 0; i < array.length; i += chunkSize) {
			chunks.push(array.slice(i, i + chunkSize));
		}
		return chunks;
	}

	private buildSchema(domainType: DomainType) {
		const domainConfig = DOMAIN_BADGES[domainType] || DOMAIN_BADGES['general'];
		const badgeShape: Record<string, z.ZodTypeAny> = {};

		for (const [key, def] of Object.entries(domainConfig)) {
			badgeShape[key] = z
				.object({
					value: z.enum(def.values as [string, ...string[]]),
					details: z.string().nullable()
				})
				.nullable();
		}

		return z.object({
			evaluation_summary: z.string(),
			badges: z.object(badgeShape).nullable()
		});
	}

	private buildBadgeCriteria(domainType: DomainType): string {
		const config = DOMAIN_BADGES[domainType] || DOMAIN_BADGES['general'];
		return Object.entries(config)
			.map(([key, def]) => `- ${key}: [${def.values.join(', ')}] - ${def.description}`)
			.join('\n');
	}
}
