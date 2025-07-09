import { Body, Controller, HttpCode, HttpStatus, Logger, NotFoundException, Param, Post } from '@nestjs/common';
import { DataGeneratorService } from '../data-generator/data-generator.service';
import { MarkdownGeneratorService } from '../markdown-generator/markdown-generator.service';
import { WebsiteGeneratorService } from '../website-generator/website-generator.service';
import { WebsiteUpdateService } from '../website-generator/website-update.service';
import { Directory } from '../entities/directory.entity';
import { User } from '../entities/user.entity';
import { GithubService } from '../git/github.service';
import { DirectoryRepository } from '../database/directory.repository';
import {
	CreateItemsGeneratorDto,
	GenerationMethod,
	UpdateItemsGeneratorDto
} from '../items-generator/dto/create-items-generator.dto';
import { ItemsGeneratorResponseDto } from '../items-generator/dto/items-generator-response.dto';
import {
	SubmitItemDto,
	SubmitItemResponseDto,
	RemoveItemDto,
	RemoveItemResponseDto,
	ExtractItemDetailsDto,
	ExtractItemDetailsResponseDto
} from '../items-generator/dto';
import { CreateDirectoryDto } from '../dto/create-directory.dto';
import { UpdateWebsiteRepositoryResponseDto } from '../website-generator/dto/update-website-repository.dto';
import { ItemSubmissionService } from '../items-generator/item-submission.service';
import { ItemsGeneratorService } from '../items-generator/items-generator.service';

@Controller()
export class AgentHTTPController {
	private readonly logger = new Logger(AgentHTTPController.name);

	constructor(
		private readonly dataGenerator: DataGeneratorService,
		private readonly markdownGenerator: MarkdownGeneratorService,
		private readonly websiteGenerator: WebsiteGeneratorService,
		private readonly websiteUpdateService: WebsiteUpdateService,
		private readonly githubService: GithubService,
		private readonly itemSubmissionService: ItemSubmissionService,
		private readonly itemsGeneratorService: ItemsGeneratorService,
		private readonly directoryRepository: DirectoryRepository
	) {}

	@Post('directories')
	@HttpCode(HttpStatus.OK)
	async createDirectory(@Body() createDirectoryDto: CreateDirectoryDto) {
		const { slug, name, description, owner } = createDirectoryDto;
		const user = await User.sessionMock();

		const ghOwner = await this.githubService.getUser(user.getGitToken());

		const directoryData = {
			slug,
			name,
			description,
			readmeConfig: createDirectoryDto.readme_config,
			owner: owner || ghOwner.login,
			organization: !!owner && owner !== ghOwner.login
		};

		const dir = await this.directoryRepository.create(directoryData);

		return {
			status: 'success',
			directory: dir
		};
	}

	@Post('generate')
	@HttpCode(HttpStatus.ACCEPTED)
	async generateItemsGenerator(
		@Body() createItemsGeneratorDto: CreateItemsGeneratorDto
	): Promise<ItemsGeneratorResponseDto> {
		const user = await User.sessionMock();
		const directory = await this.directoryRepository.findBySlug(createItemsGeneratorDto.slug);
		if (!directory) {
			throw new NotFoundException('Directory not found');
		}

		// TODO: Intentionally not awaiting this to allow for an immediate response
		// The actual processing will happen in the background.
		// A more robust solution might involve job queues, webhooks, or websockets for status updates.
		void this.processGeneration(directory, user, createItemsGeneratorDto);

		return {
			status: 'pending',
			slug: createItemsGeneratorDto.slug,
			parameters: createItemsGeneratorDto,
			message: `Processing request for '${createItemsGeneratorDto.name}'. Check logs or data directory for updates.`
		};
	}

	@Post('update/:slug')
	@HttpCode(HttpStatus.ACCEPTED)
	async updateItemsGenerator(
		@Param('slug') slug: string,
		@Body() updateItemsGeneratorDto: UpdateItemsGeneratorDto
	): Promise<ItemsGeneratorResponseDto> {
		const user = await User.sessionMock();
		const directory = await this.directoryRepository.findBySlug(slug);
		if (!directory) {
			throw new NotFoundException('Directory not found');
		}

		let lastRequestData = await this.dataGenerator.getLastRequestData(directory, user).catch(() => null);

		if (!lastRequestData) {
			throw new NotFoundException('No last request data found');
		}

		lastRequestData = {
			...lastRequestData,
			...updateItemsGeneratorDto
		};

		// TODO: Intentionally not awaiting this to allow for an immediate response
		// The actual processing will happen in the background.
		// A more robust solution might involve job queues, webhooks, or websockets for status updates.
		void this.processGeneration(directory, user, lastRequestData);

		return {
			slug,
			status: 'pending',
			parameters: lastRequestData,
			message: `Processing update for '${directory.name}'. Check logs or data directory for updates.`
		};
	}

	@Post('submit-item/:slug')
	@HttpCode(HttpStatus.OK)
	async submitItem(
		@Param('slug') slug: string,
		@Body() submitItemDto: SubmitItemDto
	): Promise<SubmitItemResponseDto> {
		try {
			const user = await User.sessionMock();

			// Check if directory exists for the given slug
			const directory = await this.directoryRepository.findBySlug(slug);
			if (!directory) {
				throw new NotFoundException(`Directory with slug '${slug}' not found`);
			}

			const result = await this.itemSubmissionService.submitItem(directory, user, submitItemDto);

			// Regenerate markdown for all items
			if (result.status === 'success') {
				await this.markdownGenerator.initialize(directory, user, {
					generation_method: result.auto_merged ? GenerationMethod.RECREATE : GenerationMethod.CREATE_UPDATE,
					pr_update: {
						branch: result.pr_branch_name,
						title: result.pr_title,
						body: result.pr_body
					}
				});
			}

			return result;
		} catch (error) {
			this.logger.error('Error submitting item:', error);

			return {
				status: 'error',
				slug,
				item_name: submitItemDto.name,
				message: 'Failed to submit item',
				error_details: error.message
			};
		}
	}

