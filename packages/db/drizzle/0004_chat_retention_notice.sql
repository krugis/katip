CREATE TABLE "chat_retention_notice_recipients" (
	"notice_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_retention_notice_recipients_notice_id_user_id_pk" PRIMARY KEY("notice_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "chat_retention_state" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"in_force_months" integer,
	"notice_id" uuid,
	"notice_months" integer,
	"notice_requested_at" timestamp with time zone,
	"notified_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_retention_state_in_force" CHECK ("chat_retention_state"."in_force_months" between 1 and 120),
	CONSTRAINT "chat_retention_state_notice_months" CHECK ("chat_retention_state"."notice_months" between 1 and 120),
	CONSTRAINT "chat_retention_state_notice" CHECK (("chat_retention_state"."notice_id" is null) = ("chat_retention_state"."notice_months" is null)
        and ("chat_retention_state"."notice_id" is null) = ("chat_retention_state"."notice_requested_at" is null)
        and ("chat_retention_state"."notified_at" is null or "chat_retention_state"."notice_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "chat_retention_notice_recipients" ADD CONSTRAINT "chat_retention_notice_recipients_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_retention_notice_recipients" ADD CONSTRAINT "chat_retention_notice_recipients_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_retention_state" ADD CONSTRAINT "chat_retention_state_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;