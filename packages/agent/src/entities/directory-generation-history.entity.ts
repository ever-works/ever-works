import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    ManyToOne,
    CreateDateColumn,
    UpdateDateColumn,
} from 'typeorm';
import { Directory } from './directory.entity';
import { User } from './user.entity';
import { ClassToObject } from './types';
import { GenerationMethod } from '@src/items-generator/dto/create-items-generator.dto';
import { GenerateStatusType } from './types';
import { TimestampColumn } from './_types';

export type GenerationMetrics = {
    urls_scanned?: number;
    pages_processed?: number;
    items_extracted_current_run?: number;
    new_items_added_to_store?: number;
    total_items_in_store?: number;
};

@Entity({ name: 'directory_generation_history' })
export class DirectoryGenerationHistory {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    directoryId: string;

    @ManyToOne(() => Directory, (directory) => directory.generationHistory, {
        onDelete: 'CASCADE',
    })
    directory: ClassToObject<Directory>;

    @Column({ nullable: true })
    userId?: string | null;

    @ManyToOne(() => User, (user) => user.generationHistory, {
        nullable: true,
        onDelete: 'SET NULL',
    })
    user?: ClassToObject<User> | null;

    @Column({ type: 'varchar', nullable: true })
    generationMethod?: GenerationMethod | null;

    @Column({ type: 'varchar', default: GenerateStatusType.GENERATING })
    status: GenerateStatusType;

    @Column({ type: 'json', nullable: true })
    parameters?: Record<string, any> | null;

    @Column({ type: 'json', nullable: true })
    metrics?: GenerationMetrics | null;

    @Column({ type: 'int', default: 0 })
    newItemsCount: number;

    @Column({ type: 'int', default: 0 })
    updatedItemsCount: number;

    @Column({ type: 'int', default: 0 })
    totalItemsCount: number;

    @TimestampColumn({ nullable: true })
    startedAt?: Date | null;

    @TimestampColumn({ nullable: true })
    finishedAt?: Date | null;

    @Column({ type: 'int', nullable: true })
    durationInSeconds?: number | null;

    @Column({ type: 'text', nullable: true })
    errorMessage?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
