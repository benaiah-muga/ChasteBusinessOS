ALTER TABLE "authored_docs" ADD COLUMN "folder" text;
--> statement-breakpoint
CREATE INDEX "authored_doc_org_folder_idx" ON "authored_docs" USING btree ("org_id","folder");
