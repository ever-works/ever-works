import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    OneToOne,
    ManyToOne,
    OneToMany,
    CreateDateColumn,
    UpdateDateColumn,
    JoinColumn,
    Index,
} from 'typeorm';
import type { ClassToObject, DirectoryScheduleCadence, ProvidersDto } from './types';
import { Directory } from './directory.entity';
import { User } from './user.entity';
import { DirectoryScheduleBillingMode, DirectoryScheduleStatus, GenerateStatusType } from './types';
import { TimestampColumn } from './_types';
import { UsageLedgerEntry } from './usage-ledger-entry.entity';

@Index(['status', 'nextRunAt'])
@Index(['userId', 'status'])
@Index(['directoryId'], { unique: true })
@Entity({ name: 'directory_schedules' })
export class DirectorySchedule {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ unique: true })
    directoryId: string;

    @OneToOne(() => Directory, (directory) => directory.schedule, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'directoryId' })
    directory: ClassToObject<Directory>;

    @Column()
    userId: string;

    @ManyToOne(() => User, (user) => user.directorySchedules, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user: ClassToObject<User>;

    @Column({ type: 'varchar', nullable: true })
    cadence?: DirectoryScheduleCadence | null;

    @Column({ type: 'varchar', nullable: true })
    sourceValidationCadence?: DirectoryScheduleCadence | null;

    @Column({ type: 'varchar', default: DirectoryScheduleStatus.DISABLED })
    status: DirectoryScheduleStatus;

    @Column({ type: 'varchar', default: DirectoryScheduleBillingMode.SUBSCRIPTION })
    billingMode: DirectoryScheduleBillingMode;

    @TimestampColumn({ nullable: true })
    nextRunAt?: Date | null;

    @TimestampColumn({ nullable: true })
    sourceValidationNextRunAt?: Date | null;

    @TimestampColumn({ nullable: true })
    sourceValidationLastRunAt?: Date | null;

    @TimestampColumn({ nullable: true })
    lastRunAt?: Date | null;

    @Column({ type: 'varchar', nullable: true })
    lastRunStatus?: GenerateStatusType | null;

    @Column({ type: 'int', default: 0 })
    failureCount: number;

    @Column({ type: 'int', default: 3 })
    maxFailureBeforePause: number;

    @Column({ type: 'boolean', default: false })
    alwaysCreatePullRequest: boolean;

    @Column({ type: 'simple-json', nullable: true })
    providerOverrides?: ProvidersDto | null;

    @OneToMany(() => UsageLedgerEntry, (entry) => entry.schedule)
    ledgerEntries?: ClassToObject<UsageLedgerEntry>[] | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
