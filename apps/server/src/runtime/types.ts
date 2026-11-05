import type { InferSelectModel } from 'drizzle-orm';
import { agent, run, task } from '../db/schema.js';

export type AgentRow = InferSelectModel<typeof agent>;
export type TaskRow = InferSelectModel<typeof task>;
export type RunRow = InferSelectModel<typeof run>;
