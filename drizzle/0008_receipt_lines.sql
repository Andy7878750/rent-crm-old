CREATE TABLE "receipt_values" (
	"object_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"month" char(7) NOT NULL,
	"key" text NOT NULL,
	"value" numeric(14, 4) NOT NULL,
	CONSTRAINT "receipt_values_object_id_service_id_month_key_pk" PRIMARY KEY("object_id","service_id","month","key")
);
--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "config" jsonb;--> statement-breakpoint
ALTER TABLE "receipt_values" ADD CONSTRAINT "receipt_values_object_id_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_values" ADD CONSTRAINT "receipt_values_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;