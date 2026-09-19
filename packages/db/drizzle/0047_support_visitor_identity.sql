-- I1 (N04): the public widget may no longer bind a customer identity from
-- visitor-supplied input. A widget conversation starts UNBOUND: the visitor's
-- email is stored on the conversation itself with a per-conversation secret
-- (hashed), and linking to a real customer happens only through verified
-- staff action - never by email lookup on the public path.

--> statement-breakpoint

ALTER TABLE support_conversations ALTER COLUMN customer_id DROP NOT NULL;

--> statement-breakpoint

ALTER TABLE support_conversations ADD COLUMN visitor_email text;

--> statement-breakpoint

ALTER TABLE support_conversations ADD COLUMN visitor_secret_hash text;
