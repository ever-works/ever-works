import { stringSimilarity } from 'string-similarity-js';
import type { MutableItemData, StepExecutionContext } from '@ever-works/plugin';
import { extractKeywords } from '@ever-works/plugin/keywords';

export const MAX_CLUSTER_SIZE = 30;
const SIMILARITY_THRESHOLD = 0.5;

type Logger = StepExecutionContext['logger'];

export function chunkArray<T>(array: T[], chunkSize: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < array.length; i += chunkSize) {
		chunks.push(array.slice(i, i + chunkSize));
	}
	return chunks;
}

export function groupSimilarItems(items: MutableItemData[], logger: Logger): MutableItemData[][] {
	if (!items || items.length === 0) return [];
	if (items.length <= MAX_CLUSTER_SIZE) return [items];

	logger.log(`Grouping ${items.length} items using string similarity clustering`);

	function tr(text: string): string {
		return (text || '')
			.toLowerCase()
			.replace(/\s+v?(\d+\.)*\d+(\s+|$)/g, ' ')
			.replace(/[^\w\s]/g, ' ')
			.replace(/\s+/g, ' ')
			.trim();
	}

	const normalizedItems = items
		.map((item) => {
			if (!item.name) return { item, normalizedName: '' };
			const normalizedName = item.name
				.toLowerCase()
				.replace(/\s+v?(\d+\.)*\d+(\s+|$)/g, ' ')
				.replace(/\s+/g, ' ')
				.replace(/[^\w\s]/g, '')
				.trim();
			return { item, normalizedName };
		})
		.filter(({ normalizedName }) => normalizedName.length > 0);

	const clusters: MutableItemData[][] = [];
	const processed = new Set<number>();

	for (let i = 0; i < normalizedItems.length; i++) {
		if (processed.has(i)) continue;

		const { item: currentItem, normalizedName: currentName } = normalizedItems[i];
		const cluster: { score: number; item: MutableItemData }[] = [{ item: currentItem, score: 1 }];
		processed.add(i);

		for (let j = 0; j < normalizedItems.length; j++) {
			if (i === j || processed.has(j)) continue;

			const { item: candidateItem, normalizedName: candidateName } = normalizedItems[j];
			if (!currentName || !candidateName) continue;

			const similarity = stringSimilarity(currentName, candidateName);
			const splittedCurrent = tr(currentItem.name).split(' ');
			const splittedCandidate = tr(candidateItem.name).split(' ');

			const isSimilarByOccurrence =
				splittedCandidate.includes(splittedCurrent[0]?.trim()) ||
				splittedCurrent.includes(splittedCandidate[0]?.trim());

			if (similarity >= SIMILARITY_THRESHOLD || isSimilarByOccurrence) {
				cluster.push({ item: candidateItem, score: similarity });
				processed.add(j);
			}
		}

		clusters.push(cluster.sort((a, b) => b.score - a.score).map((c) => c.item));
	}

	const MIN_CLUSTER_SIZE = 5;
	const finalClusters: MutableItemData[][] = [];
	let currentCluster: MutableItemData[] = [];
	const sortedClusters = clusters.sort((a, b) => b.length - a.length);

	for (const cluster of sortedClusters) {
		if (cluster.length >= MIN_CLUSTER_SIZE) {
			if (cluster.length > MAX_CLUSTER_SIZE) {
				const numSub = Math.ceil(cluster.length / MAX_CLUSTER_SIZE);
				const subSize = Math.ceil(cluster.length / numSub);
				for (let i = 0; i < cluster.length; i += subSize) {
					finalClusters.push(cluster.slice(i, i + subSize));
				}
			} else {
				finalClusters.push(cluster);
			}
		} else {
			if (currentCluster.length + cluster.length <= MAX_CLUSTER_SIZE) {
				currentCluster = currentCluster.concat(cluster);
			} else {
				if (currentCluster.length > 0) finalClusters.push(currentCluster);
				currentCluster = cluster;
			}
		}
	}

	if (currentCluster.length > 0) finalClusters.push(currentCluster);

	const processedItems = new Set(finalClusters.flat());
	const remainingItems = items.filter((item) => !processedItems.has(item));
	if (remainingItems.length > 0) {
		for (let i = 0; i < remainingItems.length; i += MAX_CLUSTER_SIZE) {
			finalClusters.push(remainingItems.slice(i, i + MAX_CLUSTER_SIZE));
		}
	}

	logger.log(`Created ${finalClusters.length} clusters, avg size ${Math.round(items.length / finalClusters.length)}`);
	const sizes = finalClusters.map((c) => c.length).sort((a, b) => b - a);
	logger.log(`Cluster sizes: ${sizes.slice(0, 10).join(', ')}${sizes.length > 10 ? '...' : ''}`);

	return finalClusters;
}

export function findRelevantExistingItems(
	newItems: MutableItemData[],
	existingItems: MutableItemData[],
	maxRelevantItems: number = 100
): MutableItemData[] {
	if (!existingItems || existingItems.length === 0) return [];
	if (!newItems || newItems.length === 0) return [];
	if (existingItems.length <= maxRelevantItems) return existingItems;

	const newItemKeywords = new Set<string>();
	for (const item of newItems) {
		for (const kw of extractKeywords(item.name + ' ' + (item.description || ''))) {
			newItemKeywords.add(kw);
		}
	}

	return existingItems
		.map((existingItem) => {
			const kws = extractKeywords(existingItem.name + ' ' + (existingItem.description || ''));
			const score = kws.filter((k) => newItemKeywords.has(k)).length / Math.max(kws.length, 1);
			return { item: existingItem, score };
		})
		.sort((a, b) => b.score - a.score)
		.slice(0, maxRelevantItems)
		.map((s) => s.item);
}
