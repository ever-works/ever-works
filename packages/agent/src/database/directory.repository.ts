import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Directory } from '../entities/directory.entity';

@Injectable()
export class DirectoryRepository {
	constructor(
		@InjectRepository(Directory)
		private readonly repository: Repository<Directory>
	) {}

	async create(directoryData: Partial<Directory>): Promise<Directory> {
		if (!directoryData.owner) {
			throw new Error('Owner is required');
		}

		const directory = this.repository.create(directoryData);
		return await this.repository.save(directory);
	}

	async findBySlug(slug: string): Promise<Directory | null> {
		return await this.repository.findOne({ where: { slug } });
	}

	async findByOwnerAndSlug(owner: string, slug: string): Promise<Directory | null> {
		return await this.repository.findOne({ where: { owner, slug } });
	}

	async findById(id: number): Promise<Directory | null> {
		return await this.repository.findOne({ where: { id } });
	}

	async findAll(): Promise<Directory[]> {
		return await this.repository.find();
	}

	async update(id: number, updateData: Partial<Directory>): Promise<Directory | null> {
		await this.repository.update(id, updateData);
		return await this.findById(id);
	}

	async delete(id: number): Promise<boolean> {
		const result = await this.repository.delete(id);
		return result.affected > 0;
	}

	async deleteBySlug(slug: string): Promise<boolean> {
		const result = await this.repository.delete({ slug });
		return result.affected > 0;
	}

	async exists(slug: string): Promise<boolean> {
		const count = await this.repository.count({ where: { slug } });
		return count > 0;
	}

	async existsByOwnerAndSlug(owner: string, slug: string): Promise<boolean> {
		const count = await this.repository.count({ where: { owner, slug } });
		return count > 0;
	}

	async findByOwner(owner: string): Promise<Directory[]> {
		return await this.repository.find({ where: { owner } });
	}
}
