CREATE TABLE "characters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"circle_id" uuid NOT NULL,
	"name" text NOT NULL,
	"level" integer NOT NULL,
	"abilities" jsonb NOT NULL,
	"proficiency_bonus" integer,
	"skill_proficiencies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"save_proficiencies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_hp" integer,
	"ac" integer,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "characters" ADD CONSTRAINT "characters_circle_id_circles_id_fk" FOREIGN KEY ("circle_id") REFERENCES "public"."circles"("id") ON DELETE cascade ON UPDATE no action;