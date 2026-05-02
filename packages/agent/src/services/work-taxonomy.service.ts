import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { DataGeneratorService } from '@src/generators/data-generator/data-generator.service';
import { WorkOwnershipService } from './work-ownership.service';
import {
    CreateCategoryDto,
    UpdateCategoryDto,
    CreateCollectionDto,
    UpdateCollectionDto,
    CreateTagDto,
    UpdateTagDto,
} from '@src/dto';
import type { Category, Collection, Tag } from '@ever-works/contracts';
import { User } from '@src/entities/user.entity';
import { UserRepository } from '@src/database/repositories/user.repository';
import { slugifyText } from '@src/utils/text.utils';
import { WorkGenerationHistoryRepository } from '@src/database/repositories/work-generation-history.repository';
import { GenerateStatusType } from '@src/entities/types';
import {
    WorkHistoryActivityType,
    type WorkHistoryChangeEntry,
} from '@ever-works/contracts/api';
import { buildWorkChangelog } from '@src/utils/work-changelog.utils';

/**
 * Service for managing work taxonomy (categories and tags).
 * Handles CRUD operations for categories and tags stored in the data repository.
 */
@Injectable()
export class WorkTaxonomyService {
    constructor(
        private readonly dataGenerator: DataGeneratorService,
        private readonly ownershipService: WorkOwnershipService,
        private readonly userRepository: UserRepository,
        private readonly generationHistoryRepository: WorkGenerationHistoryRepository,
    ) {}

    private async ensureUser(userId: string): Promise<User> {
        const user = await this.userRepository.findById(userId);
        if (!user) {
            throw new NotFoundException(`User not found: ${userId}`);
        }
        return user;
    }

    private async recordTaxonomyHistory(params: {
        workId: string;
        userId: string;
        activityType: WorkHistoryActivityType;
        entries: WorkHistoryChangeEntry[];
        summary: string;
    }): Promise<void> {
        const now = new Date();

        await this.generationHistoryRepository.createEntry({
            workId: params.workId,
            userId: params.userId,
            status: GenerateStatusType.GENERATED,
            startedAt: now,
            finishedAt: now,
            durationInSeconds: 0,
            triggeredBy: 'user',
            activityType: params.activityType,
            changelog: buildWorkChangelog(params.entries, params.summary),
        });
    }

    // ============================================
    // Categories
    // ============================================

    async getCategories(workId: string, userId: string): Promise<Category[]> {
        const { work } = await this.ownershipService.ensureAccess(workId, userId);
        const user = await this.ensureUser(userId);

        const data = await this.dataGenerator.getCategoriesTags(work, user);
        return data.categories || [];
    }

    async createCategory(
        workId: string,
        dto: CreateCategoryDto,
        userId: string,
    ): Promise<{ status: string; category: Category }> {
        const { work } = await this.ownershipService.ensureCanEdit(workId, userId);
        const user = await this.ensureUser(userId);

        // Get existing categories
        const { categories } = await this.dataGenerator.getCategoriesTags(work, user);

        // Check for duplicate name
        const normalizedName = dto.name.toLowerCase().trim();
        if (categories.some((c) => c.name.toLowerCase() === normalizedName)) {
            throw new BadRequestException('A category with this name already exists');
        }

        // Create new category with slugified ID to match item category references
        const newCategory: Category = {
            id: slugifyText(dto.name.trim()),
            name: dto.name.trim(),
            description: dto.description?.trim(),
            icon_url: dto.icon_url?.trim(),
            priority: dto.priority,
        };

        // Save to data repository
        const updatedCategories = [...categories, newCategory];
        await this.dataGenerator.saveCategories(work, user, updatedCategories);

        await this.recordTaxonomyHistory({
            workId,
            userId,
            activityType: WorkHistoryActivityType.CATEGORY_CHANGE,
            entries: [
                {
                    entityType: 'category',
                    action: 'added',
                    name: newCategory.name,
                    slug: newCategory.id,
                },
            ],
            summary: `Category added: ${newCategory.name}`,
        });

        return {
            status: 'success',
            category: newCategory,
        };
    }

