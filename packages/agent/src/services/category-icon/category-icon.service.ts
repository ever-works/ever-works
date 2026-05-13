import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import pMap from 'p-map';
import type { Category, Collection, FacadeOptions } from '@ever-works/plugin';

import { AiFacadeService } from '../../facades/ai.facade';
import {
    generateCategoryIconSvg,
    type CategoryIconGenerateResult,
} from './ai-generator';
import {
    getFallbackIcon,
    lookupCuratedIcon,
} from './curated-mapping';
import { sanitizeSvg } from './svg-sanitizer';

/**
 * How many categories to resolve in parallel during bulk enrichment.
 * AI calls are the bottleneck — keep concurrency modest so a single
 * generation pass doesn't fan out into rate-limit territory.
 */
const ENRICHMENT_CONCURRENCY = 4;

/** What the entity already has — used to decide whether to skip. */
type IconBearing = { readonly icon_svg?: string };

/** Cache key version. Bump to invalidate the entire icon cache (e.g.
 *  if the prompt template or palette changes meaningfully). */
const CACHE_KEY_VERSION = 'v1';

/** Effectively-permanent TTL for cached icons (90 days). Icons are
 *  stable artifacts; this is a soft refresh interval, not a hard
 *  expiry. Browsers / consumers never see the cache, only the YAML. */
const CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const CACHE_KEY_PREFIX = `category-icon:${CACHE_KEY_VERSION}`;

export type CategoryIconSource = 'cache' | 'curated' | 'ai' | 'fallback';

export interface CategoryIconResult {
    /** Sanitized SVG markup ready to persist into Category.icon_svg. */
    readonly svg: string;
    /** Where the SVG came from — useful for telemetry / logging. */
    readonly source: CategoryIconSource;
    /** Byte length of the SVG (UTF-8). */
    readonly bytes: number;
    /** Model name when source === 'ai'; undefined otherwise. */
    readonly model?: string;
}

export interface EnsureCategoryIconOptions {
    /** Category name (free-form). */
    readonly name: string;
    /** Optional description used as additional AI prompt context. */
    readonly description?: string;
    /** AI facade context — required for AI generation. */
    readonly facadeOptions: FacadeOptions;
    /**
     * Skip the AI tier entirely. When true, returns curated → fallback
     * only. Useful when the host work has AI icon generation disabled.
     */
    readonly disableAi?: boolean;
}

/**
 * Resolves an SVG icon for a category, consulting tiered sources in
 * order: cache → curated lookup → AI generation → static fallback.
 *
 * The cache is keyed by normalized category name (not by workId), so a
 * once-generated icon for "Productivity" is reused across every work
 * the platform serves. Cache misses for AI-tier hits are written back
 * before returning.
 */
@Injectable()
export class CategoryIconService {
    private readonly logger = new Logger(CategoryIconService.name);

    constructor(
        private readonly aiFacade: AiFacadeService,
        @Optional()
        @Inject(CACHE_MANAGER)
        private readonly cache?: Cache,
    ) {}

    /**
     * Resolve the icon for a category. Always returns a usable SVG —
     * the fallback tier guarantees a non-null result even when AI and
     * curated lookups both miss.
     */
    async ensureIcon(options: EnsureCategoryIconOptions): Promise<CategoryIconResult> {
        const normalizedName = normalizeName(options.name);
        if (!normalizedName) {
            return this.fallback();
        }

        // 1. Cache hit — return immediately.
        const cacheKey = buildCacheKey(normalizedName);
        const cached = await this.readCache(cacheKey);
        if (cached) {
            return {
                svg: cached,
                source: 'cache',
                bytes: Buffer.byteLength(cached, 'utf8'),
            };
        }

        // 2. Curated lookup — fast, free, visually consistent.
        const curated = lookupCuratedIcon(options.name);
        if (curated) {
            const sanitized = sanitizeSvg(curated.svg);
            if (sanitized.ok) {
                await this.writeCache(cacheKey, sanitized.svg);
                return {
                    svg: sanitized.svg,
                    source: 'curated',
                    bytes: sanitized.bytes,
                };
            }
            // Curated icons are sanitizer-clean by construction; this
            // would indicate a regression in the library.
            this.logger.warn(
                `Curated icon for "${options.name}" failed sanitization: ${sanitized.reason}`,
            );
        }

        // 3. AI generation — only when allowed.
        if (!options.disableAi) {
            const generated = await this.tryGenerate(options);
            if (generated) {
                await this.writeCache(cacheKey, generated.svg);
                return generated;
            }
        }

        // 4. Hard fallback — guaranteed non-null icon.
        return this.fallback();
    }

