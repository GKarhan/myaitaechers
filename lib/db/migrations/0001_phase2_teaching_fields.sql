ALTER TABLE "lessons" ADD COLUMN "mapping_metadata" jsonb;--> statement-breakpoint
ALTER TABLE "lesson_nodes" ADD COLUMN "explanation_steps" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "lesson_nodes" ADD COLUMN "beginner_explanation" text;--> statement-breakpoint
ALTER TABLE "lesson_nodes" ADD COLUMN "advanced_explanation" text;--> statement-breakpoint
ALTER TABLE "lesson_nodes" ADD COLUMN "analogy" text;--> statement-breakpoint
ALTER TABLE "lesson_nodes" ADD COLUMN "visual_reference_note" text;--> statement-breakpoint
ALTER TABLE "lesson_nodes" ADD COLUMN "common_errors" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "lesson_nodes" ADD COLUMN "misconception_questions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "lesson_nodes" ADD COLUMN "recall_questions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "lesson_nodes" ADD COLUMN "understanding_questions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "lesson_nodes" ADD COLUMN "application_questions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "lesson_nodes" ADD COLUMN "faq_entries" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "lesson_nodes" ADD COLUMN "content_source_type" text DEFAULT 'textbook' NOT NULL;--> statement-breakpoint
ALTER TABLE "lesson_nodes" ADD COLUMN "teaching_content_confidence" integer;