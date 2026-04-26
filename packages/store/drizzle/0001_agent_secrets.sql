CREATE TABLE "agent_secrets" (
	"agent_id" text NOT NULL,
	"name" text NOT NULL,
	"value_ciphertext" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "agent_secrets_agent_id_name_pk" PRIMARY KEY("agent_id","name")
);
