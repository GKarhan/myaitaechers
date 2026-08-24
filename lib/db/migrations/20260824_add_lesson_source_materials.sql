CREATE TABLE IF NOT EXISTS "lesson_source_materials" (
  "id" serial PRIMARY KEY NOT NULL,
  "lesson_id" integer NOT NULL REFERENCES "lessons"("id") ON DELETE CASCADE,
  "source_resource_id" integer REFERENCES "resources"("id") ON DELETE SET NULL,
  "stable_source_key" text NOT NULL,
  "source_block_index" integer NOT NULL,
  "block_type" text NOT NULL,
  "source_text" text NOT NULL,
  "physical_page" integer NOT NULL,
  "source_paragraph" text,
  "source_bounding_box" jsonb,
  "verification_status" text NOT NULL,
  "primary_disposition" text NOT NULL,
  "disposition_reason_codes" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "provenance_metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "lesson_source_materials_lesson_stable_key_uidx"
  ON "lesson_source_materials" ("lesson_id", "stable_source_key");

CREATE INDEX IF NOT EXISTS "lesson_source_materials_lesson_idx"
  ON "lesson_source_materials" ("lesson_id");