    /**
     * Bulk enrichment for an array of categories. Items that already
     * have a non-empty `icon_svg` are returned untouched. Resolution
     * runs at controlled concurrency so a 50-category pass doesn't
     * blow through provider rate limits.
     *
     * Failures for individual categories never abort the batch — the
     * affected entry retains whatever icon_svg it came in with (or
     * none, which the UI handles via the fallback render path).
     */
    async enrichCategories<T extends Category>(
        categories: readonly T[],
        options: Omit<EnsureCategoryIconOptions, 'name' | 'description'>,
    ): Promise<T[]> {
        if (!categories || categories.length === 0) {
            return [];
        }

        return pMap(
            categories,
            async (category) => this.enrichOne(category, options),
            { concurrency: ENRICHMENT_CONCURRENCY },
        );
    }

    /**
     * Same as {@link enrichCategories} but for collections (which share
     * the icon_svg field shape).
     */
    async enrichCollections<T extends Collection>(
        collections: readonly T[],
        options: Omit<EnsureCategoryIconOptions, 'name' | 'description'>,
    ): Promise<T[]> {
        if (!collections || collections.length === 0) {
            return [];
        }

        return pMap(
            collections,
            async (collection) => this.enrichOne(collection, options),
            { concurrency: ENRICHMENT_CONCURRENCY },
        );
    }

    private async enrichOne<T extends IconBearing & { name: string; description?: string }>(
        entity: T,
        options: Omit<EnsureCategoryIconOptions, 'name' | 'description'>,
    ): Promise<T> {
        if (entity.icon_svg && entity.icon_svg.trim().length > 0) {
            return entity;
        }

        try {
            const resolved = await this.ensureIcon({
                ...options,
                name: entity.name,
                description: entity.description,
            });
            return { ...entity, icon_svg: resolved.svg };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(`Failed to enrich icon for "${entity.name}": ${message}`);
            return entity;
        }
    }

    private async tryGenerate(
        options: EnsureCategoryIconOptions,
    ): Promise<CategoryIconResult | null> {
        const result: CategoryIconGenerateResult = await generateCategoryIconSvg(this.aiFacade, {
            name: options.name,
            description: options.description,
            facadeOptions: options.facadeOptions,
            logger: this.logger,
        });

        if (!result.ok) {
            this.logger.debug(
                `AI icon generation for "${options.name}" did not produce a usable SVG: ${result.reason}`,
            );
            return null;
        }

        return {
            svg: result.svg,
            source: 'ai',
            bytes: result.bytes,
            model: result.model,
        };
    }

    private fallback(): CategoryIconResult {
        const icon = getFallbackIcon();
        // Defensive sanitize so the fallback obeys the same hygiene rules.
        const sanitized = sanitizeSvg(icon.svg);
        if (sanitized.ok) {
            return {
                svg: sanitized.svg,
                source: 'fallback',
                bytes: sanitized.bytes,
            };
        }
        // Should never happen — the curated library ships with valid SVGs.
        return {
            svg: icon.svg,
            source: 'fallback',
            bytes: Buffer.byteLength(icon.svg, 'utf8'),
        };
    }

    private async readCache(key: string): Promise<string | null> {
        if (!this.cache) {
            return null;
        }
        try {
            const value = await this.cache.get<string>(key);
            return typeof value === 'string' && value.length > 0 ? value : null;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.debug(`Cache read miss for ${key}: ${message}`);
            return null;
        }
    }

    private async writeCache(key: string, svg: string): Promise<void> {
        if (!this.cache) {
            return;
        }
        try {
            await this.cache.set(key, svg, CACHE_TTL_MS);
        } catch (error) {
            // A cache failure is never fatal — the caller already has
            // the SVG it needs and the next request will retry the
            // resolution. Log and move on.
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(`Failed to cache icon for ${key}: ${message}`);
        }
    }
}

function normalizeName(name: string): string {
    return (name ?? '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function buildCacheKey(normalizedName: string): string {
    return `${CACHE_KEY_PREFIX}:${normalizedName}`;
}
