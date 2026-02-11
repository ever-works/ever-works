import axios from 'axios';
import type { PluginLogger } from '@ever-works/plugin';

// Main response interface for Notion API
interface NotionPageResponse {
	[blockId: string]: NotionBlock;
}

// Union type for all possible block types
type NotionBlock =
	| PageBlock
	| TextBlock
	| HeaderBlock
	| ListBlock
	| TodoBlock
	| MediaBlock
	| CodeBlock
	| ColumnBlock
	| QuoteBlock
	| CalloutBlock
	| BookmarkBlock
	| ToggleBlock
	| CollectionViewBlock
	| DividerBlock
	| GenericBlock;

// Base block interface
interface BaseBlock {
	value: BaseBlockValue;
	role: string;
	collection?: Collection;
}

interface BaseBlockValue {
	id: string;
	version: number;
	type: string;
	created_time: number;
	last_edited_time: number;
	parent_id: string;
	parent_table: string;
	alive: boolean;
	created_by_table: string;
	created_by_id: string;
	last_edited_by_table: string;
	last_edited_by_id: string;
	space_id: string;
	content?: string[];
	properties?: BlockProperties;
	format?: BlockFormat;
}

// Specific block types
interface PageBlock extends BaseBlock {
	value: PageBlockValue;
}

interface PageBlockValue extends BaseBlockValue {
	type: 'page';
	properties: {
		title: DecorationType[];
	};
	content: string[];
	format: PageFormat;
	permissions: Permission[];
	copied_from?: string;
	file_ids?: string[];
}

interface TextBlock extends BaseBlock {
	value: TextBlockValue;
}

interface TextBlockValue extends BaseBlockValue {
	type: 'text';
	properties?: {
		title: DecorationType[];
	};
	format?: {
		block_color?: string;
	};
}

interface HeaderBlock extends BaseBlock {
	value: HeaderBlockValue;
}

interface HeaderBlockValue extends BaseBlockValue {
	type: 'header' | 'sub_header' | 'sub_sub_header';
	properties: {
		title: DecorationType[];
	};
}

interface ListBlock extends BaseBlock {
	value: ListBlockValue;
}

interface ListBlockValue extends BaseBlockValue {
	type: 'bulleted_list' | 'numbered_list';
	properties?: {
		title: DecorationType[];
	};
	content?: string[];
}

interface TodoBlock extends BaseBlock {
	value: TodoBlockValue;
}

interface TodoBlockValue extends BaseBlockValue {
	type: 'to_do';
	properties: {
		title: DecorationType[];
		checked?: [['Yes' | 'No']];
	};
}

interface MediaBlock extends BaseBlock {
	value: MediaBlockValue;
}

interface MediaBlockValue extends BaseBlockValue {
	type: 'image' | 'embed' | 'figma' | 'video';
	properties: {
		source?: DecorationType[];
		caption?: DecorationType[];
	};
	format?: {
		block_width?: number;
		display_source?: string;
	};
}

interface CodeBlock extends BaseBlock {
	value: CodeBlockValue;
}

interface CodeBlockValue extends BaseBlockValue {
	type: 'code';
	properties: {
		title: DecorationType[];
		language: DecorationType[];
	};
}

interface ColumnBlock extends BaseBlock {
	value: ColumnBlockValue;
}

interface ColumnBlockValue extends BaseBlockValue {
	type: 'column_list' | 'column';
	format?: {
		column_ratio?: number;
	};
}

interface QuoteBlock extends BaseBlock {
	value: QuoteBlockValue;
}

interface QuoteBlockValue extends BaseBlockValue {
	type: 'quote';
	properties: {
		title: DecorationType[];
	};
}

interface CalloutBlock extends BaseBlock {
	value: CalloutBlockValue;
}

interface CalloutBlockValue extends BaseBlockValue {
	type: 'callout';
	properties: {
		title: DecorationType[];
	};
	format: {
		page_icon?: string;
		block_color?: string;
	};
}

