import stringSimilarity from 'string-similarity-js';
import type { MutableItemData, StepExecutionContext } from '@ever-works/plugin';

/**
 * Shared Utilities for Data Aggregation
 *
 * Plain utility class (no NestJS decorators) providing common
 * functionality for deduplication and data processing.
 */
export class SharedUtilsService {
	private readonly logger: StepExecutionContext['logger'];

	// Shared constants
	readonly MAX_CLUSTER_SIZE = 30;
	readonly SIMILARITY_THRESHOLD = 0.5;

	constructor(logger: StepExecutionContext['logger']) {
		this.logger = logger;
	}

	/**
	 * Deduplicates items by a specific field
	 * @param items Array of items to deduplicate
	 * @param field Field to deduplicate by
	 */
	deduplicateByField<T extends { [K in F]?: string | null | undefined } & object, F extends string>(
		items: T[],
		field: F
	): T[] {
		if (!items || items.length === 0) return [];

		// Skip deduplication if the field doesn't exist in the items
		if (!items.some((item) => item[field] !== undefined && item[field] !== null)) {
			return items;
		}

		const map = new Map<string, T>();
		for (const item of items) {
			const value = item[field];
			if (value !== undefined && value !== null && typeof value === 'string') {
				map.set(value, item);
			} else {
				// If the field is missing or not a string, use a unique identifier
				map.set(`__no_${String(field)}_${Math.random()}`, item);
			}
		}
		return Array.from(map.values());
	}

	/**
	 * Split an array into chunks of specified size
	 * @param array Array to split
	 * @param chunkSize Size of each chunk
	 */
	chunkArray<T>(array: T[], chunkSize: number): T[][] {
		const chunks: T[][] = [];
		for (let i = 0; i < array.length; i += chunkSize) {
			chunks.push(array.slice(i, i + chunkSize));
		}
		return chunks;
	}

