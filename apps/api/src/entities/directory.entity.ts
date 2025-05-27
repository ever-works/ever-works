import { randomUUID } from 'node:crypto';

const directories = new Map<string, Directory>();

export class Directory {
    id: string;
    name: string;
    slug: string;
    owner: string;
    companyName: string;
    organization: boolean;
    description: string;

    constructor() {
        this.id = randomUUID();
    }

    static createMock(directory: Directory) {
        if (!directory.owner) {
            throw new Error('Owner is required');
        }

        directories.set(directory.slug, directory);
    }

    static async findMock(slug: string) {
        return directories.get(slug);
    }

    getDataRepo() {
        return `${this.slug}-data`;
    }

    getWebsiteRepo() {
        return `${this.slug}-website`;
    }
}
