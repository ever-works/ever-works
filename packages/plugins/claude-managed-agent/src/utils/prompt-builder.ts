import type { DirectoryReference, ExistingItems, GenerationRequest } from '@ever-works/plugin';

import { DEFAULT_WORKSPACE_PATH, WORKSPACE_SEED_MANIFEST_MOUNT_PATH, type WorkspaceSeedManifest } from '../types.js';

export function buildSystemPrompt(override?: string): string {
	if (override && override.trim().length > 0) {
		return override;
	}

	return [
		'You are an Ever Works managed directory generation agent.',
		'You operate in two phases: workspace bootstrap, then generation or reorganization inside that workspace.',
		'Use built-in tools when helpful, including bash, file editing, web search, and web fetch.',
		'Stay inside the requested workspace path and follow the user-provided phase instructions exactly.',
		'Read local workspace files before deciding whether to research, create, or update items.',
		'Do not delete item files unless the user explicitly asks for deletion.',
		'When asked for a final structured result, return only the requested JSON object and nothing else.',
		'Prefer official, primary, or otherwise authoritative sources, and avoid duplicates.'
	].join(' ');
}

export function buildUserPrompt(
	directory: DirectoryReference,
	request: GenerationRequest,
	existing: ExistingItems,
	targetItems: number,
	workspacePath = DEFAULT_WORKSPACE_PATH
): string {
	const currentDate = new Date().toISOString().slice(0, 10);

	return [
		`Workspace path: ${workspacePath}`,
		`Today: ${currentDate}`,
		'You are managing directory item JSON files inside this workspace.',
		'The workspace root contains item JSON files. The `_meta/` directory contains the request, directory metadata, taxonomy references, and the seeded baseline.',
		'Start by reading `_meta/request.json` and `_meta/directory.json`.',
		'Use `_meta/existing-items.jsonl` for quick duplicate checks and read seeded item files when you need full item details.',
		'When modifying existing items, write changes back to the same filename. When creating new items, add new JSON files in the workspace root.',
		'Keep `_meta/categories.json`, `_meta/tags.json`, `_meta/collections.json`, and `_meta/brands.json` consistent with the taxonomy used by changed items.',
		'Do not modify `_meta/seeded.json`.',
		'If the request is purely a taxonomy or reorganization update, operate on the local workspace and do not use web research.',
		'If the request requires creation or enrichment, use web research carefully and prefer official or otherwise authoritative sources.',
		`Directory name: ${directory.name}`,
		`Directory slug: ${directory.slug}`,
		directory.description ? `Directory description: ${directory.description}` : null,
		request.name ? `Generation name: ${request.name}` : null,
		request.prompt ? `Generation prompt: ${request.prompt}` : null,
		request.generationMethod ? `Generation method: ${request.generationMethod}` : null,
		`Target items: ${targetItems}`,
		`Existing item count: ${existing.items.length}`,
		'Use your own judgment to decide the best categories, tags, collections, and brands, but reuse existing taxonomy when it already fits.',
		'Workflow rules:',
		'- Read existing files before creating anything new.',
		'- Avoid duplicates by checking names, slugs, source URLs, and obvious near-duplicates.',
		'- Never invent items or source URLs.',
		'- If an existing item should be improved, update that item instead of creating a duplicate.',
		'- If no item files changed materially, return empty `items`, `categories`, `tags`, `collections`, and `brands` arrays and explain why in `warnings`.',
		'Return only valid JSON with this exact top-level shape:',
		JSON.stringify(
			{
				items: [
					{
						name: 'Example Item',
						description: 'Short factual description',
						source_url: 'https://example.com',
						category: ['Category Name'],
						tags: ['tag-one', 'tag-two'],
						collection: 'Optional Collection',
						brand: 'Optional Brand',
						brand_logo_url: null,
						images: [],
						markdown: 'Optional markdown body',
						featured: false
					}
				],
				categories: [{ name: 'Category Name', description: 'Optional description' }],
				tags: [{ name: 'tag-one' }],
				collections: [{ name: 'Optional Collection', description: 'Optional description' }],
				brands: [
					{
						name: 'Optional Brand',
						website: 'https://example.com',
						logo_url: 'https://example.com/logo.png'
					}
				],
				operations: {
					created_files: ['new-item.json'],
					updated_files: ['existing-item.json'],
					unchanged_seeded_files_count: 0
				},
				warnings: []
			},
			null,
			2
		),
		'Requirements:',
		'- Do not wrap the JSON in markdown fences.',
		'- Every returned item must include name, description, source_url, category, and tags.',
		'- Return only items that were created or materially updated during this run. Do not return unchanged seeded items.',
		'- Categories and tags should be concise and normalized.',
		'- Avoid repeating existing items.',
		'- Keep descriptions compact and factual.',
		'- The `operations.created_files` and `operations.updated_files` arrays must reference workspace-relative JSON filenames.',
		'- If no items changed, return empty arrays and explain why in `warnings`.'
	]
		.filter(Boolean)
		.join('\n\n');
}

