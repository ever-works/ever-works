import { Injectable, Logger } from '@nestjs/common';
import * as stringSimilarity from 'string-similarity';
import { ItemData } from '../../dto';

@Injectable()
export class SharedUtilsService {
    private readonly logger = new Logger(SharedUtilsService.name);

    // Shared constants
    readonly MAX_CLUSTER_SIZE = 40;
    readonly SIMILARITY_THRESHOLD = 0.5;

    /**
     * Deduplicates items by a specific field
     * @param items Array of items to deduplicate
     * @param field Field to deduplicate by
     */
    deduplicateByField<T extends Record<string, any>>(items: T[], field: keyof T): T[] {
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
    groupSimilarItems(items: ItemData[]): ItemData[][] {
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
                let normalizedName = item.name
                    .toLowerCase()
                    .replace(/\s+v?(\d+\.)*\d+(\s+|$)/g, ' ')
                    .replace(/\s+/g, ' ')
                    .replace(/[^\w\s]/g, '')
                    .trim();

                return { item, normalizedName };
            })
            .filter(({ normalizedName }) => normalizedName.length > 0);

        // Create initial clusters using hierarchical clustering
        const clusters: ItemData[][] = [];
        const processed = new Set<number>();

        // For each unprocessed item
        for (let i = 0; i < normalizedItems.length; i++) {
            if (processed.has(i)) continue;

            const { item: currentItem, normalizedName: currentName } = normalizedItems[i];

            const cluster: ItemData[] = [currentItem];
            processed.add(i);

            // Find similar items
            for (let j = 0; j < normalizedItems.length; j++) {
                if (i === j || processed.has(j)) continue;

                const { item: candidateItem, normalizedName: candidateName } = normalizedItems[j];

                // Skip empty names
                if (!currentName || !candidateName) continue;

                // Calculate similarity
                const similarity = stringSimilarity.compareTwoStrings(currentName, candidateName);

                // Check if the candidate name appears before the current name
                const splittedCurrentItemName = tr(currentItem.name).split(' ');
                const splittedCandidateName = tr(candidateItem.name).split(' ');

                const isSimilarByOccurrence =
                    splittedCandidateName.includes(splittedCurrentItemName[0]?.trim()) ||
                    splittedCurrentItemName.includes(splittedCandidateName[0]?.trim());

                // If similar enough, add to cluster
                if (similarity >= this.SIMILARITY_THRESHOLD || isSimilarByOccurrence) {
                    cluster.push(candidateItem);
                    processed.add(j);
                }
            }

            clusters.push(cluster);
        }

        // Merge small clusters if needed
        const MIN_CLUSTER_SIZE = 5;
        const MAX_CLUSTER_SIZE = this.MAX_CLUSTER_SIZE;
        const finalClusters: ItemData[][] = [];
        let currentCluster: ItemData[] = [];

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
        const processedItems = new Set(finalClusters.flatMap((cluster) => cluster));
        const remainingItems = items.filter((item) => !processedItems.has(item));

        if (remainingItems.length > 0) {
            // Split remaining items into reasonably sized clusters
            for (let i = 0; i < remainingItems.length; i += MAX_CLUSTER_SIZE) {
                finalClusters.push(remainingItems.slice(i, i + MAX_CLUSTER_SIZE));
            }
        }

        this.logger.log(
            `Created ${finalClusters.length} clusters with average size of ${Math.round(items.length / finalClusters.length)} items`,
        );

        // Log cluster sizes for debugging
        const clusterSizes = finalClusters.map((c) => c.length).sort((a, b) => b - a);

        this.logger.log(
            `Cluster sizes: ${clusterSizes.slice(0, 10).join(', ')}${clusterSizes.length > 10 ? '...' : ''}`,
        );

        return finalClusters;
    }

    /**
     * Maps ItemData to a simplified format for AI processing
     * @param item ItemData to map
     */
    itemMap(item: ItemData) {
        return {
            name: item.name,
            description: item.description,
            url: item.source_url,
        };
    }

    /**
     * Adds a delay between processing chunks to avoid rate limiting
     * @param milliseconds Delay in milliseconds
     */
    async addProcessingDelay(milliseconds: number): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, milliseconds));
    }
}