	@Post('remove-item/:slug')
	@HttpCode(HttpStatus.OK)
	async removeItem(
		@Param('slug') slug: string,
		@Body() removeItemDto: RemoveItemDto
	): Promise<RemoveItemResponseDto> {
		try {
			const user = await User.sessionMock();

			// Check if directory exists for the given slug
			const directory = await this.directoryRepository.findBySlug(slug);
			if (!directory) {
				throw new NotFoundException(`Directory with slug '${slug}' not found`);
			}

			const result = await this.itemSubmissionService.removeItem(directory, user, removeItemDto);

			// Regenerate markdown for all items (Always create PR for removal)
			if (result.status === 'success') {
				await this.markdownGenerator.initialize(directory, user, {
					generation_method: GenerationMethod.CREATE_UPDATE,
					remove_details: [removeItemDto.item_slug],
					pr_update: {
						branch: result.pr_branch_name,
						title: result.pr_title,
						body: result.pr_body
					}
				});
			}

			return result;
		} catch (error) {
			console.error('Error removing item:', error);

			return {
				status: 'error',
				slug,
				item_name: 'Unknown',
				item_slug: removeItemDto.item_slug,
				message: 'Failed to remove item',
				error_details: error.message
			};
		}
	}

	@Post('extract-item-details')
	@HttpCode(HttpStatus.OK)
	async extractItemDetails(
		@Body() extractItemDetailsDto: ExtractItemDetailsDto
	): Promise<ExtractItemDetailsResponseDto> {
		try {
			this.logger.log(`Extracting item details from URL: ${extractItemDetailsDto.source_url}`);

			const item = await this.itemsGeneratorService.extractItemDetailsFromUrl(
				extractItemDetailsDto.source_url,
				extractItemDetailsDto.existing_categories || []
			);

			if (!item) {
				return {
					status: 'error',
					source_url: extractItemDetailsDto.source_url,
					message: 'Failed to extract item details from the provided URL',
					error_details: 'No item data could be extracted from the URL content'
				};
			}

			return {
				status: 'success',
				source_url: extractItemDetailsDto.source_url,
				item,
				message: `Successfully extracted item details: "${item.name}"`
			};
		} catch (error) {
			console.error('Error extracting item details:', error);

			return {
				status: 'error',
				source_url: extractItemDetailsDto.source_url,
				message: 'Failed to extract item details',
				error_details: error.message
			};
		}
	}

	@Post('regenerate-markdown/:slug')
	@HttpCode(HttpStatus.OK)
	async regenerateMarkdown(@Param('slug') slug: string): Promise<{ status: string; error_details?: string }> {
		try {
			const user = await User.sessionMock();

			// Check if directory exists for the given slug
			const directory = await this.directoryRepository.findBySlug(slug);
			if (!directory) {
				throw new NotFoundException(`Directory with slug '${slug}' not found`);
			}

			// Regenerate markdown for all items
			await this.markdownGenerator.initialize(directory, user, {
				generation_method: GenerationMethod.RECREATE
			});

			return {
				status: 'success'
			};
		} catch (error) {
			console.error('Error regenerating markdown:', error);

			return {
				status: 'error',
				error_details: error.message
			};
		}
	}

	@Post('update-website/:slug')
	@HttpCode(HttpStatus.OK)
	async updateWebsiteRepository(@Param('slug') slug: string): Promise<UpdateWebsiteRepositoryResponseDto> {
		try {
			const user = await User.sessionMock();

			// Check if directory exists for the given slug
			const directory = await this.directoryRepository.findBySlug(slug);
			if (!directory) {
				throw new NotFoundException(`Directory with slug '${slug}' not found`);
			}

			const result = await this.websiteUpdateService.updateRepository(directory, user);

			return {
				status: 'success',
				slug: directory.slug,
				owner: directory.owner,
				repository: `${directory.owner}/${directory.slug}-website`,
				message: result.message,
				method_used: result.method
			};
		} catch (error) {
			console.error('Error updating website repository:', error);

			return {
				status: 'error',
				slug,
				owner: '',
				repository: `/${slug}-website`,
				message: 'Failed to update website repository',
				error_details: error.message
			};
		}
	}

	private async processGeneration(directory: Directory, user: User, dto: CreateItemsGeneratorDto) {
		const startTime = new Date();
		console.log(`Generation started at: ${startTime.toISOString()}`);

		try {
			const generated = await this.dataGenerator.initialize(directory, user, dto);

			if (generated) {
				await Promise.all([
					this.markdownGenerator.initialize(directory, user, {
						repository_description: dto.repository_description
					}),
					this.websiteGenerator.initialize(directory, user, dto.website_repository_creation_method)
				]);
			}
		} catch (error) {
			console.error('Error during generation:', error);
		}

		const endTime = new Date();
		console.log(`Generation finished at: ${endTime.toISOString()}`);
		const duration = (endTime.getTime() - startTime.getTime()) / 1000;
		console.log(`Total time taken: ${duration} seconds`);
	}
}