	/**
	 * Group similar items together to improve deduplication efficiency using string similarity
	 * @param items Items to group
	 */
	groupSimilarItems(items: MutableItemData[]): MutableItemData[][] {
		if (!items || items.length === 0) return [];
		if (items.length <= this.MAX_CLUSTER_SIZE) return [items];

		this.logger.log(`Grouping ${items.length} items using string similarity clustering`);

		// Replace any special characters with spaces
		function tr(text: string): string {
			return (text || '')
				.toLowerCase()
				.replace(/\s+v?(\d+\.)*\d+(\s+|$)/g, ' ')
				.replace(/[^\w\s]/g, ' ')
				.replace(/\s+/g, ' ')
				.trim();
		}

		// Extract normalized names for similarity comparison
		const normalizedItems = items
			.map((item) => {
				// Skip items without names
				if (!item.name) return { item, normalizedName: '' };

				// Normalize the name: lowercase, remove version numbers, trim
				const normalizedName = item.name
					.toLowerCase()
					.replace(/\s+v?(\d+\.)*\d+(\s+|$)/g, ' ')
					.replace(/\s+/g, ' ')
					.replace(/[^\w\s]/g, '')
					.trim();

				return { item, normalizedName };
			})
			.filter(({ normalizedName }) => normalizedName.length > 0);

		// Create initial clusters using hierarchical clustering
		const clusters: MutableItemData[][] = [];
		const processed = new Set<number>();

		// For each unprocessed item
		for (let i = 0; i < normalizedItems.length; i++) {
			if (processed.has(i)) continue;

			const { item: currentItem, normalizedName: currentName } = normalizedItems[i];

			const cluster: { score: number; item: MutableItemData }[] = [{ item: currentItem, score: 1 }];
			processed.add(i);

			// Find similar items
			for (let j = 0; j < normalizedItems.length; j++) {
				if (i === j || processed.has(j)) continue;

				const { item: candidateItem, normalizedName: candidateName } = normalizedItems[j];

				// Skip empty names
				if (!currentName || !candidateName) continue;

				// Calculate similarity
				const similarity = stringSimilarity(currentName, candidateName);

				// Check if the candidate name appears before the current name
				const splittedCurrentItemName = tr(currentItem.name).split(' ');
				const splittedCandidateName = tr(candidateItem.name).split(' ');

				const isSimilarByOccurrence =
					splittedCandidateName.includes(splittedCurrentItemName[0]?.trim()) ||
					splittedCurrentItemName.includes(splittedCandidateName[0]?.trim());

				// If similar enough, add to cluster
				if (similarity >= this.SIMILARITY_THRESHOLD || isSimilarByOccurrence) {
					cluster.push({
						item: candidateItem,
						score: similarity
					});
					processed.add(j);
				}
			}

			// Sort cluster by score
			const clusterItems = cluster.sort((a, b) => b.score - a.score).map((c) => c.item);

			clusters.push(clusterItems);
		}

		// Merge small clusters if needed
		const MIN_CLUSTER_SIZE = 5;
		const MAX_CLUSTER_SIZE = this.MAX_CLUSTER_SIZE;
		const finalClusters: MutableItemData[][] = [];
		let currentCluster: MutableItemData[] = [];

		// Sort clusters by size (largest first) for better distribution
		const sortedClusters = clusters.sort((a, b) => b.length - a.length);

		// Process large clusters first
		for (const cluster of sortedClusters) {
			if (cluster.length >= MIN_CLUSTER_SIZE) {
				// If cluster is too large, split it
				if (cluster.length > MAX_CLUSTER_SIZE) {
					const numSubClusters = Math.ceil(cluster.length / MAX_CLUSTER_SIZE);
					const subClusterSize = Math.ceil(cluster.length / numSubClusters);

					for (let i = 0; i < cluster.length; i += subClusterSize) {
						const subCluster = cluster.slice(i, i + subClusterSize);
						finalClusters.push(subCluster);
					}
				} else {
					finalClusters.push(cluster);
				}
			} else {
				// Small clusters get merged until they reach optimal size
				if (currentCluster.length + cluster.length <= MAX_CLUSTER_SIZE) {
					currentCluster = currentCluster.concat(cluster);
				} else {
					if (currentCluster.length > 0) {
						finalClusters.push(currentCluster);
					}
					currentCluster = cluster;
				}
			}
		}

		// Add the last merged cluster if not empty
		if (currentCluster.length > 0) {
			finalClusters.push(currentCluster);
		}

		// Handle any remaining items that weren't processed
		const processedItems = new Set(finalClusters.flat());
		const remainingItems = items.filter((item) => !processedItems.has(item));

		if (remainingItems.length > 0) {
			// Split remaining items into reasonably sized clusters
			for (let i = 0; i < remainingItems.length; i += MAX_CLUSTER_SIZE) {
				finalClusters.push(remainingItems.slice(i, i + MAX_CLUSTER_SIZE));
			}
		}

		this.logger.log(
			`Created ${finalClusters.length} clusters with average size of ${Math.round(items.length / finalClusters.length)} items`
		);

		// Log cluster sizes for debugging
		const clusterSizes = finalClusters.map((c) => c.length).sort((a, b) => b - a);

		this.logger.log(
			`Cluster sizes: ${clusterSizes.slice(0, 10).join(', ')}${clusterSizes.length > 10 ? '...' : ''}`
		);

		return finalClusters;
	}

	/**
	 * Maps MutableItemData to a simplified format for AI processing
	 * @param item MutableItemData to map
	 */
	itemMap(item: MutableItemData): Record<string, unknown> {
		return { ...item };
	}

