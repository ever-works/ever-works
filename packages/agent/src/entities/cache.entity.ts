import { Entity, Column, PrimaryColumn, Index, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity({ name: 'cache_entries' })
export class CacheEntry {
    @PrimaryColumn()
    key: string;

    @Column('text')
    value: string;

    @Column({ type: 'bigint', nullable: true })
    @Index()
    expiresAt: number | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
