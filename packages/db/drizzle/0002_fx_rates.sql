CREATE TABLE "fx_rates" (
	"rate_date" date NOT NULL,
	"currency" text NOT NULL,
	"buying" numeric(14, 4) NOT NULL,
	"selling" numeric(14, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fx_rates_rate_date_currency_pk" PRIMARY KEY("rate_date","currency")
);
