CREATE TYPE "public"."user_role" AS ENUM('student', 'teacher', 'admin');--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"full_name" text NOT NULL,
	"role" "user_role" DEFAULT 'student' NOT NULL,
	"email" text,
	"age" integer,
	"bio" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "student_progress" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"subject" text NOT NULL,
	"lesson" text NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subjects" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"grade" text DEFAULT '9-րդ դասարան' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subjects_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "knowledge_topics" (
	"id" serial PRIMARY KEY NOT NULL,
	"subject_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"topic_name" text NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'not_started' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teachers" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"subjects" text[] DEFAULT '{}' NOT NULL,
	"school" text DEFAULT '' NOT NULL,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teachers_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "classes" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"grade" text DEFAULT '' NOT NULL,
	"teacher_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "class_students" (
	"class_id" integer NOT NULL,
	"student_id" integer NOT NULL,
	CONSTRAINT "class_students_class_id_student_id_pk" PRIMARY KEY("class_id","student_id")
);
--> statement-breakpoint
CREATE TABLE "schedule" (
	"id" serial PRIMARY KEY NOT NULL,
	"class_id" integer NOT NULL,
	"day" text NOT NULL,
	"time" text DEFAULT '' NOT NULL,
	"start_time" text DEFAULT '' NOT NULL,
	"end_time" text DEFAULT '' NOT NULL,
	"subject" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lessons" (
	"id" serial PRIMARY KEY NOT NULL,
	"subject_id" integer NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"bloom_level" integer DEFAULT 1 NOT NULL,
	"phases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"teacher_id" integer,
	"class_id" integer,
	"content" text DEFAULT '' NOT NULL,
	"lesson_number" integer,
	"pages_from" integer,
	"pages_to" integer,
	"month" integer,
	"day" integer,
	"course_id" integer,
	"textbook_author" text,
	"textbook_title" text,
	"chapter_title" text,
	"paragraph_number" text,
	"textbook_resource_id" integer,
	"lesson_goal" text,
	"lesson_outcomes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"core_idea" text,
	"core_problem" text,
	"essential_question" text,
	"practical_tasks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"knowledge_boundaries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"assigned_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"lesson_id" integer,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lesson_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"lesson_id" integer NOT NULL,
	"current_phase" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"mastery_score" integer,
	"current_node_id" integer,
	"node_started_at" timestamp with time zone,
	"node_attempt_count" integer DEFAULT 0 NOT NULL,
	"last_question_asked" text,
	"asked_question_templates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"review_question_count" integer DEFAULT 0 NOT NULL,
	"deep_dive_exercise_index" integer DEFAULT 0 NOT NULL,
	"node_mastery_evidence_count" integer DEFAULT 0 NOT NULL,
	"node_consecutive_correct" integer DEFAULT 0 NOT NULL,
	"node_consecutive_incorrect" integer DEFAULT 0 NOT NULL,
	"node_last_evidence_quality" text,
	"node_teaching_stage" text DEFAULT 'THEORY' NOT NULL,
	"phase1_consecutive_correct" integer DEFAULT 0 NOT NULL,
	"intro_confirmed" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "books" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"subject_id" integer,
	"name" text NOT NULL,
	"file_path" text NOT NULL,
	"file_size" bigint DEFAULT 0 NOT NULL,
	"mime_type" text DEFAULT 'application/octet-stream' NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "homework" (
	"id" serial PRIMARY KEY NOT NULL,
	"student_id" integer NOT NULL,
	"lesson_id" integer NOT NULL,
	"title" text NOT NULL,
	"task" text NOT NULL,
	"level" text DEFAULT 'medium' NOT NULL,
	"answer" text,
	"file_url" text,
	"score" integer,
	"feedback" text,
	"status" text DEFAULT 'not_submitted' NOT NULL,
	"submitted_at" timestamp with time zone,
	"graded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "class_documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"class_id" integer NOT NULL,
	"teacher_id" integer,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"file_name" text,
	"file_url" text,
	"file_size" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "courses" (
	"id" serial PRIMARY KEY NOT NULL,
	"class_id" integer NOT NULL,
	"teacher_id" integer,
	"subject_id" integer,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resources" (
	"id" serial PRIMARY KEY NOT NULL,
	"course_id" integer NOT NULL,
	"teacher_id" integer,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"file_name" text,
	"file_url" text,
	"file_size" integer,
	"author" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"lesson_session_id" integer,
	"topic_id" integer,
	"event_type" text NOT NULL,
	"was_correct" boolean,
	"response_time_ms" integer,
	"hint_used" boolean DEFAULT false NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_nodes" (
	"id" serial PRIMARY KEY NOT NULL,
	"subject_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"topic_name" text NOT NULL,
	"lesson_node_id" integer,
	"mastery_score" integer,
	"confidence_score" integer,
	"retention_score" integer,
	"bloom_level" integer DEFAULT 1 NOT NULL,
	"is_provisional" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'not_started' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_edges" (
	"id" serial PRIMARY KEY NOT NULL,
	"from_node_id" integer NOT NULL,
	"to_node_id" integer NOT NULL,
	"relation_type" text DEFAULT 'prerequisite' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_schedule" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"topic_id" integer NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"last_reviewed_at" timestamp with time zone,
	"interval_days" integer DEFAULT 1 NOT NULL,
	"review_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teacher_class_subjects" (
	"id" serial PRIMARY KEY NOT NULL,
	"class_id" integer NOT NULL,
	"teacher_id" integer NOT NULL,
	"subject_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teacher_class_subjects_class_id_teacher_id_subject_id_unique" UNIQUE("class_id","teacher_id","subject_id")
);
--> statement-breakpoint
CREATE TABLE "student_profile" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"avg_mastery" integer,
	"mastered_topics_count" integer DEFAULT 0 NOT NULL,
	"weak_topics_count" integer DEFAULT 0 NOT NULL,
	"not_started_topics_count" integer DEFAULT 0 NOT NULL,
	"total_lessons_completed" integer DEFAULT 0 NOT NULL,
	"overall_k" integer,
	"review_queue_summary" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "student_profile_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "lesson_topics" (
	"id" serial PRIMARY KEY NOT NULL,
	"lesson_id" integer NOT NULL,
	"title" text NOT NULL,
	"sequence" integer NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lesson_nodes" (
	"id" serial PRIMARY KEY NOT NULL,
	"lesson_id" integer NOT NULL,
	"topic_id" integer,
	"sequence" integer NOT NULL,
	"title" text NOT NULL,
	"theory_content" text,
	"target_bloom_level" integer DEFAULT 1 NOT NULL,
	"estimated_minutes" integer DEFAULT 5 NOT NULL,
	"child_friendly_explanation" text,
	"basic_examples" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"real_life_examples" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"common_misconception" text,
	"prerequisite_nodes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mastery_evidence_count" integer DEFAULT 0 NOT NULL,
	"last_evidence_quality" text,
	"consecutive_correct" integer DEFAULT 0 NOT NULL,
	"consecutive_incorrect" integer DEFAULT 0 NOT NULL,
	"verbatim_theory_anchor" text,
	"non_examples" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"teaching_stage" text DEFAULT 'THEORY' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"learning_objective" text,
	"micro_node_type" text,
	"source_text" text,
	"source_page" integer,
	"source_paragraph" text,
	"source_bounding_box" jsonb,
	"block_type" text,
	"confidence_score" integer,
	"created_by" text DEFAULT 'ai',
	"reviewed_by" integer,
	"status" text DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_to" timestamp with time zone,
	"change_reason" text
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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_type" text DEFAULT 'textbook' NOT NULL,
	"source_text" text,
	"confidence_score" integer,
	"status" text DEFAULT 'draft' NOT NULL
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
ALTER TABLE "student_progress" ADD CONSTRAINT "student_progress_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_topics" ADD CONSTRAINT "knowledge_topics_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_topics" ADD CONSTRAINT "knowledge_topics_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teachers" ADD CONSTRAINT "teachers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classes" ADD CONSTRAINT "classes_teacher_id_teachers_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."teachers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_students" ADD CONSTRAINT "class_students_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_students" ADD CONSTRAINT "class_students_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_teacher_id_users_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_textbook_resource_id_resources_id_fk" FOREIGN KEY ("textbook_resource_id") REFERENCES "public"."resources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_sessions" ADD CONSTRAINT "lesson_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_sessions" ADD CONSTRAINT "lesson_sessions_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_sessions" ADD CONSTRAINT "lesson_sessions_current_node_id_lesson_nodes_id_fk" FOREIGN KEY ("current_node_id") REFERENCES "public"."lesson_nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "books" ADD CONSTRAINT "books_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "books" ADD CONSTRAINT "books_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "homework" ADD CONSTRAINT "homework_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "homework" ADD CONSTRAINT "homework_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_documents" ADD CONSTRAINT "class_documents_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_documents" ADD CONSTRAINT "class_documents_teacher_id_users_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courses" ADD CONSTRAINT "courses_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courses" ADD CONSTRAINT "courses_teacher_id_users_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courses" ADD CONSTRAINT "courses_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_teacher_id_users_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_events" ADD CONSTRAINT "evidence_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_events" ADD CONSTRAINT "evidence_events_lesson_session_id_lesson_sessions_id_fk" FOREIGN KEY ("lesson_session_id") REFERENCES "public"."lesson_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_events" ADD CONSTRAINT "evidence_events_topic_id_knowledge_nodes_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."knowledge_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_nodes" ADD CONSTRAINT "knowledge_nodes_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_nodes" ADD CONSTRAINT "knowledge_nodes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_nodes" ADD CONSTRAINT "knowledge_nodes_lesson_node_id_lesson_nodes_id_fk" FOREIGN KEY ("lesson_node_id") REFERENCES "public"."lesson_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_edges" ADD CONSTRAINT "knowledge_edges_from_node_id_knowledge_nodes_id_fk" FOREIGN KEY ("from_node_id") REFERENCES "public"."knowledge_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_edges" ADD CONSTRAINT "knowledge_edges_to_node_id_knowledge_nodes_id_fk" FOREIGN KEY ("to_node_id") REFERENCES "public"."knowledge_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_schedule" ADD CONSTRAINT "review_schedule_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_schedule" ADD CONSTRAINT "review_schedule_topic_id_knowledge_nodes_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."knowledge_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teacher_class_subjects" ADD CONSTRAINT "teacher_class_subjects_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teacher_class_subjects" ADD CONSTRAINT "teacher_class_subjects_teacher_id_teachers_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."teachers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teacher_class_subjects" ADD CONSTRAINT "teacher_class_subjects_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_profile" ADD CONSTRAINT "student_profile_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_topics" ADD CONSTRAINT "lesson_topics_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_nodes" ADD CONSTRAINT "lesson_nodes_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_nodes" ADD CONSTRAINT "lesson_nodes_topic_id_lesson_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."lesson_topics"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_nodes" ADD CONSTRAINT "lesson_nodes_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_exercises" ADD CONSTRAINT "lesson_exercises_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_exercises" ADD CONSTRAINT "lesson_exercises_related_node_id_lesson_nodes_id_fk" FOREIGN KEY ("related_node_id") REFERENCES "public"."lesson_nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_node_dependencies" ADD CONSTRAINT "lesson_node_dependencies_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_node_dependencies" ADD CONSTRAINT "lesson_node_dependencies_from_node_id_lesson_nodes_id_fk" FOREIGN KEY ("from_node_id") REFERENCES "public"."lesson_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_node_dependencies" ADD CONSTRAINT "lesson_node_dependencies_to_node_id_lesson_nodes_id_fk" FOREIGN KEY ("to_node_id") REFERENCES "public"."lesson_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
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
CREATE UNIQUE INDEX "knowledge_nodes_user_lesson_node_uidx" ON "knowledge_nodes" USING btree ("user_id","lesson_node_id");