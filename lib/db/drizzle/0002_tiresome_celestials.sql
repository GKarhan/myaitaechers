CREATE TABLE "quiz_answers" (
	"id" serial PRIMARY KEY NOT NULL,
	"attempt_id" integer NOT NULL,
	"question_id" integer NOT NULL,
	"node_id" integer,
	"selected_option_index" integer NOT NULL,
	"is_correct" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quiz_assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"quiz_id" integer NOT NULL,
	"student_id" integer NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone,
	"status" text DEFAULT 'ASSIGNED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quiz_attempts" (
	"id" serial PRIMARY KEY NOT NULL,
	"quiz_assignment_id" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"total_correct" integer DEFAULT 0 NOT NULL,
	"total_questions" integer DEFAULT 0 NOT NULL,
	"score_percent" integer,
	CONSTRAINT "quiz_attempts_quiz_assignment_id_unique" UNIQUE("quiz_assignment_id")
);
--> statement-breakpoint
CREATE TABLE "quiz_questions" (
	"id" serial PRIMARY KEY NOT NULL,
	"quiz_id" integer NOT NULL,
	"node_id" integer,
	"question_text" text NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"correct_option_index" integer DEFAULT 0 NOT NULL,
	"difficulty_level" text DEFAULT 'MEDIUM' NOT NULL,
	"sequence" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quizzes" (
	"id" serial PRIMARY KEY NOT NULL,
	"teacher_id" integer NOT NULL,
	"subject_id" integer NOT NULL,
	"class_id" integer,
	"source_book_id" integer,
	"node_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"title" text NOT NULL,
	"question_count" integer DEFAULT 10 NOT NULL,
	"difficulty_mode" text DEFAULT 'MIXED' NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lesson_sessions" ADD COLUMN "node_mastery_evidence_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "lesson_sessions" ADD COLUMN "node_consecutive_correct" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "lesson_sessions" ADD COLUMN "node_consecutive_incorrect" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "lesson_sessions" ADD COLUMN "node_last_evidence_quality" text;--> statement-breakpoint
ALTER TABLE "lesson_sessions" ADD COLUMN "node_teaching_stage" text DEFAULT 'THEORY' NOT NULL;--> statement-breakpoint
ALTER TABLE "lesson_sessions" ADD COLUMN "phase1_consecutive_correct" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "lesson_sessions" ADD COLUMN "intro_confirmed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_nodes" ADD COLUMN "lesson_node_id" integer;--> statement-breakpoint
ALTER TABLE "lesson_nodes" ADD COLUMN "learning_objective" text;--> statement-breakpoint
ALTER TABLE "lesson_nodes" ADD COLUMN "micro_node_type" text;--> statement-breakpoint
ALTER TABLE "lesson_nodes" ADD COLUMN "source_text" text;--> statement-breakpoint
ALTER TABLE "lesson_nodes" ADD COLUMN "source_page" integer;--> statement-breakpoint
ALTER TABLE "lesson_nodes" ADD COLUMN "source_paragraph" text;--> statement-breakpoint
ALTER TABLE "lesson_nodes" ADD COLUMN "source_bounding_box" jsonb;--> statement-breakpoint
ALTER TABLE "lesson_nodes" ADD COLUMN "block_type" text;--> statement-breakpoint
ALTER TABLE "lesson_nodes" ADD COLUMN "confidence_score" integer;--> statement-breakpoint
ALTER TABLE "lesson_nodes" ADD COLUMN "created_by" text DEFAULT 'ai';--> statement-breakpoint
ALTER TABLE "lesson_nodes" ADD COLUMN "reviewed_by" integer;--> statement-breakpoint
ALTER TABLE "lesson_nodes" ADD COLUMN "status" text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "lesson_nodes" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "lesson_nodes" ADD COLUMN "valid_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lesson_nodes" ADD COLUMN "valid_to" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lesson_nodes" ADD COLUMN "change_reason" text;--> statement-breakpoint
ALTER TABLE "lesson_exercises" ADD COLUMN "source_type" text DEFAULT 'textbook' NOT NULL;--> statement-breakpoint
ALTER TABLE "lesson_exercises" ADD COLUMN "source_text" text;--> statement-breakpoint
ALTER TABLE "lesson_exercises" ADD COLUMN "confidence_score" integer;--> statement-breakpoint
ALTER TABLE "lesson_exercises" ADD COLUMN "status" text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "quiz_answers" ADD CONSTRAINT "quiz_answers_attempt_id_quiz_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."quiz_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_answers" ADD CONSTRAINT "quiz_answers_question_id_quiz_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."quiz_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_assignments" ADD CONSTRAINT "quiz_assignments_quiz_id_quizzes_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "public"."quizzes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_assignments" ADD CONSTRAINT "quiz_assignments_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_quiz_assignment_id_quiz_assignments_id_fk" FOREIGN KEY ("quiz_assignment_id") REFERENCES "public"."quiz_assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_questions" ADD CONSTRAINT "quiz_questions_quiz_id_quizzes_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "public"."quizzes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_questions" ADD CONSTRAINT "quiz_questions_node_id_lesson_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."lesson_nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_teacher_id_users_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_source_book_id_books_id_fk" FOREIGN KEY ("source_book_id") REFERENCES "public"."books"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_nodes" ADD CONSTRAINT "knowledge_nodes_lesson_node_id_lesson_nodes_id_fk" FOREIGN KEY ("lesson_node_id") REFERENCES "public"."lesson_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_nodes" ADD CONSTRAINT "lesson_nodes_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_nodes_user_lesson_node_uidx" ON "knowledge_nodes" USING btree ("user_id","lesson_node_id");