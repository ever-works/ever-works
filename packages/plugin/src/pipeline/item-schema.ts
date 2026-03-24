/**
 * Text representation of the ItemData schema for inclusion in prompts.
 * This tells the AI what structure to use for each item file.
 */
export const ITEM_SCHEMA_PROMPT_TEXT = `
Each item must be a JSON file with the following structure:

{
  "name": "string (required) - The item's canonical display name",
  "description": "string (required) - A concise, informative summary of the item and its relevance to the directory topic (2-4 sentences). Generate from page content if not directly available.",
  "source_url": "string (required) - The most direct, canonical URL for the item itself (homepage or official page). Must be real and working. Never use blog posts or articles *about* the item.",
  "category": "string (required) - ONE primary category based on the item's core function (e.g., 'Monitoring', 'CI/CD', 'Data Visualization')",
  "tags": ["string"] - 1-3 specific, descriptive tags (e.g., "open-source", "real-time", "cloud-native"),
  "featured": boolean - Whether this is a notable/featured item (optional, default false),
  "slug": "string - URL-friendly identifier (optional, auto-generated from name if omitted)",
  "brand": "string - At most one brand/company name per item (optional)",
  "brand_logo_url": "string - Canonical logo URL from official domain, prefer SVG/PNG (optional)",
  "images": ["string"] - Multiple high-quality image URLs (screenshots, product imagery) from official sources (optional),
  "markdown": "string - Detailed product/service information in markdown: features, pricing, use cases (see Markdown Rules below). Do not repeat category, tags, or other metadata fields."
}

Required fields: name, description, source_url, category

### Example

\`\`\`json
{
  "name": "Prometheus",
  "description": "Open-source monitoring and alerting toolkit designed for reliability and scalability, widely adopted in cloud-native environments.",
  "source_url": "https://prometheus.io",
  "category": "Monitoring",
  "tags": ["open-source", "metrics", "cloud-native"],
  "featured": false,
  "brand": "Cloud Native Computing Foundation",
  "brand_logo_url": "https://www.cncf.io/wp-content/uploads/2022/07/cncf-color-bg.svg",
  "images": ["https://prometheus.io/assets/architecture.png"],
  "markdown": "## Overview\\n\\nPrometheus is an open-source systems monitoring and alerting toolkit originally built at SoundCloud.\\n\\n## Features\\n\\n- Multi-dimensional data model with time series data identified by metric name and key/value pairs\\n- PromQL, a flexible query language\\n- No reliance on distributed storage; single server nodes are autonomous\\n- Time series collection via a pull model over HTTP\\n- Targets discovered via service discovery or static configuration\\n\\n## Pricing\\n\\nFree and open-source under the Apache 2.0 license."
}
\`\`\`
`.trim();
