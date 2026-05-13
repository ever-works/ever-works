/**
 * Public surface of the category-icon subsystem (EW-357).
 *
 * Resolution order for any given category name:
 *   1. Cache lookup ({@link CategoryIconService}).
 *   2. {@link lookupCuratedIcon} — fast in-process map (Tier 1).
 *   3. AI generation via {@link generateCategoryIconSvg} (Tier 2).
 *   4. {@link getFallbackIcon} — generic tag glyph (last resort).
 *
 * All persisted SVG content passes through {@link sanitizeSvg} regardless
 * of source.
 */

export {
    CATEGORY_ICON_LIBRARY,
    getFallbackIcon,
    lookupCuratedIcon,
    type CuratedIcon,
    type CuratedIconKey,
} from './curated-mapping';

export {
    MAX_SVG_LENGTH,
    sanitizeSvg,
    type SanitizeFailure,
    type SanitizeFailureReason,
    type SanitizeResult,
    type SanitizeSuccess,
} from './svg-sanitizer';

export {
    generateCategoryIconSvg,
    type CategoryIconGenerateFailure,
    type CategoryIconGenerateOptions,
    type CategoryIconGenerateResult,
    type CategoryIconGenerateSuccess,
} from './ai-generator';

export {
    CategoryIconService,
    type CategoryIconResult,
    type CategoryIconSource,
    type EnsureCategoryIconOptions,
} from './category-icon.service';