    async updateCategory(
        workId: string,
        categoryId: string,
        dto: UpdateCategoryDto,
        userId: string,
    ): Promise<{ status: string; category: Category }> {
        const { work } = await this.ownershipService.ensureCanEdit(workId, userId);
        const user = await this.ensureUser(userId);

        // Get existing categories
        const { categories } = await this.dataGenerator.getCategoriesTags(work, user);

        // Find the category to update
        const categoryIndex = categories.findIndex((c) => c.id === categoryId);
        if (categoryIndex === -1) {
            throw new NotFoundException('Category not found');
        }

        // Check for duplicate name if name is being changed
        if (dto.name) {
            const normalizedName = dto.name.toLowerCase().trim();
            const existingWithName = categories.find(
                (c) => c.id !== categoryId && c.name.toLowerCase() === normalizedName,
            );
            if (existingWithName) {
                throw new BadRequestException('A category with this name already exists');
            }
        }

        // Update category
        const updatedCategory: Category = {
            ...categories[categoryIndex],
            ...(dto.name && { name: dto.name.trim() }),
            ...(dto.description !== undefined && { description: dto.description?.trim() }),
            ...(dto.icon_url !== undefined && { icon_url: dto.icon_url?.trim() }),
            ...(dto.priority !== undefined && { priority: dto.priority }),
        };

        categories[categoryIndex] = updatedCategory;

        // Save to data repository
        await this.dataGenerator.saveCategories(work, user, categories);

        await this.recordTaxonomyHistory({
            workId,
            userId,
            activityType: WorkHistoryActivityType.CATEGORY_CHANGE,
            entries: [
                {
                    entityType: 'category',
                    action: 'updated',
                    name: updatedCategory.name,
                    slug: updatedCategory.id,
                    fieldsChanged: Object.keys(dto).filter(
                        (key) =>
                            (dto as Record<string, unknown>)[key] !== undefined &&
                            ['name', 'description', 'icon_url', 'priority'].includes(key),
                    ),
                },
            ],
            summary: `Category updated: ${updatedCategory.name}`,
        });

        return {
            status: 'success',
            category: updatedCategory,
        };
    }

    async deleteCategory(
        workId: string,
        categoryId: string,
        userId: string,
    ): Promise<{ status: string; message: string }> {
        const { work } = await this.ownershipService.ensureCanEdit(workId, userId);
        const user = await this.ensureUser(userId);

        // Get existing categories
        const { categories } = await this.dataGenerator.getCategoriesTags(work, user);

        // Find the category
        const categoryIndex = categories.findIndex((c) => c.id === categoryId);
        if (categoryIndex === -1) {
            throw new NotFoundException('Category not found');
        }

        const removedCategory = categories[categoryIndex];
        // Remove category
        categories.splice(categoryIndex, 1);

        // Save to data repository
        await this.dataGenerator.saveCategories(work, user, categories);

        await this.recordTaxonomyHistory({
            workId,
            userId,
            activityType: WorkHistoryActivityType.CATEGORY_CHANGE,
            entries: [
                {
                    entityType: 'category',
                    action: 'removed',
                    name: removedCategory.name,
                    slug: removedCategory.id,
                },
            ],
            summary: `Category removed: ${removedCategory.name}`,
        });

        return {
            status: 'success',
            message: 'Category deleted successfully',
        };
    }

    // ============================================
    // Tags
    // ============================================

    async getTags(workId: string, userId: string): Promise<Tag[]> {
        const { work } = await this.ownershipService.ensureAccess(workId, userId);
        const user = await this.ensureUser(userId);

        const data = await this.dataGenerator.getCategoriesTags(work, user);
        return data.tags || [];
    }

    async createTag(
        workId: string,
        dto: CreateTagDto,
        userId: string,
    ): Promise<{ status: string; tag: Tag }> {
        const { work } = await this.ownershipService.ensureCanEdit(workId, userId);
        const user = await this.ensureUser(userId);

        // Get existing tags
        const { tags } = await this.dataGenerator.getCategoriesTags(work, user);

        // Check for duplicate name
        const normalizedName = dto.name.toLowerCase().trim();
        if (tags.some((t) => t.name.toLowerCase() === normalizedName)) {
            throw new BadRequestException('A tag with this name already exists');
        }

        // Create new tag with slugified ID to match item tag references
        const newTag: Tag = {
            id: slugifyText(dto.name.trim()),
            name: dto.name.trim(),
        };

        // Save to data repository
        const updatedTags = [...tags, newTag];
        await this.dataGenerator.saveTags(work, user, updatedTags);

        await this.recordTaxonomyHistory({
            workId,
            userId,
            activityType: WorkHistoryActivityType.TAG_CHANGE,
            entries: [
                {
                    entityType: 'tag',
                    action: 'added',
                    name: newTag.name,
                    slug: newTag.id,
                },
            ],
            summary: `Tag added: ${newTag.name}`,
        });

        return {
            status: 'success',
            tag: newTag,
        };
    }

