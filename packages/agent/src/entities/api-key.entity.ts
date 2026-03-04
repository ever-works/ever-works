import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    ManyToOne,
    CreateDateColumn,
    Index,
} from 'typeorm';
import { User } from './user.entity';
import type { ClassToObject } from './types';

@Entity({ name: 'api_keys' })
@Index(['hashedKey'], { unique: true })
@Index(['userId'])
export class ApiKey {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    userId: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    user: ClassToObject<User>;

    @Column({ length: 100 })
    name: string;

    @Column({ unique: true })
    hashedKey: string;

    @Column({ length: 12 })
    prefix: string;

    @Column({ type: 'datetime', nullable: true })
    expiresAt: Date | null;

    @Column({ type: 'datetime', nullable: true })
    lastUsedAt: Date | null;

    @Column({ default: true })
    isActive: boolean;

    @CreateDateColumn()
    createdAt: Date;
}
