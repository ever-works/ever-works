import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DirectoryRepository } from '@src/database/repositories/directory.repository';
import { Directory } from '@src/entities/directory.entity';

@Injectable()
export class DirectoryOwnershipService {
    constructor(private readonly directoryRepository: DirectoryRepository) {}

    async ensure(directoryId: string, userId: string): Promise<Directory> {
        const directory = await this.directoryRepository.findById(directoryId);

        if (!directory) {
            throw new NotFoundException({
                status: 'error',
                message: `Directory with id '${directoryId}' not found`,
            });
        }

        if (directory.userId !== userId) {
            throw new BadRequestException({
                status: 'error',
                message: 'You do not have permission to access this directory',
            });
        }

        return directory;
    }
}
