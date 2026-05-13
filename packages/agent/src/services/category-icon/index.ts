/**
 * Public surface of the category-icon subsystem (EW-357).
 *
 * Resolution order for any given category name:
 *   1. {@link lookupCuratedIcon} — fast in-process map (Tier 1).
 *   2. AI generation via {@link CategoryIconGeneratorService} (Tier 2).
 *   3. {@link getFallbackIcon} — generic tag glyph (last resort).
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
