import { Test, TestingModule } from '@nestjs/testing';
import { CommunityPrProcessorService } from '../community-pr-processor.service';
import { GitFacadeService } from '../../facades/git.facade';
import { AiFacadeService } from '../../facades/ai.facade';
import { DirectoryRepository } from '../../database/repositories/directory.repository';
import type { Directory } from '../../entities/directory.entity';
import type { GitPullRequest, GitPullRequestFile } from '@ever-works/plugin';

describe('CommunityPrProcessorService', () => {
	let service: CommunityPrProcessorService;
	let gitFacade: jest.Mocked<GitFacadeService>;
	let aiFacade: jest.Mocked<AiFacadeService>;
	let directoryRepository: jest.Mocked<DirectoryRepository>;

	const createMockDirectory = (overrides: Partial<Directory> = {}): Directory => {
		const dir = {
			id: 'dir-1',
			name: 'Test Directory',
			slug: 'test-directory',
			description: 'A test directory',
			userId: 'user-1',
			gitProvider: 'github',
			owner: 'testowner',
			communityPrProcessingEnabled: true,
			communityPrAutoClose: true,
			communityPrState: null,
			user: { id: 'user-1', username: 'testowner' } as any,
			getRepoOwner: () => overrides.owner || 'testowner',
			getMainRepo: () => overrides.slug || 'test-directory',
			getDataRepo: () => `${overrides.slug || 'test-directory'}-data`,
			...overrides,
		} as unknown as Directory;
		return dir;
	};

	const createMockPR = (overrides: Partial<GitPullRequest> = {}): GitPullRequest => ({
		number: 1,
		title: 'Add new tool',
		state: 'open',
		head: 'feature-branch',
		base: 'main',
		url: 'https://github.com/testowner/test-directory/pull/1',
		createdAt: '2024-01-01T00:00:00Z',
		updatedAt: '2024-01-01T00:00:00Z',
		body: 'Adding a new tool to the directory',
		...overrides,
	});

	const createMockFile = (overrides: Partial<GitPullRequestFile> = {}): GitPullRequestFile => ({
		filename: 'README.md',
		status: 'modified',
		additions: 5,
		deletions: 0,
		patch: '+- [New Tool](https://newtool.com) - A great new tool',
		...overrides,
	});

	beforeEach(async () => {
		const module: TestingModule = await Test.createTestingModule({
			providers: [
				CommunityPrProcessorService,
				{
					provide: GitFacadeService,
					useValue: {
						listPullRequests: jest.fn().mockResolvedValue([]),
						getPullRequestFiles: jest.fn().mockResolvedValue([]),
						createPullRequestComment: jest.fn().mockResolvedValue({ id: 1, body: '' }),
						closePullRequest: jest.fn().mockResolvedValue({}),
						cloneOrPull: jest.fn().mockResolvedValue('/tmp/test-data'),
						add: jest.fn().mockResolvedValue(undefined),
						commit: jest.fn().mockResolvedValue('abc123'),
						push: jest.fn().mockResolvedValue(undefined),
					},
				},
				{
					provide: AiFacadeService,
					useValue: {
						askJson: jest.fn().mockResolvedValue({
							result: { items: [] },
							usage: null,
							cost: null,
						}),
					},
				},
				{
					provide: DirectoryRepository,
					useValue: {
						findWithCommunityPrProcessingEnabled: jest.fn().mockResolvedValue([]),
						update: jest.fn().mockResolvedValue(undefined),
					},
				},
			],
		}).compile();

		service = module.get(CommunityPrProcessorService);
		gitFacade = module.get(GitFacadeService);
		aiFacade = module.get(AiFacadeService);
		directoryRepository = module.get(DirectoryRepository);
	});

	describe('processAllDirectories', () => {
		it('should skip directories with no open PRs', async () => {
			const directory = createMockDirectory();
			directoryRepository.findWithCommunityPrProcessingEnabled.mockResolvedValue([directory]);
			gitFacade.listPullRequests.mockResolvedValue([]);

			const result = await service.processAllDirectories();

			expect(result.processed).toBe(0);
			expect(result.errors).toHaveLength(0);
			expect(aiFacade.askJson).not.toHaveBeenCalled();
		});

		it('should handle errors per directory without stopping batch', async () => {
			const dir1 = createMockDirectory({ id: 'dir-1' });
			const dir2 = createMockDirectory({ id: 'dir-2' });
			directoryRepository.findWithCommunityPrProcessingEnabled.mockResolvedValue([dir1, dir2]);

			gitFacade.listPullRequests
				.mockRejectedValueOnce(new Error('API error'))
				.mockResolvedValueOnce([]);

			const result = await service.processAllDirectories();

			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].directoryId).toBe('dir-1');
			expect(result.errors[0].error).toBe('API error');
		});
	});

	describe('processDirectory', () => {
		it('should return 0 when no open PRs exist', async () => {
			const directory = createMockDirectory();
			gitFacade.listPullRequests.mockResolvedValue([]);

			const result = await service.processDirectory(directory);

			expect(result).toBe(0);
		});

		it('should skip already-processed PR numbers', async () => {
			const directory = createMockDirectory({
				communityPrState: {
					processedPrNumbers: [1, 2],
					lastProcessedAt: '2024-01-01T00:00:00Z',
					totalItemsAdded: 5,
				},
			});
			gitFacade.listPullRequests.mockResolvedValue([
				createMockPR({ number: 1 }),
				createMockPR({ number: 2 }),
			]);

			const result = await service.processDirectory(directory);

			expect(result).toBe(0);
			expect(gitFacade.getPullRequestFiles).not.toHaveBeenCalled();
		});

		it('should extract items via AI and write to data repo', async () => {
			const directory = createMockDirectory();
			const pr = createMockPR({ number: 3 });
			gitFacade.listPullRequests.mockResolvedValue([pr]);
			gitFacade.getPullRequestFiles.mockResolvedValue([createMockFile()]);

			// Mock DataRepository.create — we need to mock the module
			jest.spyOn(
				require('../../generators/data-generator/data-repository').DataRepository,
				'create',
			).mockResolvedValue({
				getCategories: jest.fn().mockResolvedValue([{ name: 'Tools', slug: 'tools' }]),
				createItemDir: jest.fn().mockResolvedValue(undefined),
				writeItem: jest.fn().mockResolvedValue(undefined),
				writeItemMarkdown: jest.fn().mockResolvedValue(undefined),
			});

			aiFacade.askJson.mockResolvedValue({
				result: {
					items: [
						{
							name: 'New Tool',
							description: 'A great new tool',
							source_url: 'https://newtool.com',
							category: 'Tools',
							tags: ['tool', 'utility'],
						},
					],
				},
				usage: null,
				cost: null,
			} as any);

			const result = await service.processDirectory(directory);

			expect(result).toBe(1);
			expect(gitFacade.add).toHaveBeenCalled();
			expect(gitFacade.commit).toHaveBeenCalled();
			expect(gitFacade.push).toHaveBeenCalled();
			expect(gitFacade.createPullRequestComment).toHaveBeenCalledWith(
				'testowner',
				'test-directory',
				3,
				expect.stringContaining('New Tool'),
				expect.any(Object),
			);
			expect(gitFacade.closePullRequest).toHaveBeenCalledWith(
				'testowner',
				'test-directory',
				3,
				expect.any(Object),
			);
			expect(directoryRepository.update).toHaveBeenCalledWith(
				'dir-1',
				expect.objectContaining({
					communityPrState: expect.objectContaining({
						processedPrNumbers: [3],
						totalItemsAdded: 1,
					}),
				}),
			);
		});

		it('should comment and not close PR when no items extracted', async () => {
			const directory = createMockDirectory();
			const pr = createMockPR({ number: 4 });
			gitFacade.listPullRequests.mockResolvedValue([pr]);
			gitFacade.getPullRequestFiles.mockResolvedValue([createMockFile()]);

			jest.spyOn(
				require('../../generators/data-generator/data-repository').DataRepository,
				'create',
			).mockResolvedValue({
				getCategories: jest.fn().mockResolvedValue([]),
				createItemDir: jest.fn(),
				writeItem: jest.fn(),
				writeItemMarkdown: jest.fn(),
			});

			aiFacade.askJson.mockResolvedValue({
				result: { items: [] },
				usage: null,
				cost: null,
			} as any);

			const result = await service.processDirectory(directory);

			expect(result).toBe(0);
			expect(gitFacade.createPullRequestComment).toHaveBeenCalledWith(
				'testowner',
				'test-directory',
				4,
				expect.stringContaining('could not extract'),
				expect.any(Object),
			);
			expect(gitFacade.closePullRequest).not.toHaveBeenCalled();
			expect(gitFacade.commit).not.toHaveBeenCalled();
		});

		it('should not close PR when communityPrAutoClose is false', async () => {
			const directory = createMockDirectory({ communityPrAutoClose: false });
			const pr = createMockPR({ number: 5 });
			gitFacade.listPullRequests.mockResolvedValue([pr]);
			gitFacade.getPullRequestFiles.mockResolvedValue([createMockFile()]);

			jest.spyOn(
				require('../../generators/data-generator/data-repository').DataRepository,
				'create',
			).mockResolvedValue({
				getCategories: jest.fn().mockResolvedValue([]),
				createItemDir: jest.fn().mockResolvedValue(undefined),
				writeItem: jest.fn().mockResolvedValue(undefined),
				writeItemMarkdown: jest.fn().mockResolvedValue(undefined),
			});

			aiFacade.askJson.mockResolvedValue({
				result: {
					items: [
						{
							name: 'Another Tool',
							description: 'Description',
							source_url: 'https://example.com',
							category: 'Tools',
							tags: ['tool'],
						},
					],
				},
				usage: null,
				cost: null,
			} as any);

			await service.processDirectory(directory);

			expect(gitFacade.closePullRequest).not.toHaveBeenCalled();
		});

		it('should handle errors per PR without stopping batch', async () => {
			const directory = createMockDirectory();
			gitFacade.listPullRequests.mockResolvedValue([
				createMockPR({ number: 6 }),
				createMockPR({ number: 7 }),
			]);

			// First PR fails, second returns no files
			gitFacade.getPullRequestFiles
				.mockRejectedValueOnce(new Error('PR files error'))
				.mockResolvedValueOnce([]);

			const result = await service.processDirectory(directory);

			expect(result).toBe(0);
			// Both PRs should be marked as processed
			expect(directoryRepository.update).toHaveBeenCalledWith(
				'dir-1',
				expect.objectContaining({
					communityPrState: expect.objectContaining({
						processedPrNumbers: expect.arrayContaining([6, 7]),
						lastError: 'PR files error',
					}),
				}),
			);
		});

		it('should cap processedPrNumbers at 500', async () => {
			const existingNumbers = Array.from({ length: 499 }, (_, i) => i + 1);
			const directory = createMockDirectory({
				communityPrState: {
					processedPrNumbers: existingNumbers,
					totalItemsAdded: 0,
				},
			});

			gitFacade.listPullRequests.mockResolvedValue([
				createMockPR({ number: 600 }),
				createMockPR({ number: 601 }),
			]);

			// Both PRs will have no files (empty change context triggers comment)
			gitFacade.getPullRequestFiles.mockResolvedValue([]);

			await service.processDirectory(directory);

			expect(directoryRepository.update).toHaveBeenCalledWith(
				'dir-1',
				expect.objectContaining({
					communityPrState: expect.objectContaining({
						processedPrNumbers: expect.any(Array),
					}),
				}),
			);

			const updateCall = directoryRepository.update.mock.calls[0][1] as any;
			expect(updateCall.communityPrState.processedPrNumbers.length).toBeLessThanOrEqual(500);
		});

		it('should comment when PR has no meaningful changes', async () => {
			const directory = createMockDirectory();
			gitFacade.listPullRequests.mockResolvedValue([createMockPR({ number: 8 })]);
			gitFacade.getPullRequestFiles.mockResolvedValue([]);

			await service.processDirectory(directory);

			expect(gitFacade.createPullRequestComment).toHaveBeenCalledWith(
				'testowner',
				'test-directory',
				8,
				expect.stringContaining('unable to extract'),
				expect.any(Object),
			);
		});
	});
});
