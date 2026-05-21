export interface KbTagDto {
	id: string;
	workId: string;
	slug: string;
	name: string;
	color: string | null;
	description: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface CreateKbTagInput {
	slug: string;
	name: string;
	color?: string | null;
	description?: string | null;
}

export interface UpdateKbTagInput {
	name?: string;
	color?: string | null;
	description?: string | null;
}
