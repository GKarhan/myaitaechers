CREATE TABLE "lesson_topics" (
	"id" serial PRIMARY KEY NOT NULL,
	"lesson_id" integer NOT NULL,
	"title" text NOT NULL,
	"sequence" integer NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lesson_nodes" ADD COLUMN "topic_id" integer;--> statement-breakpoint
ALTER TABLE "lesson_topics" ADD CONSTRAINT "lesson_topics_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_nodes" ADD CONSTRAINT "lesson_nodes_topic_id_lesson_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."lesson_topics"("id") ON DELETE set null ON UPDATE no action;