interface BookmarkBlock extends BaseBlock {
	value: BookmarkBlockValue;
}

interface BookmarkBlockValue extends BaseBlockValue {
	type: 'bookmark';
	properties: {
		link: DecorationType[];
		title?: DecorationType[];
		description?: DecorationType[];
	};
	format?: {
		bookmark_icon?: string;
		bookmark_cover?: string;
		block_color?: string;
	};
}

interface ToggleBlock extends BaseBlock {
	value: ToggleBlockValue;
}

interface ToggleBlockValue extends BaseBlockValue {
	type: 'toggle';
	properties: {
		title: DecorationType[];
	};
}

interface CollectionViewBlock extends BaseBlock {
	value: CollectionViewBlockValue;
	collection: Collection;
}

interface CollectionViewBlockValue extends BaseBlockValue {
	type: 'collection_view';
	view_ids?: string[];
	collection_id?: string;
	format?: DatabaseFormat;
}

interface DividerBlock extends BaseBlock {
	value: DividerBlockValue;
}

interface DividerBlockValue extends BaseBlockValue {
	type: 'divider';
}

interface GenericBlock extends BaseBlock {
	value: GenericBlockValue;
}

interface GenericBlockValue extends BaseBlockValue {
	properties?: BlockProperties;
	format?: BlockFormat;
}

// Core type definitions
type DecorationType = [string, ...Array<[string, string?]>];

interface BlockProperties {
	title?: DecorationType[];
	caption?: DecorationType[];
	source?: DecorationType[];
	checked?: [['Yes' | 'No']];
	language?: DecorationType[];
	link?: DecorationType[];
	description?: DecorationType[];
}

type BlockFormat =
	| PageFormat
	| DatabaseFormat
	| GenericFormat
	| {
			block_color?: string;
			block_width?: number;
			column_ratio?: number;
			page_icon?: string;
			bookmark_icon?: string;
			bookmark_cover?: string;
			display_source?: string;
	  };

interface PageFormat {
	site_id?: string;
	page_icon?: string;
	page_cover?: string;
	page_full_width?: boolean;
	page_small_text?: boolean;
	copied_from_pointer?: Pointer;
	page_cover_position?: number;
	social_media_image_preview_url?: string;
}

interface DatabaseFormat {
	collection_pointer?: Pointer;
	copied_from_pointer?: Pointer;
}

interface GenericFormat {
	uri?: string;
	bot_id?: string;
	attributes?: Attribute[];
	external_object_id?: string;
	stale?: boolean;
	domain?: string;
	original_url?: string;
}

interface Pointer {
	id: string;
	table: string;
	spaceId: string;
}

interface Permission {
	role: RolePermissions | string;
	type: string;
	bot_id?: string;
	is_site?: boolean;
	added_timestamp?: number;
	allow_duplicate?: boolean;
	is_public_share_link?: boolean;
	allow_search_engine_indexing?: boolean;
}

interface RolePermissions {
	read_content: boolean;
	insert_content: boolean;
	update_content: boolean;
}

interface Attribute {
	id: string;
	name: string;
	type: string;
	format?: AttributeFormat;
	values: Array<DateValue | string>;
	mimeType?: string;
}

interface AttributeFormat {
	type: string;
	section?: string;
}

interface DateValue {
	type: string;
	time_zone: string;
	start_date: Date;
	start_time: string;
}

// Collection related interfaces
interface Collection {
	title: DecorationType[];
	schema: { [key: string]: Schema };
	types: CollectionType[];
	data: CollectionData[];
}

interface CollectionData {
	id: string;
	[key: string]: any;
}

interface Schema {
	name: string;
	type: string;
}

interface CollectionType {
	id: string;
	version: number;
	type: 'table' | 'gallery' | 'list' | 'board' | 'calendar';
	name: string;
	format?: CollectionTypeFormat;
	parent_id: string;
	parent_table: string;
	alive: boolean;
	page_sort?: string[];
	query2: Query;
	space_id: string;
}

