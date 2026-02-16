import type {
	IPlugin,
	PluginContext,
	PluginCategory,
	PluginManifest,
	PluginHealthCheck,
	JsonSchema,
	ValidationResult,
	PluginSettings
} from '@ever-works/plugin';

export class CommunityPrPlugin implements IPlugin {
	readonly id = 'community-pr';
	readonly name = 'Community PR Processing';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'integration';
	readonly capabilities: readonly string[] = ['community-pr'];

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			autoClose: {
				type: 'boolean',
				title: 'Auto-close PRs',
				description: 'Automatically close pull requests after items have been extracted and added to the directory.',
				default: true
			}
		}
	};

	readonly configurationMode: 'admin-only' | 'user-required' | 'hybrid' = 'hybrid';

	private context?: PluginContext;

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('Community PR Processing plugin loaded');
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
	}

	async validateSettings(settings: PluginSettings): Promise<ValidationResult> {
		const errors: Array<{ path: string; message: string }> = [];

		if (settings.autoClose !== undefined && typeof settings.autoClose !== 'boolean') {
			errors.push({ path: 'autoClose', message: 'autoClose must be a boolean' });
		}

		return {
			valid: errors.length === 0,
			errors: errors.length > 0 ? errors : undefined
		};
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'Community PR Processing plugin is ready',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'Automatically processes community pull requests to extract and add new directory items.',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'MIT',
			builtIn: true,
			systemPlugin: false,
			autoEnable: false,
			readme: [
				'## What does Community PR Processing do?',
				'',
				'This plugin monitors your directory\'s main repository for community-submitted pull requests. When a PR is opened that adds new items (e.g., tools, projects, or resources), the plugin uses AI to extract the item details and automatically adds them to your data repository.',
				'',
				'## How it works',
				'',
				'1. The plugin scans open PRs on your directory\'s main repository',
				'2. For each unprocessed PR, it reads the file changes (patches)',
				'3. AI analyzes the changes and extracts structured item data (name, description, URL, category, tags)',
				'4. Extracted items are written to your data repository and committed',
				'5. A comment is posted on the PR summarizing what was added',
				'6. Optionally, the PR is automatically closed',
				'',
				'## Settings',
				'',
				'- **Auto-close PRs** — When enabled (default), PRs are automatically closed after processing. Disable this if you want to manually review and close PRs.',
				'',
				'## Getting started',
				'',
				'1. Enable this plugin for your directory',
				'2. Ensure the GitHub plugin is configured with repository access',
				'3. Community members can submit PRs to your main repository',
				'4. Items will be extracted and added automatically'
			].join('\n')
		};
	}
}

export default CommunityPrPlugin;
