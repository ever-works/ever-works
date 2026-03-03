import chalk from 'chalk';
import inquirer from 'inquirer';
import { BasePromptService } from './base-prompt.service';
import { validateSlug } from '../utils/slug-utils';

export interface DirectoryInputData {
	slug: string;
	name: string;
	description: string;
	owner?: string;
}

export interface MarkdownReadmeConfigDto {
	header?: string;
	overwriteDefaultHeader?: boolean;
	footer?: string;
	overwriteDefaultFooter?: boolean;
}

export interface SlugConflictResolution {
	action: 'use_suggested' | 'modify' | 'cancel';
	finalSlug?: string;
}

/**
 * Roles for directory access.
 * - OWNER: Reserved for directory creator only (returned by API for creator)
 * - MANAGER: Can edit directory and manage content, invite/remove members
 * - EDITOR: Can edit directory content but cannot manage members
 * - VIEWER: Read-only access to directory
 *
 * Note: Members can only be assigned MANAGER, EDITOR, or VIEWER roles.
 */
export enum DirectoryMemberRole {
	OWNER = 'owner',
	MANAGER = 'manager',
	EDITOR = 'editor',
	VIEWER = 'viewer'
}

export interface DirectorySelection {
	directory: Directory | null;
	cancelled: boolean;
	role?: DirectoryMemberRole;
	isShared?: boolean;
}

export enum GenerateStatusType {
	GENERATING = 'generating',
	GENERATED = 'generated',
	ERROR = 'error',
	CANCELLED = 'cancelled'
}

type GenerateStatus = {
	status: GenerateStatusType;
	step?: string;
	error?: string;
};

export type GetProjectsReadyState = 'BUILDING' | 'ERROR' | 'INITIALIZING' | 'QUEUED' | 'READY' | 'CANCELED' | 'TIMEOUT';

export interface Directory {
	id: string;
	name: string;
	slug: string;
	website?: string;
	owner: string;
	companyName?: string;
	organization: boolean;
	description: string;
	readmeConfig?: MarkdownReadmeConfigDto;
	generateStatus?: GenerateStatus;
	deploymentState?: GetProjectsReadyState;
	deploymentStartedAt?: string;
	userRole?: DirectoryMemberRole;
}

export interface GitProviderChoice {
	id: string;
	name: string;
	enabled: boolean;
	connected: boolean;
	username?: string;
}

export interface DeployProviderChoice {
	id: string;
	name: string;
	enabled: boolean;
}

export class DirectoryPromptService extends BasePromptService {
	async promptGitProviderSelection(providers: GitProviderChoice[]): Promise<string> {
		const choices: Array<{ name: string; value: string }> = [];
		let defaultValue: string | undefined;

		for (const provider of providers) {
			if (!provider.enabled) {
				choices.push({
					name: chalk.gray(`${provider.name} (not configured)`),
					value: `__disabled__${provider.id}`
				});
				continue;
			}

			const statusLabel = provider.connected
				? chalk.green(`[connected${provider.username ? ` as @${provider.username}` : ''}]`)
				: chalk.yellow('[not connected]');

			choices.push({
				name: `${provider.name} ${statusLabel}`,
				value: provider.id
			});

			if (!defaultValue && provider.connected) {
				defaultValue = provider.id;
			}
		}

		if (!defaultValue) {
			const firstEnabled = providers.find((p) => p.enabled);
			if (firstEnabled) {
				defaultValue = firstEnabled.id;
			}
		}

		let selected = await this.promptSelect('Git provider:', choices, defaultValue);

		while (selected.startsWith('__disabled__')) {
			console.log(chalk.yellow('  This provider is not configured. Please configure it in Settings > Plugins.'));
			selected = await this.promptSelect('Git provider:', choices, defaultValue);
		}

		return selected;
	}

	async promptDeployProviderSelection(providers: DeployProviderChoice[]): Promise<string | null> {
		const choices: Array<{ name: string; value: string }> = [{ name: 'None (skip)', value: '__none__' }];

		let defaultValue = '__none__';

		for (const provider of providers) {
			if (!provider.enabled) {
				choices.push({
					name: chalk.gray(`${provider.name} (not configured)`),
					value: `__disabled__${provider.id}`
				});
				continue;
			}

			choices.push({
				name: `${provider.name} ${chalk.green('[configured]')}`,
				value: provider.id
			});

			if (defaultValue === '__none__') {
				defaultValue = provider.id;
			}
		}

		let selected = await this.promptSelect('Deploy provider:', choices, defaultValue);

		while (selected.startsWith('__disabled__')) {
			console.log(chalk.yellow('  This provider is not configured. Please configure it in Settings > Plugins.'));
			selected = await this.promptSelect('Deploy provider:', choices, defaultValue);
		}

		return selected === '__none__' ? null : selected;
	}