interface CollectionTypeFormat {
	table_wrap?: boolean;
	table_properties?: Property[];
	gallery_properties?: Property[];
	table_frozen_column_index?: number;
	inline_collection_first_load_limit?: LoadLimit;
	board_groups2?: BoardGroup[];
	board_properties?: Property[];
}

interface BoardGroup {
	value: BoardGroupValue;
	hidden: boolean;
	property: string;
}

interface BoardGroupValue {
	type: string;
	value?: string;
}

interface Property {
	width?: number;
	visible: boolean;
	property: string;
}

interface LoadLimit {
	type: string;
	limit: number;
}

interface Query {
	aggregations?: Aggregation[];
	group_by?: string;
	calendar_by?: string;
}

interface Aggregation {
	property?: string;
	aggregator: string;
}

/**
 * Official Notion API block types
 */
interface NotionApiBlock {
	object: 'block';
	id: string;
	type: string;
	has_children: boolean;
	[key: string]: unknown;
}

interface NotionApiRichText {
	type: 'text' | 'mention' | 'equation';
	text?: { content: string; link?: { url: string } | null };
	annotations?: {
		bold: boolean;
		italic: boolean;
		strikethrough: boolean;
		underline: boolean;
		code: boolean;
		color: string;
	};
	plain_text: string;
	href?: string | null;
}

interface NotionApiPageResponse {
	object: 'page';
	id: string;
	properties: Record<string, NotionApiProperty>;
}

interface NotionApiProperty {
	type: string;
	title?: NotionApiRichText[];
	rich_text?: NotionApiRichText[];
	[key: string]: unknown;
}

interface NotionApiBlocksResponse {
	object: 'list';
	results: NotionApiBlock[];
	has_more: boolean;
	next_cursor: string | null;
}

/**
 * Notion Service
 *
 * Handles extraction of content from Notion pages using:
 * 1. Official Notion API (for private pages with API key)
 * 2. Splitbee API (for public pages without API key)
 *
 * This service converts Notion's block-based structure into markdown format.
 */
export class NotionService {
	private readonly logger: PluginLogger;

	constructor(logger: PluginLogger) {
		this.logger = logger;
	}

