ALTER TABLE support_kb_articles
  ADD COLUMN is_public boolean NOT NULL DEFAULT false;