	async promptDirectoryCreation(
		ownerDefault?: string,
		orgs?: { name: string; value: any }[]
	): Promise<DirectoryInputData> {
		this.displaySectionHeader('Directory Creation');
		this.displayInfo('Please provide the following information to create a new directory:');

		// Required fields - start with name first
		const name = await this.promptRequiredText(
			'Directory name (display name):',
			undefined,
			this.validateName.bind(this)
		);

		// Generate initial slug from name, let user confirm/edit
		const initialSlug = this.slugifyName(name);
		const slug = await this.promptRequiredText('URL slug:', initialSlug, validateSlug);

		const description = await this.promptRequiredText(
			'Directory description:',
			undefined,
			this.validateDescription.bind(this)
		);

		// Owner / organization selection — Personal Account selected by default
		let owner: string | undefined;

		if (orgs && orgs.length > 0) {
			const selected = await this.promptSelect('Repository owner (organization):', orgs, ownerDefault);
			owner = selected || undefined;
		}

		return {
			slug,
			name,
			description,
			owner
		};
	}

	async promptSlugConflictResolution(originalSlug: string, suggestedSlug: string): Promise<SlugConflictResolution> {
		this.displayWarning(`The slug "${originalSlug}" is already taken.`);
		this.displayInfo(`We suggest using "${suggestedSlug}" instead.`);

		const action = await this.promptSelect('What would you like to do?', [
			{ name: `Use suggested slug: "${suggestedSlug}"`, value: 'use_suggested' },
			{ name: 'Modify the slug manually', value: 'modify' },
			{ name: 'Cancel directory creation', value: 'cancel' }
		]);

		if (action === 'modify') {
			const finalSlug = await this.promptRequiredText('Enter your preferred slug:', suggestedSlug, validateSlug);
			return { action, finalSlug };
		}

		return { action, finalSlug: action === 'use_suggested' ? suggestedSlug : undefined };
	}

	/**
	 * Prompts user to select a directory from available directories
	 * This method should be overridden by implementations to provide directory listing
	 */
	async promptDirectorySelection(directories?: Directory[]): Promise<DirectorySelection> {
		if (!directories || directories.length === 0) {
			console.log(chalk.yellow('\nNo directories found.'));
			console.log(chalk.gray('Create your first directory with: ') + chalk.cyan('directory create'));
			return { directory: null, cancelled: true };
		}

		type Choice = { name: string; value: Directory | null; short: string };

		const choices: Choice[] = directories.map((dir) => {
			const role = dir.userRole || DirectoryMemberRole.OWNER;
			const isShared = role !== DirectoryMemberRole.OWNER;
			const roleLabel = this.formatRoleLabel(role, isShared);

			return {
				name: `${dir.name} ${chalk.gray(dir.slug)} ${roleLabel}`,
				value: dir,
				short: dir.slug
			};
		});

		choices.push(new inquirer.Separator('') as any);
		choices.push({
			name: chalk.gray('← Cancel'),
			value: null,
			short: 'cancel'
		});

		const { selectedDirectory } = await inquirer.prompt([
			{
				type: 'list',
				name: 'selectedDirectory',
				message: 'Select a directory:',
				choices,
				pageSize: 15
			}
		]);

		if (!selectedDirectory) {
			return { directory: null, cancelled: true };
		}

		// Determine role for the selected directory
		const role = selectedDirectory.userRole || DirectoryMemberRole.OWNER;
		const isShared = role !== DirectoryMemberRole.OWNER;

		return {
			directory: selectedDirectory,
			cancelled: false,
			role,
			isShared
		};
	}

	/**
	 * Formats a directory selection message showing the role.
	 */
	formatSelectedDirectory(directory: Directory, role: DirectoryMemberRole, isShared: boolean): string {
		const roleLabel = this.formatRoleLabel(role, isShared);
		return `${directory.name} (${directory.slug}) ${roleLabel}`;
	}

	/**
	 * Formats role label for display
	 */
	protected formatRoleLabel(role: DirectoryMemberRole, isShared: boolean): string {
		const roleLabels: Record<DirectoryMemberRole, string> = {
			[DirectoryMemberRole.OWNER]: 'Owner',
			[DirectoryMemberRole.MANAGER]: 'Manager',
			[DirectoryMemberRole.EDITOR]: 'Editor',
			[DirectoryMemberRole.VIEWER]: 'Viewer'
		};

		const label = roleLabels[role] || role;
		return isShared ? chalk.magenta(`[${label}]`) : chalk.gray(`[${label}]`);
	}

	/**
	 * Validates directory name
	 */
	private validateName(name: string): string | boolean {
		if (name.length < 2) {
			return 'Directory name must be at least 2 characters long';
		}
		if (name.length > 100) {
			return 'Directory name must be less than 100 characters';
		}
		return true;
	}

	/**
	 * Validates directory description
	 */
	private validateDescription(description: string): string | boolean {
		if (description.length < 10) {
			return 'Description must be at least 10 characters long';
		}
		if (description.length > 500) {
			return 'Description must be less than 500 characters';
		}
		return true;
	}

	/**
	 * Generates an incremented slug for conflict resolution
	 */
	generateIncrementedSlug(baseSlug: string, increment: number): string {
		return `${baseSlug}-${increment}`;
	}
}