	/**
	 * Extract content using the official Notion API.
	 * Requires a valid Notion API key (integration token).
	 *
	 * @param pageId - The Notion page ID
	 * @param apiKey - Notion integration API key (starts with secret_ or ntn_)
	 */
	async extractWithOfficialApi(pageId: string, apiKey: string): Promise<string> {
		if (!pageId) {
			throw new Error('Invalid Page ID provided.');
		}

		if (!apiKey) {
			throw new Error('Notion API key is required for official API extraction.');
		}

		const headers = {
			Authorization: `Bearer ${apiKey}`,
			'Notion-Version': '2022-06-28',
			'Content-Type': 'application/json'
		};

		try {
			// First, get the page info to extract the title
			const pageResponse = await axios.get<NotionApiPageResponse>(`https://api.notion.com/v1/pages/${pageId}`, {
				headers
			});

			let markdown = '';

			// Extract page title from properties
			const titleProperty = Object.values(pageResponse.data.properties).find((prop) => prop.type === 'title');
			if (titleProperty?.title) {
				const title = this.richTextToPlainText(titleProperty.title);
				if (title) {
					markdown += `# ${title}\n\n`;
				}
			}

			// Get all blocks from the page
			markdown += await this.fetchBlocksRecursively(pageId, apiKey, headers);

			return markdown.trim();
		} catch (error: any) {
			if (error.response?.status === 401) {
				throw new Error('Invalid Notion API key or insufficient permissions.');
			}
			if (error.response?.status === 404) {
				throw new Error('Notion page not found. Make sure the page is shared with your integration.');
			}
			this.logger.error(`Error fetching Notion page with official API: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Recursively fetch all blocks from a page or block
	 */
	private async fetchBlocksRecursively(
		blockId: string,
		apiKey: string,
		headers: Record<string, string>,
		depth: number = 0
	): Promise<string> {
		if (depth > 10) {
			this.logger.warn('Max depth reached for block fetching');
			return '';
		}

		let markdown = '';
		let cursor: string | null = null;
		let hasMore = true;

		while (hasMore) {
			const apiUrl: string = cursor
				? `https://api.notion.com/v1/blocks/${blockId}/children?start_cursor=${cursor}`
				: `https://api.notion.com/v1/blocks/${blockId}/children`;

			const response: { data: NotionApiBlocksResponse } = await axios.get<NotionApiBlocksResponse>(apiUrl, {
				headers
			});

			for (const block of response.data.results) {
				markdown += this.apiBlockToMarkdown(block, depth);

				// Recursively fetch children if the block has them
				if (block.has_children) {
					const childContent = await this.fetchBlocksRecursively(block.id, apiKey, headers, depth + 1);
					markdown += childContent;
				}
			}

			hasMore = response.data.has_more;
			cursor = response.data.next_cursor;
		}

		return markdown;
	}

	/**
	 * Convert official API block to markdown
	 */
	private apiBlockToMarkdown(block: NotionApiBlock, depth: number = 0): string {
		const indent = '  '.repeat(depth);
		const blockData = block[block.type] as Record<string, unknown> | undefined;

		switch (block.type) {
			case 'paragraph': {
				const text = this.richTextToMarkdown(blockData?.rich_text as NotionApiRichText[] | undefined);
				return text ? `${text}\n\n` : '\n';
			}

			case 'heading_1': {
				const text = this.richTextToMarkdown(blockData?.rich_text as NotionApiRichText[] | undefined);
				return text ? `# ${text}\n\n` : '';
			}

			case 'heading_2': {
				const text = this.richTextToMarkdown(blockData?.rich_text as NotionApiRichText[] | undefined);
				return text ? `## ${text}\n\n` : '';
			}

			case 'heading_3': {
				const text = this.richTextToMarkdown(blockData?.rich_text as NotionApiRichText[] | undefined);
				return text ? `### ${text}\n\n` : '';
			}

			case 'bulleted_list_item': {
				const text = this.richTextToMarkdown(blockData?.rich_text as NotionApiRichText[] | undefined);
				return text ? `${indent}- ${text}\n` : '';
			}

			case 'numbered_list_item': {
				const text = this.richTextToMarkdown(blockData?.rich_text as NotionApiRichText[] | undefined);
				return text ? `${indent}1. ${text}\n` : '';
			}

			case 'to_do': {
				const text = this.richTextToMarkdown(blockData?.rich_text as NotionApiRichText[] | undefined);
				const checked = blockData?.checked ? '[x]' : '[ ]';
				return text ? `${indent}- ${checked} ${text}\n` : '';
			}

			case 'toggle': {
				const text = this.richTextToMarkdown(blockData?.rich_text as NotionApiRichText[] | undefined);
				return text ? `<details>\n<summary>${text}</summary>\n\n` : '';
			}

			case 'quote': {
				const text = this.richTextToMarkdown(blockData?.rich_text as NotionApiRichText[] | undefined);
				return text ? `> ${text}\n\n` : '';
			}

			case 'code': {
				const text = this.richTextToPlainText(blockData?.rich_text as NotionApiRichText[] | undefined);
				const language = (blockData?.language as string) || '';
				return text ? `\`\`\`${language}\n${text}\n\`\`\`\n\n` : '';
			}

			case 'callout': {
				const text = this.richTextToMarkdown(blockData?.rich_text as NotionApiRichText[] | undefined);
				const icon = (blockData?.icon as { emoji?: string })?.emoji || '💡';
				return text ? `> ${icon} ${text}\n\n` : '';
			}

			case 'divider':
				return '---\n\n';

			case 'image': {
				const imageData = blockData as
					| {
							type?: string;
							file?: { url: string };
							external?: { url: string };
							caption?: NotionApiRichText[];
					  }
					| undefined;
				const url = imageData?.type === 'file' ? imageData?.file?.url : imageData?.external?.url;
				const caption = this.richTextToPlainText(imageData?.caption);
				return url ? `![${caption || 'image'}](${url})\n\n` : '';
			}

			case 'video':
			case 'embed':
			case 'file':
			case 'pdf': {
				const mediaData = blockData as
					| {
							type?: string;
							file?: { url: string };
							external?: { url: string };
							caption?: NotionApiRichText[];
					  }
					| undefined;
				const url = mediaData?.type === 'file' ? mediaData?.file?.url : mediaData?.external?.url;
				const caption = this.richTextToPlainText(mediaData?.caption);
				return url ? `[${caption || block.type.toUpperCase()}](${url})\n\n` : '';
			}

			case 'bookmark': {
				const bookmarkData = blockData as { url?: string; caption?: NotionApiRichText[] } | undefined;
				const url = bookmarkData?.url;
				const caption = this.richTextToPlainText(bookmarkData?.caption);
				return url ? `[${caption || url}](${url})\n\n` : '';
			}

			case 'link_preview': {
				const linkData = blockData as { url?: string } | undefined;
				return linkData?.url ? `[${linkData.url}](${linkData.url})\n\n` : '';
			}

			case 'table_of_contents':
				return '[TOC]\n\n';

			case 'equation': {
				const eqData = blockData as { expression?: string } | undefined;
				return eqData?.expression ? `$$${eqData.expression}$$\n\n` : '';
			}

			case 'column_list':
			case 'column':
				// These are layout blocks, children will be processed separately
				return '';

			case 'synced_block':
				// Children will be processed separately
				return '';

			default:
				this.logger.debug(`Unknown block type: ${block.type}`);
				return '';
		}
	}

	/**
	 * Convert rich text array to markdown with formatting
	 */
	private richTextToMarkdown(richText: NotionApiRichText[] | undefined): string {
		if (!richText || richText.length === 0) {
			return '';
		}

		return richText
			.map((rt) => {
				let text = rt.plain_text;

				if (rt.annotations) {
					if (rt.annotations.code) {
						text = `\`${text}\``;
					}
					if (rt.annotations.bold) {
						text = `**${text}**`;
					}
					if (rt.annotations.italic) {
						text = `*${text}*`;
					}
					if (rt.annotations.strikethrough) {
						text = `~~${text}~~`;
					}
				}

				if (rt.href) {
					text = `[${text}](${rt.href})`;
				}

				return text;
			})
			.join('');
	}

	/**
	 * Convert rich text array to plain text
	 */
	private richTextToPlainText(richText: NotionApiRichText[] | undefined): string {
		if (!richText || richText.length === 0) {
			return '';
		}
		return richText.map((rt) => rt.plain_text).join('');
	}

	/**
	 * Checks if a URL is a Notion page URL
	 */
	isNotionUrl(url: string): boolean {
		if (!url || typeof url !== 'string') {
			return false;
		}

		return url.includes('notion.site') || url.includes('notion.so');
	}

	/**
	 * Extracts the Notion page ID from various URL formats
	 */
	extractNotionPageId(url: string): string | null {
		if (!url || typeof url !== 'string') {
			return null;
		}

		const patterns = [
			/(?:[a-f0-9]{32})$/i,
			/([a-f0-9]{32})(?:[?#]|$)/i,
			/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:[?#]|$)/i
		];

		for (const pattern of patterns) {
			const match = url.match(pattern);
			if (match && match[1]) {
				let id = match[1];

				if (id.length === 32 && id.indexOf('-') === -1) {
					return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
				}
				return id;
			}
		}

		const complexUrlPattern =
			/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|[a-f0-9]{32})(?:[?#]|$)/;
		const urlParts = url.split('/');
		const potentialId = urlParts.pop()?.split('?')[0].split('#')[0].split('-').pop();

		if (potentialId && complexUrlPattern.test(potentialId)) {
			let id = potentialId;
			if (id.length === 32 && id.indexOf('-') === -1) {
				return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
			}

			if (id.indexOf('-') !== -1 && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) {
				return id;
			}
		}

		return null;
	}

	/**
	 * Converts Notion decoration to plain text with markdown formatting
	 */
	private decorationToText(decoration: DecorationType): string {
		const [text, ...formats] = decoration;
		let result = text;

		if (formats && formats.length > 0) {
			for (const format of formats) {
				const [formatType, formatValue] = format;
				switch (formatType) {
					case 'b': // bold
						result = `**${result}**`;
						break;
					case 'i': // italic
						result = `*${result}*`;
						break;
					case 's': // strikethrough
						result = `~~${result}~~`;
						break;
					case 'c': // code
						result = `\`${result}\``;
						break;
					case 'a': // link
						result = `[${result}](${formatValue})`;
						break;
					case 'h': // highlight/color
						// For markdown, we'll just keep the text as is
						break;
				}
			}
		}

		return result;
	}

	/**
	 * Converts an array of decorations to plain text
	 */
	private decorationsToText(decorations: DecorationType[]): string {
		if (!decorations || decorations.length === 0) {
			return '';
		}
		return decorations.map((decoration) => this.decorationToText(decoration)).join('');
	}

	/**
	 * Converts a single Notion block to markdown
	 */
	private blockToMarkdown(
		block: NotionBlock,
		allBlocks: NotionPageResponse,
		level: number = 0,
		processingHistory: Set<string> = new Set()
	): string {
		const blockValue = block.value;

		// Prevent infinite recursion
		if (processingHistory.has(blockValue.id)) {
			return '';
		}

		const newHistory = new Set(processingHistory).add(blockValue.id);
		let result = '';

		switch (blockValue.type) {
			case 'page':
				if (level === 0 && blockValue.properties?.title) {
					result = `# ${this.decorationsToText(blockValue.properties.title)}\n\n`;
				}
				break;

			case 'header':
				if (blockValue.properties?.title) {
					result = `# ${this.decorationsToText(blockValue.properties.title)}\n\n`;
				}
				break;

			case 'sub_header':
				if (blockValue.properties?.title) {
					result = `## ${this.decorationsToText(blockValue.properties.title)}\n\n`;
				}
				break;

			case 'sub_sub_header':
				if (blockValue.properties?.title) {
					result = `### ${this.decorationsToText(blockValue.properties.title)}\n\n`;
				}
				break;

			case 'text':
				if (blockValue.properties?.title) {
					result = `${this.decorationsToText(blockValue.properties.title)}\n\n`;
				} else {
					result = '\n';
				}
				break;

			case 'bulleted_list':
				if (blockValue.properties?.title) {
					const indent = '  '.repeat(level);
					result = `${indent}- ${this.decorationsToText(blockValue.properties.title)}\n`;
				}
				break;

			case 'numbered_list':
				if (blockValue.properties?.title) {
					const indent = '  '.repeat(level);
					result = `${indent}1. ${this.decorationsToText(blockValue.properties.title)}\n`;
				}
				break;

			case 'to_do':
				if (blockValue.properties?.title) {
					const isChecked = blockValue.properties.checked?.[0]?.[0] === 'Yes';
					const checkbox = isChecked ? '[x]' : '[ ]';
					result = `- ${checkbox} ${this.decorationsToText(blockValue.properties.title)}\n`;
				}
				break;

			case 'quote':
				if (blockValue.properties?.title) {
					result = `> ${this.decorationsToText(blockValue.properties.title)}\n\n`;
				}
				break;

			case 'code':
				if (blockValue.properties?.title) {
					const language = blockValue.properties.language?.[0]?.[0] || '';
					const code = this.decorationsToText(blockValue.properties.title);
					result = `\`\`\`${language}\n${code}\n\`\`\`\n\n`;
				}
				break;

			case 'divider':
				result = '---\n\n';
				break;

			case 'callout':
				if (blockValue.properties?.title) {
					result = `> 💡 ${this.decorationsToText(blockValue.properties.title)}\n\n`;
				}
				break;

			case 'bookmark':
				if (blockValue.properties?.link) {
					const link = this.decorationsToText(blockValue.properties.link);
					const title = blockValue.properties.title
						? this.decorationsToText(blockValue.properties.title)
						: link;
					const description = blockValue.properties.description
						? this.decorationsToText(blockValue.properties.description)
						: '';

					result = `[${title}](${link})`;
					if (description) {
						result += `\n${description}`;
					}
					result += '\n\n';
				}
				break;

			case 'toggle':
				if (blockValue.properties?.title) {
					result = `<details>\n<summary>${this.decorationsToText(blockValue.properties.title)}</summary>\n\n`;
				}
				break;

			case 'image':
			case 'video':
			case 'embed':
			case 'figma':
				if (blockValue.properties?.source) {
					const source = this.decorationsToText(blockValue.properties.source);
					const caption = blockValue.properties.caption
						? this.decorationsToText(blockValue.properties.caption)
						: '';

					if (blockValue.type === 'image') {
						result = `![${caption}](${source})\n\n`;
					} else {
						result = `[${blockValue.type.toUpperCase()}](${source})`;
						if (caption) {
							result += `\n*${caption}*`;
						}
						result += '\n\n';
					}
				}
				break;

			case 'collection_view':
				if (block.collection) {
					result = `## ${this.decorationsToText(block.collection.title)}\n\n`;

					const collectionType = block.collection.types[0];
					if (collectionType?.type === 'table') {
						// Create markdown table
						const visibleProperties =
							collectionType.format?.table_properties?.filter((p) => p.visible) || [];

						if (visibleProperties.length > 0 && block.collection.data.length > 0) {
							// Table headers
							const headers = visibleProperties.map(
								(prop) => block.collection!.schema[prop.property]?.name || prop.property
							);
							result += `| ${headers.join(' | ')} |\n`;
							result += `| ${headers.map(() => '---').join(' | ')} |\n`;

							// Table rows
							for (const row of block.collection.data) {
								const rowData = visibleProperties.map((prop) => {
									const columnName = block.collection!.schema[prop.property]?.name;
									const cellData = row[columnName || prop.property];
									if (Array.isArray(cellData)) {
										return this.decorationsToText(cellData);
									}
									return String(cellData || '');
								});
								result += `| ${rowData.join(' | ')} |\n`;
							}
							result += '\n';
						}
					}
				}
				break;

			case 'column_list':
				// For column lists, we'll just process children normally
				break;

			case 'column':
				// For columns, we'll just process children normally
				break;

			default:
				// For unknown block types, try to extract text if properties exist
				this.logger.warn(`Unknown block type: ${blockValue.type}`);
				if (blockValue.properties && 'title' in blockValue.properties && blockValue.properties.title) {
					result = `${this.decorationsToText(blockValue.properties.title)}\n\n`;
				}
				break;
		}

		// Process child blocks
		if (blockValue.content && blockValue.content.length > 0) {
			for (const childId of blockValue.content) {
				const childBlock = allBlocks[childId];
				if (childBlock) {
					const childLevel = ['bulleted_list', 'numbered_list'].includes(blockValue.type) ? level + 1 : level;
					result += this.blockToMarkdown(childBlock, allBlocks, childLevel, newHistory);
				}
			}
		}

		// Close toggle if it was opened
		if (blockValue.type === 'toggle' && blockValue.content && blockValue.content.length > 0) {
			result += '</details>\n\n';
		}

		return result;
	}

	/**
	 * Extracts all text content from a public Notion page using its ID via notion-api.splitbee.io
	 */
	async extractTextWithNotionAPI(pageId: string, processingHistory: Set<string> = new Set()): Promise<string> {
		if (!pageId) {
			throw new Error('Invalid Page ID provided.');
		}

		if (processingHistory.has(pageId)) {
			this.logger.warn(`Skipping already processed page ID: ${pageId} to prevent cycle.`);
			return '';
		}

		const newProcessingHistory = new Set(processingHistory).add(pageId);
		const apiUrl = `https://notion-api.splitbee.io/v1/page/${pageId}`;

		try {
			const response = await axios.get<NotionPageResponse>(apiUrl, {
				headers: {
					'User-Agent': `ItemsGeneratorBuilder/ever-works (Node.js/Axios; +https://github.com/ever-works)`,
					Accept: 'application/json',
					'Content-Type': 'application/json'
				}
			});

			const allBlocksData = response.data;

			if (!allBlocksData || typeof allBlocksData !== 'object' || Object.keys(allBlocksData).length === 0) {
				throw new Error(
					`No data received from Splitbee API for page ID ${pageId}. The page might be private, non-existent, or the API structure might have changed.`
				);
			}

			let rootBlockId = pageId;

			// Find the root block
			if (!allBlocksData[rootBlockId]) {
				const matchingBlockKey = Object.keys(allBlocksData).find(
					(key) =>
						allBlocksData[key]?.value?.id === pageId &&
						(allBlocksData[key]?.value?.type === 'page' ||
							allBlocksData[key]?.value?.type === 'collection_view_page')
				);

				if (matchingBlockKey) {
					rootBlockId = matchingBlockKey;
				} else {
					const firstPageTypeBlockKey = Object.keys(allBlocksData).find(
						(key) =>
							allBlocksData[key]?.value?.type === 'page' ||
							allBlocksData[key]?.value?.type === 'collection_view_page'
					);

					if (firstPageTypeBlockKey) {
						this.logger.warn(
							`Page ID ${pageId} not directly found as a key. Using first '${allBlocksData[firstPageTypeBlockKey].value.type}' block as root: ${firstPageTypeBlockKey}`
						);
						rootBlockId = firstPageTypeBlockKey;
					} else {
						throw new Error(
							`Could not determine the root block for page ID ${pageId} from Splitbee API response. No suitable 'page' or 'collection_view_page' block found.`
						);
					}
				}
			}

			if (!allBlocksData[rootBlockId] || !allBlocksData[rootBlockId].value) {
				throw new Error(
					`Determined root block ID ${rootBlockId} for page ${pageId} is not valid or has no value in API response.`
				);
			}

			// Convert all blocks to markdown starting from the root
			const rootBlock = allBlocksData[rootBlockId];
			let markdownContent = this.blockToMarkdown(rootBlock, allBlocksData, 0, newProcessingHistory);

			// Process any remaining top-level blocks that might not be in the content tree
			for (const [blockId, block] of Object.entries(allBlocksData)) {
				if (blockId !== rootBlockId && !newProcessingHistory.has(blockId)) {
					markdownContent += this.blockToMarkdown(block, allBlocksData, 0, newProcessingHistory);
				}
			}

			return markdownContent.trim();
		} catch (error: any) {
			this.logger.error(
				`Error fetching or parsing Notion page content for page ID ${pageId} from Splitbee API: ${error.message}`
			);
			throw error;
		}
	}

	/**
	 * Extracts content from a Notion URL and returns it as markdown
	 */
	async extractNotionContent(url: string): Promise<string> {
		const pageId = this.extractNotionPageId(url);

		if (!pageId) {
			throw new Error(`Could not extract Page ID from URL: ${url}`);
		}

		return await this.extractTextWithNotionAPI(pageId);
	}
}
