/**
 * Text representation of the ItemData schema for inclusion in prompts.
 * This tells Claude Code what structure to use for each item file.
 */
export const ITEM_SCHEMA_TEXT = `
Each item must be a JSON file with the following structure:

{
  "name": "string (required) - The item's display name",
  "description": "string (required) - A concise, informative description (2-4 sentences)",
  "source_url": "string (required) - The item's official website or primary URL (must be valid and real)",
  "category": "string (required) - The primary category this item belongs to",
  "tags": ["string"] - Array of relevant tags (2-8 tags recommended),
  "featured": boolean - Whether this is a notable/featured item (optional, default false),
  "slug": "string - URL-friendly identifier (optional, auto-generated from name if omitted)",
  "brand": "string - Brand or company name (optional)",
  "brand_logo_url": "string - URL to the brand's logo (optional)",
  "images": ["string"] - Array of image URLs (optional),
  "markdown": "string - Extended description in markdown format"
}

Required fields: name, description, source_url, category
`.trim();