	/**
	 * Adds a delay between processing chunks to avoid rate limiting
	 * @param milliseconds Delay in milliseconds
	 */
	async addProcessingDelay(milliseconds: number): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, milliseconds));
	}

	/**
	 * Creates a fast lookup index for existing items using multiple keys
	 * @param items Items to index
	 */
	createItemLookupIndex(items: MutableItemData[]): Map<string, MutableItemData> {
		const index = new Map<string, MutableItemData>();

		for (const item of items) {
			// Index by slug
			if (item.slug) {
				index.set(`slug:${item.slug.toLowerCase()}`, item);
			}

			// Index by source URL
			if (item.source_url) {
				index.set(`url:${item.source_url.toLowerCase()}`, item);
			}

			// Index by normalized name
			const normalizedName = this.normalizeItemName(item.name);
			if (normalizedName) {
				index.set(`name:${normalizedName}`, item);
			}
		}

		return index;
	}

	/**
	 * Normalizes item name for comparison
	 * @param name Item name to normalize
	 */
	normalizeItemName(name: string): string {
		if (!name) return '';

		return name
			.toLowerCase()
			.replace(/\s+v?(\d+\.)*\d+(\s+|$)/g, ' ')
			.replace(/[^\w\s]/g, ' ')
			.replace(/\s+/g, ' ')
			.replace(/\b(js|javascript|library|framework|tool|app|application)\b/g, '')
			.trim();
	}

	/**
	 * Checks if a new item already exists in the lookup index using multiple strategies
	 * @param newItem New item to check
	 * @param lookupIndex Lookup index of existing items
	 */
	isItemDuplicate(newItem: MutableItemData, lookupIndex: Map<string, MutableItemData>): boolean {
		// Check by slug
		if (newItem.slug && lookupIndex.has(`slug:${newItem.slug.toLowerCase()}`)) {
			return true;
		}

		// Check by exact source URL
		if (newItem.source_url && lookupIndex.has(`url:${newItem.source_url.toLowerCase()}`)) {
			return true;
		}

		// Check by normalized name
		const normalizedName = this.normalizeItemName(newItem.name);
		if (normalizedName && lookupIndex.has(`name:${normalizedName}`)) {
			return true;
		}

		return false;
	}

	/**
	 * Filters new items using manual deduplication strategies
	 * @param existingItems Existing items
	 * @param newItems New items to filter
	 */
	filterNewItemsManually(existingItems: MutableItemData[], newItems: MutableItemData[]): MutableItemData[] {
		if (!newItems || newItems.length === 0) return [];
		if (!existingItems || existingItems.length === 0) return newItems;

		// Create lookup index for fast comparison
		const lookupIndex = this.createItemLookupIndex(existingItems);

		// Filter out duplicates
		return newItems.filter((newItem) => !this.isItemDuplicate(newItem, lookupIndex));
	}

	/**
	 * Finds relevant existing items for AI comparison using similarity
	 * @param newItems New items to compare
	 * @param existingItems All existing items
	 * @param maxRelevantItems Maximum number of relevant items to return
	 */
	findRelevantExistingItems(
		newItems: MutableItemData[],
		existingItems: MutableItemData[],
		maxRelevantItems: number = 100
	): MutableItemData[] {
		if (!existingItems || existingItems.length === 0) return [];
		if (!newItems || newItems.length === 0) return [];

		// If existing items is small, return all
		if (existingItems.length <= maxRelevantItems) {
			return existingItems;
		}

		// Extract keywords from new items
		const newItemKeywords = new Set<string>();
		for (const item of newItems) {
			const keywords = this.extractKeywords(item.name + ' ' + (item.description || ''));
			keywords.forEach((keyword) => newItemKeywords.add(keyword));
		}

		// Score existing items by relevance
		const scoredItems = existingItems.map((existingItem) => {
			const existingKeywords = this.extractKeywords(existingItem.name + ' ' + (existingItem.description || ''));
			const commonKeywords = existingKeywords.filter((keyword) => newItemKeywords.has(keyword));
			const score = commonKeywords.length / Math.max(existingKeywords.length, 1);

			return { item: existingItem, score };
		});

		// Sort by score and return top items
		return scoredItems
			.sort((a, b) => b.score - a.score)
			.slice(0, maxRelevantItems)
			.map((scored) => scored.item);
	}

	/**
	 * Extracts keywords from text for similarity comparison
	 * @param text Text to extract keywords from
	 */
	private extractKeywords(text: string): string[] {
		if (!text) return [];

		return text
			.toLowerCase()
			.replace(/[^\w\s]/g, ' ')
			.split(/\s+/)
			.filter((word) => word.length > 2) // Filter out short words
			.filter((word) => !this.isStopWord(word)) // Filter out stop words
			.slice(0, 20); // Limit to first 20 keywords
	}

	/**
	 * Checks if a word is a stop word
	 * @param word Word to check
	 */
	private isStopWord(word: string): boolean {
		const stopWords = new Set([
			'the',
			'and',
			'for',
			'are',
			'but',
			'not',
			'you',
			'all',
			'can',
			'had',
			'her',
			'was',
			'one',
			'our',
			'out',
			'day',
			'get',
			'has',
			'him',
			'his',
			'how',
			'its',
			'may',
			'new',
			'now',
			'old',
			'see',
			'two',
			'who',
			'boy',
			'did',
			'man',
			'way',
			'she',
			'use',
			'your',
			'said',
			'each',
			'make',
			'most',
			'over',
			'such',
			'very',
			'what',
			'with',
			'have',
			'from',
			'they',
			'know',
			'want',
			'been',
			'good',
			'much',
			'some',
			'time',
			'will',
			'when',
			'come',
			'here',
			'just',
			'like',
			'long',
			'many',
			'than',
			'them',
			'well',
			'were'
		]);
		return stopWords.has(word);
	}
}
