export interface CodexWorkspace {
	readonly workspacePath: string;
	readonly itemsPath: string;
	readonly metadataPath: string;
}

export interface GeneratedItemsMetadata {
	readonly categories: readonly string[];
	readonly tags: readonly string[];
	readonly collections: readonly string[];
	readonly brands: readonly string[];
}

export async function createWorkspace(basePath: string): Promise<CodexWorkspace> {
	return {
		workspacePath: basePath,
		itemsPath: `${basePath}/items`,
		metadataPath: `${basePath}/metadata.json`
	};
}

export async function cleanupWorkspace(_workspacePath: string): Promise<void> {}

export function getWorkspacePath(workspace: CodexWorkspace | string): string {
	return typeof workspace === 'string' ? workspace : workspace.workspacePath;
}

export async function readGeneratedItems(): Promise<readonly Record<string, unknown>[]> {
	return [];
}

export async function seedExistingItems(
	_workspacePath: string,
	_existingItems: readonly Record<string, unknown>[]
): Promise<void> {}

export async function seedMetadata(
	_workspacePath: string,
	_metadata: Record<string, unknown>
): Promise<void> {}

export async function ensureOnboardingConfig(_workspacePath: string): Promise<void> {}

export function collectMetadataFromItems(
	_items: readonly Record<string, unknown>[]
): GeneratedItemsMetadata {
	return {
		categories: [],
		tags: [],
		collections: [],
		brands: []
	};
}

export function slugify(value: string): string {
	return value
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

export function unslugify(value: string): string {
	return value
		.split('-')
		.filter(Boolean)
		.join(' ');
}
