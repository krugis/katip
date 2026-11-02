CREATE EXTENSION IF NOT EXISTS citext;
--> statement-breakpoint
CREATE TABLE "access_rules" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"ip_allowlist" text[] DEFAULT '{}'::text[] NOT NULL,
	"countries" char(2)[] DEFAULT '{}'::char(2)[] NOT NULL,
	"mfa_required" boolean DEFAULT true NOT NULL,
	"session_idle_min" integer DEFAULT 30 NOT NULL,
	"session_max_h" integer DEFAULT 12 NOT NULL,
	"device_trust" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"ip" text,
	"details" jsonb,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"scope_id" text NOT NULL,
	"month" text NOT NULL,
	"threshold" integer NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_alerts_uq" UNIQUE("tenant_id","scope","scope_id","month","threshold")
);
--> statement-breakpoint
CREATE TABLE "department_managers" (
	"tenant_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "department_managers_department_id_user_id_pk" PRIMARY KEY("department_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "departments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"budget_usd_micro" bigint,
	"policy_override" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "departments_tenant_name_uq" UNIQUE("tenant_id","name")
);
--> statement-breakpoint
CREATE TABLE "gateway_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"type" text DEFAULT 'tenant' NOT NULL,
	"user_id" uuid,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"lago_invoice_id" text,
	"number" text NOT NULL,
	"total_usd_micro" bigint NOT NULL,
	"total_try_kurus" bigint NOT NULL,
	"fx_rate" integer NOT NULL,
	"efatura_status" text,
	"efatura_uuid" text,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"tenant_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"payload" jsonb,
	"result" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_catalog" (
	"id" text PRIMARY KEY NOT NULL,
	"litellm_name" text NOT NULL,
	"display_name" text NOT NULL,
	"class" text NOT NULL,
	"provider" text NOT NULL,
	"region" text NOT NULL,
	"data_policy" text NOT NULL,
	"price_in_usd_micro_per_m" bigint NOT NULL,
	"price_out_usd_micro_per_m" bigint NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"code" text NOT NULL,
	"version" integer NOT NULL,
	"price_usd_micro" bigint NOT NULL,
	"monthly_price_usd_micro" bigint NOT NULL,
	"std_tokens" bigint NOT NULL,
	"prem_tokens" bigint NOT NULL,
	"research_runs" integer NOT NULL,
	"files_gb" integer NOT NULL,
	"features" jsonb NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_code_version_uq" UNIQUE("code","version")
);
--> statement-breakpoint
CREATE TABLE "policy_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"policy" jsonb NOT NULL,
	"changed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "privacy_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid,
	"type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"file_url" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "router_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text DEFAULT 'global' NOT NULL,
	"tenant_id" uuid,
	"priority" integer NOT NULL,
	"condition" jsonb NOT NULL,
	"route" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seats" (
	"tenant_id" uuid NOT NULL,
	"plan_code" text NOT NULL,
	"quantity" integer NOT NULL,
	CONSTRAINT "seats_tenant_id_plan_code_pk" PRIMARY KEY("tenant_id","plan_code")
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"billing_cycle" text NOT NULL,
	"status" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"lago_subscription_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_limits" (
	"tenant_id" uuid NOT NULL,
	"month" text NOT NULL,
	"std_tokens" bigint NOT NULL,
	"prem_tokens" bigint NOT NULL,
	"research_runs" integer NOT NULL,
	CONSTRAINT "tenant_limits_tenant_id_month_pk" PRIMARY KEY("tenant_id","month")
);
--> statement-breakpoint
CREATE TABLE "tenant_model_allow" (
	"tenant_id" uuid NOT NULL,
	"model_id" text NOT NULL,
	CONSTRAINT "tenant_model_allow_tenant_id_model_id_pk" PRIMARY KEY("tenant_id","model_id")
);
--> statement-breakpoint
CREATE TABLE "tenant_policies" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"policy" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"region" text DEFAULT 'eu' NOT NULL,
	"kvkk_addon" boolean DEFAULT false NOT NULL,
	"custom_domain" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "usage_daily" (
	"tenant_id" uuid NOT NULL,
	"day" date NOT NULL,
	"user_id" uuid NOT NULL,
	"department_id" uuid,
	"class" text NOT NULL,
	"model_id" text NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_usd_micro" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_daily_tenant_id_day_user_id_class_model_id_pk" PRIMARY KEY("tenant_id","day","user_id","class","model_id")
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"department_id" uuid,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"alias" text NOT NULL,
	"model_id" text NOT NULL,
	"class" text NOT NULL,
	"input_tokens" bigint NOT NULL,
	"cached_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint NOT NULL,
	"cost_usd_micro" bigint NOT NULL,
	"price_usd_micro" bigint NOT NULL,
	"conversation_id" text,
	"source" text NOT NULL,
	"flow_run_id" uuid,
	"fallback" boolean DEFAULT false NOT NULL,
	"overage" boolean DEFAULT false NOT NULL,
	"request_id" text
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"keycloak_id" text NOT NULL,
	"email" "citext" NOT NULL,
	"name" text NOT NULL,
	"department_id" uuid,
	"role" text DEFAULT 'user' NOT NULL,
	"seat_plan_code" text,
	"status" text DEFAULT 'active' NOT NULL,
	"user_cap_usd_micro" bigint,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_keycloak_id_unique" UNIQUE("keycloak_id"),
	CONSTRAINT "users_tenant_email_uq" UNIQUE("tenant_id","email")
);
--> statement-breakpoint
ALTER TABLE "access_rules" ADD CONSTRAINT "access_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_alerts" ADD CONSTRAINT "budget_alerts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department_managers" ADD CONSTRAINT "department_managers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department_managers" ADD CONSTRAINT "department_managers_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_keys" ADD CONSTRAINT "gateway_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_keys" ADD CONSTRAINT "gateway_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_history" ADD CONSTRAINT "policy_history_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "router_rules" ADD CONSTRAINT "router_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seats" ADD CONSTRAINT "seats_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_limits" ADD CONSTRAINT "tenant_limits_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_model_allow" ADD CONSTRAINT "tenant_model_allow_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_model_allow" ADD CONSTRAINT "tenant_model_allow_model_id_model_catalog_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."model_catalog"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_policies" ADD CONSTRAINT "tenant_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_tenant_ts_idx" ON "audit_log" USING btree ("tenant_id","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "dept_managers_tenant_idx" ON "department_managers" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "gateway_keys_tenant_idx" ON "gateway_keys" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "invoices_tenant_idx" ON "invoices" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "jobs_tenant_idx" ON "jobs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "policy_history_tenant_idx" ON "policy_history" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "privacy_requests_tenant_idx" ON "privacy_requests" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "requests_tenant_idx" ON "requests" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "subscriptions_tenant_idx" ON "subscriptions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "usage_daily_tenant_day_idx" ON "usage_daily" USING btree ("tenant_id","day");--> statement-breakpoint
CREATE INDEX "usage_events_tenant_ts_idx" ON "usage_events" USING btree ("tenant_id","ts");--> statement-breakpoint
CREATE INDEX "usage_events_tenant_user_ts_idx" ON "usage_events" USING btree ("tenant_id","user_id","ts");--> statement-breakpoint
CREATE INDEX "usage_events_tenant_dept_ts_idx" ON "usage_events" USING btree ("tenant_id","department_id","ts");--> statement-breakpoint
CREATE INDEX "users_keycloak_idx" ON "users" USING btree ("keycloak_id");