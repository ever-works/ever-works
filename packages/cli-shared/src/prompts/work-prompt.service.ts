import chalk from 'chalk';
import inquirer from 'inquirer';
import { BasePromptService } from './base-prompt.service';
import { validateSlug } from '../utils/slug-utils';

export interface WorkInputData {
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
 * Roles for work access.
 * - OWNER: Reserved for work creator only (returned by API for creator)
 * - MANAGER: Can edit work and manage content, invite/remove members
 * - EDITOR: Can edit work content but cannot manage members
 * - VIEWER: Read-only access to work
 *
 * Note: Members can only be assigned MANAGER, EDITOR, or VIEWER roles.
 */
export enum WorkMemberRole {
	OWNER = 'owner',
	MANAGER = 'manager',
	EDITOR = 'editor',
	VIEWER = 'viewer'
}

export interface WorkSelection {
	work: Work | null;
	cancelled: boolean;
	role?: WorkMemberRole;
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
	stepName?: string;
	stepIndex?: number;
	totalSteps?: number;
	progress?: number;
	itemsProcessed?: number;
	error?: string;
	warnings?: string[];
};

export type GetProjectsReadyState = 'BUILDING' | 'ERROR' | 'INITIALIZING' | 'QUEUED' | 'READY' | 'CANCELED' | 'TIMEOUT';

export interface Work {
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
	deployProvider?: string;
	userRole?: WorkMemberRole;
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

export class WorkPromptService extends BasePromptService {
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

	async promptWorkCreation(ownerDefault?: string, orgs?: { name: string; value: any }[]): Promise<WorkInputData> {
		this.displaySectionHeader('Work Creation');
		this.displayInfo('Please provide the following information to create a new work:');

		// Required fields - start with name first
		const name = await this.promptRequiredText(
			'Work name (display name):',
			undefined,
			this.validateName.bind(this)
		);

		// Generate initial slug from name, let user confirm/edit
		const initialSlug = this.slugifyName(name);
		const slug = await this.promptRequiredText('URL slug:', initialSlug, validateSlug);

		const description = await this.promptRequiredText(
			'Work description:',
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
			{ name: 'Cancel work creation', value: 'cancel' }
		]);

		if (action === 'modify') {
			const finalSlug = await this.promptRequiredText('Enter your preferred slug:', suggestedSlug, validateSlug);
			return { action, finalSlug };
		}

		return { action, finalSlug: action === 'use_suggested' ? suggestedSlug : undefined };
	}

	/**
	 * Prompts user to select a work from available works
	 * This method should be overridden by implementations to provide work listing
	 */
	async promptWorkSelection(works?: Work[]): Promise<WorkSelection> {
		if (!works || works.length === 0) {
			console.log(chalk.yellow('\nNo works found.'));
			console.log(chalk.gray('Create your first work with: ') + chalk.cyan('work create'));
			return { work: null, cancelled: true };
		}

		type Choice = { name: string; value: Work | null; short: string };

		const choices: Choice[] = works.map((dir) => {
			const role = dir.userRole || WorkMemberRole.OWNER;
			const isShared = role !== WorkMemberRole.OWNER;
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

		const { selectedWork } = await inquirer.prompt([
			{
				type: 'list',
				name: 'selectedWork',
				message: 'Select a work:',
				choices,
				pageSize: 15
			}
		]);

		if (!selectedWork) {
			return { work: null, cancelled: true };
		}

		// Determine role for the selected work
		const role = selectedWork.userRole || WorkMemberRole.OWNER;
		const isShared = role !== WorkMemberRole.OWNER;

		return {
			work: selectedWork,
			cancelled: false,
			role,
			isShared
		};
	}

	/**
	 * Formats a work selection message showing the role.
	 */
	formatSelectedWork(work: Work, role: WorkMemberRole, isShared: boolean): string {
		const roleLabel = this.formatRoleLabel(role, isShared);
		return `${work.name} (${work.slug}) ${roleLabel}`;
	}

	/**
	 * Formats role label for display
	 */
	protected formatRoleLabel(role: WorkMemberRole, isShared: boolean): string {
		const roleLabels: Record<WorkMemberRole, string> = {
			[WorkMemberRole.OWNER]: 'Owner',
			[WorkMemberRole.MANAGER]: 'Manager',
			[WorkMemberRole.EDITOR]: 'Editor',
			[WorkMemberRole.VIEWER]: 'Viewer'
		};

		const label = roleLabels[role] || role;
		return isShared ? chalk.magenta(`[${label}]`) : chalk.gray(`[${label}]`);
	}

	/**
	 * Validates work name
	 */
	private validateName(name: string): string | boolean {
		if (name.length < 2) {
			return 'Work name must be at least 2 characters long';
		}
		if (name.length > 100) {
			return 'Work name must be less than 100 characters';
		}
		return true;
	}

	/**
	 * Validates work description
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
