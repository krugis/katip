CREATE TABLE "billing_seat_sent" (
	"tenant_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"seq" integer NOT NULL,
	"delta" integer NOT NULL,
	"units_after" integer NOT NULL,
	"transaction_id" text NOT NULL,
	"lago_subscription_id" text NOT NULL,
	"event_ts" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "billing_seat_sent_tenant_id_metric_seq_pk" PRIMARY KEY("tenant_id","metric","seq"),
	CONSTRAINT "billing_seat_sent_transaction_id_unique" UNIQUE("transaction_id"),
	CONSTRAINT "billing_seat_sent_delta" CHECK ("billing_seat_sent"."delta" <> 0),
	CONSTRAINT "billing_seat_sent_units" CHECK ("billing_seat_sent"."units_after" >= 0),
	CONSTRAINT "billing_seat_sent_status" CHECK ("billing_seat_sent"."status" in ('pending', 'sent'))
);
--> statement-breakpoint
CREATE TABLE "billing_usage_sent" (
	"tenant_id" uuid NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"class" text NOT NULL,
	"seq" integer NOT NULL,
	"tokens" bigint NOT NULL,
	"transaction_id" text NOT NULL,
	"lago_subscription_id" text NOT NULL,
	"event_ts" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "billing_usage_sent_tenant_id_hour_class_seq_pk" PRIMARY KEY("tenant_id","hour","class","seq"),
	CONSTRAINT "billing_usage_sent_transaction_id_unique" UNIQUE("transaction_id"),
	CONSTRAINT "billing_usage_sent_class" CHECK ("billing_usage_sent"."class" in ('standard', 'premium')),
	CONSTRAINT "billing_usage_sent_tokens" CHECK ("billing_usage_sent"."tokens" > 0),
	CONSTRAINT "billing_usage_sent_status" CHECK ("billing_usage_sent"."status" in ('pending', 'sent'))
);
--> statement-breakpoint
ALTER TABLE "billing_seat_sent" ADD CONSTRAINT "billing_seat_sent_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_usage_sent" ADD CONSTRAINT "billing_usage_sent_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;