export function buildWorkspaceSeedPrompt(manifest: WorkspaceSeedManifest): string {
	return [
		'Bootstrap the Ever Works workspace for this session.',
		`Read the mounted manifest file at: ${WORKSPACE_SEED_MANIFEST_MOUNT_PATH}`,
		`Create or replace the workspace at: ${manifest.workspacePath}`,
		'Materialize every file from the manifest exactly as provided using UTF-8 encoding.',
		'This bootstrap step is allowed to create the `_meta/` directory and all seed files.',
		'After writing all files, verify that the number of created files matches the manifest.',
		'Reply with the exact text `WORKSPACE_READY` once the workspace is ready.'
	].join('\n');
}

export function buildResultCollectionPrompt(workspacePath = DEFAULT_WORKSPACE_PATH): string {
	return [
		'Inspect the current workspace and return the final Ever Works result based on the actual filesystem state.',
		`Workspace path: ${workspacePath}`,
		'This is a read-only collection step. Do not modify files, do not search the web, and do not create or delete anything.',
		'Use `_meta/seeded.json` to identify which seeded files remained unchanged.',
		'Return only items represented by JSON files in the workspace root that were created during this run or materially changed during this run.',
		'Do not return unchanged seeded items.',
		'Derive categories, tags, collections, and brands from the changed item files you actually find in the workspace.',
		'Use `operations.created_files` for new JSON files that were not part of `_meta/seeded.json`.',
		'Use `operations.updated_files` for seeded JSON files whose contents changed compared with `_meta/seeded.json`.',
		'Set `operations.unchanged_seeded_files_count` to the number of seeded JSON files that were left unchanged.',
		'Return only valid JSON with this exact top-level shape:',
		JSON.stringify(
			{
				items: [
					{
						name: 'Example Item',
						description: 'Short factual description',
						source_url: 'https://example.com',
						category: ['Category Name'],
						tags: ['tag-one', 'tag-two'],
						collection: 'Optional Collection',
						brand: 'Optional Brand',
						brand_logo_url: null,
						images: [],
						markdown: 'Optional markdown body',
						featured: false
					}
				],
				categories: [{ name: 'Category Name', description: 'Optional description' }],
				tags: [{ name: 'tag-one' }],
				collections: [{ name: 'Optional Collection', description: 'Optional description' }],
				brands: [
					{
						name: 'Optional Brand',
						website: 'https://example.com',
						logo_url: 'https://example.com/logo.png'
					}
				],
				operations: {
					created_files: ['new-item.json'],
					updated_files: ['existing-item.json'],
					unchanged_seeded_files_count: 0
				},
				warnings: []
			},
			null,
			2
		),
		'Do not wrap the JSON in markdown fences.'
	].join('\n\n');
}