    async updateTag(
        workId: string,
        tagId: string,
        dto: UpdateTagDto,
        userId: string,
    ): Promise<{ status: string; tag: Tag }> {
        const { work } = await this.ownershipService.ensureCanEdit(workId, userId);
        const user = await this.ensureUser(userId);

        // Get existing tags
        const { tags } = await this.dataGenerator.getCategoriesTags(work, user);

        // Find the tag to update
        const tagIndex = tags.findIndex((t) => t.id === tagId);
        if (tagIndex === -1) {
            throw new NotFoundException('Tag not found');
        }

        // Check for duplicate name if name is being changed
        if (dto.name) {
            const normalizedName = dto.name.toLowerCase().trim();
            const existingWithName = tags.find(
                (t) => t.id !== tagId && t.name.toLowerCase() === normalizedName,
            );
            if (existingWithName) {
                throw new BadRequestException('A tag with this name already exists');
            }
        }

        // Update tag
        const updatedTag: Tag = {
            ...tags[tagIndex],
            ...(dto.name && { name: dto.name.trim() }),
        };

        tags[tagIndex] = updatedTag;

        // Save to data repository
        await this.dataGenerator.saveTags(work, user, tags);

        await this.recordTaxonomyHistory({
            workId,
            userId,
            activityType: WorkHistoryActivityType.TAG_CHANGE,
            entries: [
                {
                    entityType: 'tag',
                    action: 'updated',
                    name: updatedTag.name,
                    slug: updatedTag.id,
                    fieldsChanged: Object.keys(dto).filter(
                        (key) => (dto as Record<string, unknown>)[key] !== undefined,
                    ),
                },
            ],
            summary: `Tag updated: ${updatedTag.name}`,
        });

        return {
            status: 'success',
            tag: updatedTag,
        };
    }

    async deleteTag(
        workId: string,
        tagId: string,
        userId: string,
    ): Promise<{ status: string; message: string }> {
        const { work } = await this.ownershipService.ensureCanEdit(workId, userId);
        const user = await this.ensureUser(userId);

        // Get existing tags
        const { tags } = await this.dataGenerator.getCategoriesTags(work, user);

        // Find the tag
        const tagIndex = tags.findIndex((t) => t.id === tagId);
        if (tagIndex === -1) {
            throw new NotFoundException('Tag not found');
        }

        const removedTag = tags[tagIndex];
        // Remove tag
        tags.splice(tagIndex, 1);

        // Save to data repository
        await this.dataGenerator.saveTags(work, user, tags);

        await this.recordTaxonomyHistory({
            workId,
            userId,
            activityType: WorkHistoryActivityType.TAG_CHANGE,
            entries: [
                {
                    entityType: 'tag',
                    action: 'removed',
                    name: removedTag.name,
                    slug: removedTag.id,
                },
            ],
            summary: `Tag removed: ${removedTag.name}`,
        });

        return {
            status: 'success',
            message: 'Tag deleted successfully',
        };
    }

    // ============================================
    // Collections
    // ============================================

    async getCollections(workId: string, userId: string): Promise<Collection[]> {
        const { work } = await this.ownershipService.ensureAccess(workId, userId);
        const user = await this.ensureUser(userId);

        const data = await this.dataGenerator.getCategoriesTags(work, user);
        return data.collections || [];
    }

