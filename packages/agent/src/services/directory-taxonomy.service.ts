import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { DataGeneratorService } from '@src/data-generator/data-generator.service';
import { DirectoryOwnershipService } from './directory-ownership.service';
import { CreateCategoryDto, UpdateCategoryDto, CreateTagDto, UpdateTagDto } from '@src/dto';
import { Category, Tag } from '@src/items-generator/dto';
import { UserRepository } from '@src/database/repositories/user.repository';
import { slugifyText } from '@src/items-generator/utils/text.utils';

/**
 * Service for managing directory taxonomy (categories and tags).
 * Handles CRUD operations for categories and tags stored in the data repository.
 */
@Injectable()
export class DirectoryTaxonomyService {
    constructor(
        private readonly dataGenerator: DataGeneratorService,
        private readonly ownershipService: DirectoryOwnershipService,
        private readonly userRepository: UserRepository,
    ) {}

    // ============================================
    // Categories
    // ============================================

    async getCategories(directoryId: string, userId: string): Promise<Category[]> {
        const { directory } = await this.ownershipService.ensureAccess(directoryId, userId);
        const user = await this.userRepository.findById(userId);
        if (!user) {
            throw new NotFoundException('User not found');
        }

        const data = await this.dataGenerator.getCategoriesTags(directory, user);
        return data.categories || [];
    }

    async createCategory(
        directoryId: string,
        dto: CreateCategoryDto,
        userId: string,
    ): Promise<{ status: string; category: Category }> {
        const { directory } = await this.ownershipService.ensureCanEdit(directoryId, userId);
        const user = await this.userRepository.findById(userId);
        if (!user) {
            throw new NotFoundException('User not found');
        }

        // Get existing categories
        const { categories } = await this.dataGenerator.getCategoriesTags(directory, user);

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
        await this.dataGenerator.saveCategories(directory, user, updatedCategories);

        return {
            status: 'success',
            category: newCategory,
        };
    }

    async updateCategory(
        directoryId: string,
        categoryId: string,
        dto: UpdateCategoryDto,
        userId: string,
    ): Promise<{ status: string; category: Category }> {
        const { directory } = await this.ownershipService.ensureCanEdit(directoryId, userId);
        const user = await this.userRepository.findById(userId);
        if (!user) {
            throw new NotFoundException('User not found');
        }

        // Get existing categories
        const { categories } = await this.dataGenerator.getCategoriesTags(directory, user);

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
        await this.dataGenerator.saveCategories(directory, user, categories);

        return {
            status: 'success',
            category: updatedCategory,
        };
    }

    async deleteCategory(
        directoryId: string,
        categoryId: string,
        userId: string,
    ): Promise<{ status: string; message: string }> {
        const { directory } = await this.ownershipService.ensureCanEdit(directoryId, userId);
        const user = await this.userRepository.findById(userId);
        if (!user) {
            throw new NotFoundException('User not found');
        }

        // Get existing categories
        const { categories } = await this.dataGenerator.getCategoriesTags(directory, user);

        // Find the category
        const categoryIndex = categories.findIndex((c) => c.id === categoryId);
        if (categoryIndex === -1) {
            throw new NotFoundException('Category not found');
        }

        // Remove category
        categories.splice(categoryIndex, 1);

        // Save to data repository
        await this.dataGenerator.saveCategories(directory, user, categories);

        return {
            status: 'success',
            message: 'Category deleted successfully',
        };
    }

    // ============================================
    // Tags
    // ============================================

    async getTags(directoryId: string, userId: string): Promise<Tag[]> {
        const { directory } = await this.ownershipService.ensureAccess(directoryId, userId);
        const user = await this.userRepository.findById(userId);
        if (!user) {
            throw new NotFoundException('User not found');
        }

        const data = await this.dataGenerator.getCategoriesTags(directory, user);
        return data.tags || [];
    }

    async createTag(
        directoryId: string,
        dto: CreateTagDto,
        userId: string,
    ): Promise<{ status: string; tag: Tag }> {
        const { directory } = await this.ownershipService.ensureCanEdit(directoryId, userId);
        const user = await this.userRepository.findById(userId);
        if (!user) {
            throw new NotFoundException('User not found');
        }

        // Get existing tags
        const { tags } = await this.dataGenerator.getCategoriesTags(directory, user);

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
        await this.dataGenerator.saveTags(directory, user, updatedTags);

        return {
            status: 'success',
            tag: newTag,
        };
    }

    async updateTag(
        directoryId: string,
        tagId: string,
        dto: UpdateTagDto,
        userId: string,
    ): Promise<{ status: string; tag: Tag }> {
        const { directory } = await this.ownershipService.ensureCanEdit(directoryId, userId);
        const user = await this.userRepository.findById(userId);
        if (!user) {
            throw new NotFoundException('User not found');
        }

        // Get existing tags
        const { tags } = await this.dataGenerator.getCategoriesTags(directory, user);

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
        await this.dataGenerator.saveTags(directory, user, tags);

        return {
            status: 'success',
            tag: updatedTag,
        };
    }

    async deleteTag(
        directoryId: string,
        tagId: string,
        userId: string,
    ): Promise<{ status: string; message: string }> {
        const { directory } = await this.ownershipService.ensureCanEdit(directoryId, userId);
        const user = await this.userRepository.findById(userId);
        if (!user) {
            throw new NotFoundException('User not found');
        }

        // Get existing tags
        const { tags } = await this.dataGenerator.getCategoriesTags(directory, user);

        // Find the tag
        const tagIndex = tags.findIndex((t) => t.id === tagId);
        if (tagIndex === -1) {
            throw new NotFoundException('Tag not found');
        }

        // Remove tag
        tags.splice(tagIndex, 1);

        // Save to data repository
        await this.dataGenerator.saveTags(directory, user, tags);

        return {
            status: 'success',
            message: 'Tag deleted successfully',
        };
    }
}
