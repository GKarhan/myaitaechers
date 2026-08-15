-- Migration 0002: Consolidate all changes applied since 0001_phase2_teaching_fields.
-- All of these were applied to the database before Drizzle tracked them.
-- This file records them in a single tracked migration so Drizzle's snapshot
-- history accurately reflects the schema going forward.
--
-- Includes (in application order):
--   A) quiz_lesson_links, mapping tables
--   B) lesson_nodes.source_block_indices
--   C) lesson_exercises.source_block_index, exercise_text_edited
--   D) quiz_questions.option_explanations, quizzes.quiz_type
--   E) lessons.ever_approved
--   F) lesson_node_cognitive_levels (Phase 2A R2)
--   G) lesson_node_cognitive_tasks (Phase 2A R2)
--   H) evidence_events cognitive readiness columns (Phase 2A R2)
--   I) Ceiling partial unique index (at-most-one isTargetCeiling per MicroNode)
--
-- All DDL uses IF NOT EXISTS / idempotent DO blocks so re-running on a database
-- that already has these objects is safe.

-- ── A) Standalone tables ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "quiz_lesson_links" (
  "id" serial PRIMARY KEY NOT NULL,
  "quiz_id" integer NOT NULL,
  "lesson_id" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "quiz_lesson_links_quiz_id_lesson_id_unique" UNIQUE("quiz_id","lesson_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mapping_jobs" (
  "id" serial PRIMARY KEY NOT NULL,
  "lesson_id" integer NOT NULL,
  "job_type" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "progress" text,
  "result" jsonb,
  "error" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mapping_import_log" (
  "id" serial PRIMARY KEY NOT NULL,
  "lesson_id" integer NOT NULL,
  "source" text NOT NULL,
  "mapping_mode" text NOT NULL,
  "raw_text_hash" text NOT NULL,
  "raw_input" text,
  "mapping_schema_version" text DEFAULT '1.0' NOT NULL,
  "imported_at" timestamp with time zone DEFAULT now() NOT NULL,
  "imported_by" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mapping_review_items" (
  "id" serial PRIMARY KEY NOT NULL,
  "lesson_id" integer NOT NULL,
  "entity_id" integer,
  "entity_type" text,
  "issue_type" text NOT NULL,
  "severity" text NOT NULL,
  "description" text NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- ── B) lesson_nodes additions ─────────────────────────────────────────────────

ALTER TABLE "lesson_nodes" ADD COLUMN IF NOT EXISTS "source_block_indices" jsonb;
--> statement-breakpoint

-- ── C) lesson_exercises additions ────────────────────────────────────────────

ALTER TABLE "lesson_exercises" ADD COLUMN IF NOT EXISTS "source_block_index" integer;
--> statement-breakpoint
ALTER TABLE "lesson_exercises" ADD COLUMN IF NOT EXISTS "exercise_text_edited" text;
--> statement-breakpoint

-- ── D) quiz schema additions ──────────────────────────────────────────────────

ALTER TABLE "quiz_questions" ADD COLUMN IF NOT EXISTS "option_explanations" text[];
--> statement-breakpoint
ALTER TABLE "quizzes" ADD COLUMN IF NOT EXISTS "quiz_type" text;
--> statement-breakpoint

-- ── E) lessons additions ──────────────────────────────────────────────────────

ALTER TABLE "lessons" ADD COLUMN IF NOT EXISTS "ever_approved" boolean DEFAULT false NOT NULL;
--> statement-breakpoint

-- ── F) lesson_node_cognitive_levels (Phase 2A Round 2) ───────────────────────

CREATE TABLE IF NOT EXISTS "lesson_node_cognitive_levels" (
  "id" serial PRIMARY KEY NOT NULL,
  "lesson_node_id" integer NOT NULL,
  "cognitive_level" text NOT NULL,
  "sequence" integer NOT NULL,
  "is_applicable" boolean DEFAULT true NOT NULL,
  "is_target_ceiling" boolean DEFAULT false NOT NULL,
  "performance_objective" text,
  "success_criterion" text,
  "provenance" text DEFAULT 'ai_generated' NOT NULL,
  "minimum_independent_evidence" integer DEFAULT 3 NOT NULL,
  "preferred_interaction_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- ── G) lesson_node_cognitive_tasks (Phase 2A Round 2) ────────────────────────

CREATE TABLE IF NOT EXISTS "lesson_node_cognitive_tasks" (
  "id" serial PRIMARY KEY NOT NULL,
  "cognitive_level_id" integer NOT NULL,
  "lesson_exercise_id" integer,
  "task_provenance" text DEFAULT 'source_derived' NOT NULL,
  "seed_exercise_id" integer,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "lnct_level_exercise_uniq" UNIQUE("cognitive_level_id","lesson_exercise_id")
);
--> statement-breakpoint

-- ── H) evidence_events cognitive readiness columns (Phase 2A Round 2) ────────

