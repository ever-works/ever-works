import { randomUUID } from 'crypto';
import { slugifyText } from 'src/items-generator/utils/text.utils';

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

    static async createMock(directory: Directory) {
        if (!directory.owner) {
            throw new Error('Owner is required');
        }

        directories.set(directory.slug, directory);
    }

    static async findMock(slug: string) {
        return directories.get(slug);
    }

    getRepoFullName() {
        if (!this.owner || !this.slug) {
            throw new Error('Owner and slug are required');
        }

        return slugifyText(`${this.owner}/${this.slug}`);
    }

    getDataRepo() {
        return `${this.slug}-data`;
    }

    getWebsiteRepo() {
        return `${this.slug}-website`;
    }
}
