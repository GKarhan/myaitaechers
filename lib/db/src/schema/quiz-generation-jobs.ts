import {
  pgTable,
  serial,
  integer,
  text,
  jsonb,
  timestamp,
  unique,
  index,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { quizzesTable } from "./quizzes";

export const quizGenerationJobsTable = pgTable(
  "quiz_generation_jobs",
  {
    id: serial("id").primaryKey(),
    teacherId: integer("teacher_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    requestSnapshot: jsonb("request_snapshot").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    status: text("status").notNull().default("pending"),
    progress: text("progress"),
    claimToken: text("claim_token"),
    attemptCount: integer("attempt_count").notNull().default(0),
    quizId: integer("quiz_id").references(() => quizzesTable.id, { onDelete: "set null" }),
    errorCode: text("error_code"),
    errorDetails: jsonb("error_details"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("quiz_generation_jobs_teacher_key_uq").on(table.teacherId, table.idempotencyKey),
    index("quiz_generation_jobs_status_idx").on(table.status, table.updatedAt),
  ],
);

export type QuizGenerationJob = typeof quizGenerationJobsTable.$inferSelect;
export type NewQuizGenerationJob = typeof quizGenerationJobsTable.$inferInsert;