import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import { Template } from './template.entity';
import { User } from './user.entity';
import { TimestampColumn } from './_types';

export enum TemplateCustomizationStatus {
    PENDING = 'pending',
    FORKING = 'forking',
    CUSTOMIZING = 'customizing',
    PUSHING = 'pushing',
    SUCCEEDED = 'succeeded',
    FAILED = 'failed',
}

@Entity({ name: 'template_customizations' })
@Index(['templateId', 'status', 'createdAt'])
@Index(['userId', 'createdAt'])
export class TemplateCustomization {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'varchar', length: 120 })
    templateId: string;

    @ManyToOne(() => Template, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'templateId' })
    template?: Template;

    @Column()
    userId: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user?: User;

    @Column({ type: 'varchar', length: 120 })
    baseTemplateId: string;

    @Column({ type: 'text' })
    prompt: string;

    @Column({ type: 'varchar', length: 32, default: TemplateCustomizationStatus.PENDING })
    status: TemplateCustomizationStatus;

    @Column({ type: 'varchar', length: 80, nullable: true })
    providerId?: string | null;

    @Column({ type: 'varchar', length: 80, nullable: true })
    aiProviderId?: string | null;

    @Column({ type: 'varchar', length: 255, nullable: true })
    branch?: string | null;

    @Column({ type: 'varchar', length: 80, nullable: true })
    commitSha?: string | null;

    @Column({ type: 'text', nullable: true })
    errorMessage?: string | null;

    @TimestampColumn({ nullable: true })
    startedAt?: Date | null;

    @TimestampColumn({ nullable: true })
    completedAt?: Date | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
