CREATE TABLE "teacher_class_subjects" (
	"id" serial PRIMARY KEY NOT NULL,
	"class_id" integer NOT NULL,
	"teacher_id" integer NOT NULL,
	"subject_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teacher_class_subjects_class_id_teacher_id_subject_id_unique" UNIQUE("class_id","teacher_id","subject_id")
);
--> statement-breakpoint
CREATE TABLE "lesson_exercises" (
	"id" serial PRIMARY KEY NOT NULL,
	"lesson_id" integer NOT NULL,
	"exercise_id" text NOT NULL,
	"source_page" text,
	"exercise_text_verbatim" text NOT NULL,
	"exercise_purpose" text,
	"related_node_id" integer,
	"success_criteria" text,
	"difficulty_level" text,
	"assignment" text,
	"sequence" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lesson_node_dependencies" (
	"id" serial PRIMARY KEY NOT NULL,
	"lesson_id" integer NOT NULL,
	"from_node_id" integer NOT NULL,
	"to_node_id" integer NOT NULL,
	"dependency_type" text DEFAULT 'SEQUENTIAL' NOT NULL,
	"required_level" text DEFAULT 'SUPPORTING' NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "evidence_events" DROP CONSTRAINT "evidence_events_topic_id_knowledge_topics_id_fk";
--> statement-breakpoint
ALTER TABLE "lessons" ADD COLUMN "essential_question" text;--> statement-breakpoint
ALTER TABLE "lessons" ADD COLUMN "knowledge_boundaries" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "lesson_sessions" ADD COLUMN "node_attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "lesson_sessions" ADD COLUMN "last_question_asked" text;--> statement-breakpoint
ALTER TABLE "lesson_sessions" ADD COLUMN "asked_question_templates" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "lesson_sessions" ADD COLUMN "review_question_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "lesson_sessions" ADD COLUMN "deep_dive_exercise_index" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "courses" ADD COLUMN "subject_id" integer;--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN "author" text;--> statement-breakpoint
ALTER TABLE "lesson_nodes" ADD COLUMN "mastery_evidence_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "lesson_nodes" ADD COLUMN "last_evidence_quality" text;--> statement-breakpoint
ALTER TABLE "lesson_nodes" ADD COLUMN "consecutive_correct" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "lesson_nodes" ADD COLUMN "consecutive_incorrect" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "lesson_nodes" ADD COLUMN "verbatim_theory_anchor" text;--> statement-breakpoint
ALTER TABLE "lesson_nodes" ADD COLUMN "non_examples" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "lesson_nodes" ADD COLUMN "teaching_stage" text DEFAULT 'THEORY' NOT NULL;--> statement-breakpoint
ALTER TABLE "teacher_class_subjects" ADD CONSTRAINT "teacher_class_subjects_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teacher_class_subjects" ADD CONSTRAINT "teacher_class_subjects_teacher_id_teachers_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."teachers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teacher_class_subjects" ADD CONSTRAINT "teacher_class_subjects_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_exercises" ADD CONSTRAINT "lesson_exercises_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_exercises" ADD CONSTRAINT "lesson_exercises_related_node_id_lesson_nodes_id_fk" FOREIGN KEY ("related_node_id") REFERENCES "public"."lesson_nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_node_dependencies" ADD CONSTRAINT "lesson_node_dependencies_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_node_dependencies" ADD CONSTRAINT "lesson_node_dependencies_from_node_id_lesson_nodes_id_fk" FOREIGN KEY ("from_node_id") REFERENCES "public"."lesson_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_node_dependencies" ADD CONSTRAINT "lesson_node_dependencies_to_node_id_lesson_nodes_id_fk" FOREIGN KEY ("to_node_id") REFERENCES "public"."lesson_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courses" ADD CONSTRAINT "courses_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_events" ADD CONSTRAINT "evidence_events_topic_id_knowledge_nodes_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."knowledge_nodes"("id") ON DELETE cascade ON UPDATE no action;