    async createCollection(
        workId: string,
        dto: CreateCollectionDto,
        userId: string,
    ): Promise<{ status: string; collection: Collection }> {
        const { work } = await this.ownershipService.ensureCanEdit(workId, userId);
        const user = await this.ensureUser(userId);

        // Get existing collections
        const { collections } = await this.dataGenerator.getCategoriesTags(work, user);

        // Check for duplicate name
        const normalizedName = dto.name.toLowerCase().trim();
        if (collections.some((c) => c.name.toLowerCase() === normalizedName)) {
            throw new BadRequestException('A collection with this name already exists');
        }

        // Create new collection with slugified ID
        const newCollection: Collection = {
            id: slugifyText(dto.name.trim()),
            name: dto.name.trim(),
            description: dto.description?.trim(),
            icon_url: dto.icon_url?.trim(),
            priority: dto.priority,
        };

        // Save to data repository
        const updatedCollections = [...collections, newCollection];
        await this.dataGenerator.saveCollections(work, user, updatedCollections);

        await this.recordTaxonomyHistory({
            workId,
            userId,
            activityType: WorkHistoryActivityType.COLLECTION_CHANGE,
            entries: [
                {
                    entityType: 'collection',
                    action: 'added',
                    name: newCollection.name,
                    slug: newCollection.id,
                },
            ],
            summary: `Collection added: ${newCollection.name}`,
        });

        return {
            status: 'success',
            collection: newCollection,
        };
    }

    async updateCollection(
        workId: string,
        collectionId: string,
        dto: UpdateCollectionDto,
        userId: string,
    ): Promise<{ status: string; collection: Collection }> {
        const { work } = await this.ownershipService.ensureCanEdit(workId, userId);
        const user = await this.ensureUser(userId);

        // Get existing collections
        const { collections } = await this.dataGenerator.getCategoriesTags(work, user);

        // Find the collection to update
        const collectionIndex = collections.findIndex((c) => c.id === collectionId);
        if (collectionIndex === -1) {
            throw new NotFoundException('Collection not found');
        }

        // Check for duplicate name if name is being changed
        if (dto.name) {
            const normalizedName = dto.name.toLowerCase().trim();
            const existingWithName = collections.find(
                (c) => c.id !== collectionId && c.name.toLowerCase() === normalizedName,
            );
            if (existingWithName) {
                throw new BadRequestException('A collection with this name already exists');
            }
        }

        // Update collection
        const updatedCollection: Collection = {
            ...collections[collectionIndex],
            ...(dto.name && { name: dto.name.trim() }),
            ...(dto.description !== undefined && { description: dto.description?.trim() }),
            ...(dto.icon_url !== undefined && { icon_url: dto.icon_url?.trim() }),
            ...(dto.priority !== undefined && { priority: dto.priority }),
        };

        collections[collectionIndex] = updatedCollection;

        // Save to data repository
        await this.dataGenerator.saveCollections(work, user, collections);

        await this.recordTaxonomyHistory({
            workId,
            userId,
            activityType: WorkHistoryActivityType.COLLECTION_CHANGE,
            entries: [
                {
                    entityType: 'collection',
                    action: 'updated',
                    name: updatedCollection.name,
                    slug: updatedCollection.id,
                    fieldsChanged: Object.keys(dto).filter(
                        (key) =>
                            (dto as Record<string, unknown>)[key] !== undefined &&
                            ['name', 'description', 'icon_url', 'priority'].includes(key),
                    ),
                },
            ],
            summary: `Collection updated: ${updatedCollection.name}`,
        });

        return {
            status: 'success',
            collection: updatedCollection,
        };
    }

    async deleteCollection(
        workId: string,
        collectionId: string,
        userId: string,
    ): Promise<{ status: string; message: string }> {
        const { work } = await this.ownershipService.ensureCanEdit(workId, userId);
        const user = await this.ensureUser(userId);

        // Get existing collections
        const { collections } = await this.dataGenerator.getCategoriesTags(work, user);

        // Find the collection
        const collectionIndex = collections.findIndex((c) => c.id === collectionId);
        if (collectionIndex === -1) {
            throw new NotFoundException('Collection not found');
        }

        const removedCollection = collections[collectionIndex];
        // Remove collection
        collections.splice(collectionIndex, 1);

        // Save to data repository
        await this.dataGenerator.saveCollections(work, user, collections);

        await this.recordTaxonomyHistory({
            workId,
            userId,
            activityType: WorkHistoryActivityType.COLLECTION_CHANGE,
            entries: [
                {
                    entityType: 'collection',
                    action: 'removed',
                    name: removedCollection.name,
                    slug: removedCollection.id,
                },
            ],
            summary: `Collection removed: ${removedCollection.name}`,
        });

        return {
            status: 'success',
            message: 'Collection deleted successfully',
        };
    }
}
