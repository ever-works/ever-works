import type { Logger } from '@nestjs/common';
import type { FacadeOptions, IAiFacade } from '@ever-works/plugin';

import { sanitizeSvg } from './svg-sanitizer';

/**
 * Locked-down system prompt used to coax an LLM into emitting a single
 * minimal SVG suitable for category icons. The output constraints are
 * verified by the SVG sanitizer regardless of how well the model
 * complies, so this prompt is best-effort, not a safety boundary.
 */
const ICON_SYSTEM_PROMPT = `You generate tiny, minimal SVG icons for app category badges.

Rules — you MUST follow ALL of them:
1. Output ONE <svg> element and NOTHING else. No prose, no markdown,
   no explanation, no <?xml?> declaration, no <!DOCTYPE>.
2. Root attributes MUST be exactly:
   xmlns="http://www.w3.org/2000/svg"
   viewBox="0 0 24 24"
   fill="none"
   stroke="currentColor"
   stroke-width="2"
   stroke-linecap="round"
   stroke-linejoin="round"
3. Use ONLY these elements: <path>, <circle>, <rect>, <line>,
   <polyline>, <polygon>, <ellipse>. Nothing else.
4. NO <script>, NO <foreignObject>, NO <iframe>, NO <embed>, NO <object>,
   NO <use> with external href, NO <image>, NO <text>, NO <animate>,
   NO comments, NO event handler attributes (on*), NO inline style="".
5. Use stroke="currentColor" so the consumer can theme the icon.
   Do NOT pick a fill or stroke color other than currentColor or "none".
6. Keep the geometry simple — under 6 child elements is ideal.
   Total payload should fit comfortably under 1KB.
7. The icon should be visually distinct and readable at 16×16 pixels.

Category to draw: "{category_name}"
{category_description_block}
Output the SVG and nothing else.`;

const CATEGORY_DESCRIPTION_TEMPLATE = (description: string): string =>
    `Description (use this to inform what the icon depicts): "${description}"\n`;

const MARKDOWN_FENCE_RE = /^```(?:svg|xml|html)?\s*\n?|\n?```\s*$/g;

export interface CategoryIconGenerateOptions {
    /** Category name (free-form, e.g. "Time Tracking", "Open-Source"). */
    readonly name: string;
    /** Optional description used as additional prompt context. */
    readonly description?: string;
    /** Facade context — required by AiFacade for plugin/key resolution. */
    readonly facadeOptions: FacadeOptions;
    /** Optional logger for diagnostic output. */
    readonly logger?: Pick<Logger, 'log' | 'warn' | 'debug' | 'error'>;
}

export interface CategoryIconGenerateSuccess {
    readonly ok: true;
    readonly svg: string;
    readonly bytes: number;
    readonly model: string;
}

export interface CategoryIconGenerateFailure {
    readonly ok: false;
    readonly reason:
        | 'no-content'
        | 'sanitize-failed'
        | 'facade-error';
    readonly detail?: string;
}

export type CategoryIconGenerateResult =
    | CategoryIconGenerateSuccess
    | CategoryIconGenerateFailure;

/**
 * Ask the configured AI provider for an SVG icon describing a category.
 * The output is run through the SVG sanitizer before being returned;
 * dangerous or malformed responses become a `sanitize-failed` failure
 * the caller can fall back from gracefully.
 */
export async function generateCategoryIconSvg(
    aiFacade: IAiFacade,
    options: CategoryIconGenerateOptions,
): Promise<CategoryIconGenerateResult> {
    const { name, description, facadeOptions, logger } = options;

    const prompt = ICON_SYSTEM_PROMPT.replace('{category_name}', name).replace(
        '{category_description_block}',
        description ? CATEGORY_DESCRIPTION_TEMPLATE(description) : '',
    );

    let raw: string;
    let model: string;

    try {
        const response = await aiFacade.createChatCompletion(
            {
                messages: [{ role: 'user', content: prompt }],
                // Low temperature: we want consistency, not creativity.
                temperature: 0.2,
            },
            facadeOptions,
        );

        const content = response.choices[0]?.message?.content;
        if (!content || typeof content !== 'string') {
            return { ok: false, reason: 'no-content' };
        }

        raw = content;
        model = response.model;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger?.warn(`Category icon generation failed for "${name}": ${message}`);
        return { ok: false, reason: 'facade-error', detail: message };
    }

    const stripped = stripMarkdownFences(raw).trim();

    const sanitized = sanitizeSvg(stripped);
    if (sanitized.ok === false) {
        const reason = sanitized.reason;
        logger?.warn(
            `Category icon for "${name}" failed sanitization (${reason}); model=${model}`,
        );
        return {
            ok: false,
            reason: 'sanitize-failed',
            detail: reason,
        };
    }

    return {
        ok: true,
        svg: sanitized.svg,
        bytes: sanitized.bytes,
        model,
    };
}

/**
 * Many models wrap code output in ```svg / ``` fences despite being
 * asked not to. Strip those before sanitization rather than rejecting
 * an otherwise-valid icon.
 */
function stripMarkdownFences(input: string): string {
    return input.replace(MARKDOWN_FENCE_RE, '').trim();
}
