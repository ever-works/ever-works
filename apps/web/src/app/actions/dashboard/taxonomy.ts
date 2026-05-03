'use server';

import { workAPI, Category, Tag, Collection } from '@/lib/api';
import { getAuthFromCookie } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { ROUTES } from '@/lib/constants';
import { revalidatePath } from 'next/cache';

// Category CRUD operations

export async function createCategory(workId: string, data: Partial<Category>) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await workAPI.createCategory(workId, data);

        if (response.status === 'success' && response.category) {
            revalidatePath(`/works/${workId}/items`);
            revalidatePath(`/works/${workId}`);
            return {
                success: true,
                category: response.category,
            };
        }

        return {
            success: false,
            error: 'Failed to create category',
        };
    } catch (error) {
        console.error('Create category error:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to create category',
        };
    }
}

export async function updateCategory(workId: string, categoryId: string, data: Partial<Category>) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await workAPI.updateCategory(workId, categoryId, data);

        if (response.status === 'success' && response.category) {
            revalidatePath(`/works/${workId}/items`);
            revalidatePath(`/works/${workId}`);
            return {
                success: true,
                category: response.category,
            };
        }

        return {
            success: false,
            error: 'Failed to update category',
        };
    } catch (error) {
        console.error('Update category error:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to update category',
        };
    }
}

export async function deleteCategory(workId: string, categoryId: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await workAPI.deleteCategory(workId, categoryId);

        if (response.status === 'success') {
            revalidatePath(`/works/${workId}/items`);
            revalidatePath(`/works/${workId}`);
            return {
                success: true,
            };
        }

        return {
            success: false,
            error: 'Failed to delete category',
        };
    } catch (error) {
        console.error('Delete category error:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to delete category',
        };
    }
}

// Tag CRUD operations

export async function createTag(workId: string, data: Partial<Tag>) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await workAPI.createTag(workId, data);

        if (response.status === 'success' && response.tag) {
            revalidatePath(`/works/${workId}/items`);
            revalidatePath(`/works/${workId}`);
            return {
                success: true,
                tag: response.tag,
            };
        }

        return {
            success: false,
            error: 'Failed to create tag',
        };
    } catch (error) {
        console.error('Create tag error:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to create tag',
        };
    }
}

export async function updateTag(workId: string, tagId: string, data: Partial<Tag>) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await workAPI.updateTag(workId, tagId, data);

        if (response.status === 'success' && response.tag) {
            revalidatePath(`/works/${workId}/items`);
            revalidatePath(`/works/${workId}`);
            return {
                success: true,
                tag: response.tag,
            };
        }

        return {
            success: false,
            error: 'Failed to update tag',
        };
    } catch (error) {
        console.error('Update tag error:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to update tag',
        };
    }
}

export async function deleteTag(workId: string, tagId: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await workAPI.deleteTag(workId, tagId);

        if (response.status === 'success') {
            revalidatePath(`/works/${workId}/items`);
            revalidatePath(`/works/${workId}`);
            return {
                success: true,
            };
        }

        return {
            success: false,
            error: 'Failed to delete tag',
        };
    } catch (error) {
        console.error('Delete tag error:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to delete tag',
        };
    }
}

// Collection CRUD operations

export async function createCollection(workId: string, data: Partial<Collection>) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await workAPI.createCollection(workId, data);

        if (response.status === 'success' && response.collection) {
            revalidatePath(`/works/${workId}/items`);
            revalidatePath(`/works/${workId}`);
            return {
                success: true,
                collection: response.collection,
            };
        }

        return {
            success: false,
            error: 'Failed to create collection',
        };
    } catch (error) {
        console.error('Create collection error:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to create collection',
        };
    }
}

export async function updateCollection(
    workId: string,
    collectionId: string,
    data: Partial<Collection>,
) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await workAPI.updateCollection(workId, collectionId, data);

        if (response.status === 'success' && response.collection) {
            revalidatePath(`/works/${workId}/items`);
            revalidatePath(`/works/${workId}`);
            return {
                success: true,
                collection: response.collection,
            };
        }

        return {
            success: false,
            error: 'Failed to update collection',
        };
    } catch (error) {
        console.error('Update collection error:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to update collection',
        };
    }
}

export async function deleteCollection(workId: string, collectionId: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await workAPI.deleteCollection(workId, collectionId);

        if (response.status === 'success') {
            revalidatePath(`/works/${workId}/items`);
            revalidatePath(`/works/${workId}`);
            return {
                success: true,
            };
        }

        return {
            success: false,
            error: 'Failed to delete collection',
        };
    } catch (error) {
        console.error('Delete collection error:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to delete collection',
        };
    }
}