ALTER TABLE "evidence_events" ADD COLUMN IF NOT EXISTS "cognitive_level" text;
--> statement-breakpoint
ALTER TABLE "evidence_events" ADD COLUMN IF NOT EXISTS "task_difficulty" text;
--> statement-breakpoint
ALTER TABLE "evidence_events" ADD COLUMN IF NOT EXISTS "assistance_level" text;
--> statement-breakpoint

-- ── I) Indexes and constraints on lesson_node_cognitive_levels ───────────────

-- No duplicate sequences within a MicroNode (unambiguous path ordering)
CREATE UNIQUE INDEX IF NOT EXISTS "lncl_node_sequence_uidx"
  ON "lesson_node_cognitive_levels" USING btree ("lesson_node_id","sequence");
--> statement-breakpoint

-- At-most-one isTargetCeiling=true row per MicroNode
CREATE UNIQUE INDEX IF NOT EXISTS "lncl_ceiling_per_node_uidx"
  ON "lesson_node_cognitive_levels" (lesson_node_id)
  WHERE is_target_ceiling = true;
--> statement-breakpoint

-- Canonical cognitive level values
DO $$ BEGIN
  ALTER TABLE "lesson_node_cognitive_levels"
    ADD CONSTRAINT "lncl_cognitive_level_chk"
    CHECK (cognitive_level IN ('remember','understand','apply','analyze','evaluate','create'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

-- Canonical provenance values
DO $$ BEGIN
  ALTER TABLE "lesson_node_cognitive_levels"
    ADD CONSTRAINT "lncl_provenance_chk"
    CHECK (provenance IN ('source_derived','teacher_authored','ai_generated'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

-- Evidence count lower bound
DO $$ BEGIN
  ALTER TABLE "lesson_node_cognitive_levels"
    ADD CONSTRAINT "lncl_min_evidence_chk"
    CHECK (minimum_independent_evidence >= 1);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

-- ── Foreign keys (idempotent DO blocks) ──────────────────────────────────────

DO $$ BEGIN
  ALTER TABLE "quiz_lesson_links"
    ADD CONSTRAINT "quiz_lesson_links_quiz_id_quizzes_id_fk"
    FOREIGN KEY ("quiz_id") REFERENCES "quizzes"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "quiz_lesson_links"
    ADD CONSTRAINT "quiz_lesson_links_lesson_id_lessons_id_fk"
    FOREIGN KEY ("lesson_id") REFERENCES "lessons"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "mapping_jobs"
    ADD CONSTRAINT "mapping_jobs_lesson_id_lessons_id_fk"
    FOREIGN KEY ("lesson_id") REFERENCES "lessons"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "mapping_import_log"
    ADD CONSTRAINT "mapping_import_log_lesson_id_lessons_id_fk"
    FOREIGN KEY ("lesson_id") REFERENCES "lessons"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "mapping_import_log"
    ADD CONSTRAINT "mapping_import_log_imported_by_users_id_fk"
    FOREIGN KEY ("imported_by") REFERENCES "users"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "mapping_review_items"
    ADD CONSTRAINT "mapping_review_items_lesson_id_lessons_id_fk"
    FOREIGN KEY ("lesson_id") REFERENCES "lessons"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "lesson_node_cognitive_levels"
    ADD CONSTRAINT "lesson_node_cognitive_levels_lesson_node_id_lesson_nodes_id_fk"
    FOREIGN KEY ("lesson_node_id") REFERENCES "lesson_nodes"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "lesson_node_cognitive_tasks"
    ADD CONSTRAINT "lnct_cognitive_level_id_fk"
    FOREIGN KEY ("cognitive_level_id") REFERENCES "lesson_node_cognitive_levels"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "lesson_node_cognitive_tasks"
    ADD CONSTRAINT "lnct_lesson_exercise_id_fk"
    FOREIGN KEY ("lesson_exercise_id") REFERENCES "lesson_exercises"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "lesson_node_cognitive_tasks"
    ADD CONSTRAINT "lnct_seed_exercise_id_fk"
    FOREIGN KEY ("seed_exercise_id") REFERENCES "lesson_exercises"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

-- ── Indexes ───────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS "lncl_node_level_uidx"
  ON "lesson_node_cognitive_levels" USING btree ("lesson_node_id","cognitive_level");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lncl_lesson_node_idx"
  ON "lesson_node_cognitive_levels" USING btree ("lesson_node_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lnct_cognitive_level_idx"
  ON "lesson_node_cognitive_tasks" USING btree ("cognitive_level_id");
