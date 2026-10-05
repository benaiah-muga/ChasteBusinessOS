CREATE UNIQUE INDEX support_kb_org_article_unique_idx
  ON support_kb_articles (org_id, id);

CREATE TABLE support_kb_article_embeddings (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  article_id uuid NOT NULL,
  embedding_model text NOT NULL CHECK (length(embedding_model) BETWEEN 1 AND 200),
  content_md5 text NOT NULL CHECK (content_md5 ~ '^[0-9a-f]{32}$'),
  embedding vector(1024) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, article_id),
  CONSTRAINT support_kb_article_embeddings_article_fk
    FOREIGN KEY (org_id, article_id)
    REFERENCES support_kb_articles (org_id, id) ON DELETE CASCADE
);

CREATE INDEX support_kb_article_embeddings_cosine_idx
  ON support_kb_article_embeddings USING hnsw (embedding vector_cosine_ops);

ALTER TABLE support_kb_article_embeddings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON support_kb_article_embeddings
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

CREATE TABLE support_kb_article_embedding_jobs (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  article_id uuid NOT NULL,
  content_md5 text NOT NULL CHECK (content_md5 ~ '^[0-9a-f]{32}$'),
  requested_model text NOT NULL DEFAULT '' CHECK (length(requested_model) <= 200),
  queued_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, article_id),
  CONSTRAINT support_kb_article_embedding_jobs_article_fk
    FOREIGN KEY (org_id, article_id)
    REFERENCES support_kb_articles (org_id, id) ON DELETE CASCADE
);

CREATE INDEX support_kb_article_embedding_jobs_queue_idx
  ON support_kb_article_embedding_jobs (org_id, queued_at, article_id);

ALTER TABLE support_kb_article_embedding_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON support_kb_article_embedding_jobs
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

CREATE FUNCTION enqueue_public_support_article_embedding() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM support_kb_article_embeddings WHERE org_id=OLD.org_id AND article_id=OLD.id;
    DELETE FROM support_kb_article_embedding_jobs WHERE org_id=OLD.org_id AND article_id=OLD.id;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND
     OLD.org_id IS NOT DISTINCT FROM NEW.org_id AND
     OLD.id IS NOT DISTINCT FROM NEW.id AND
     OLD.title IS NOT DISTINCT FROM NEW.title AND
     OLD.body IS NOT DISTINCT FROM NEW.body AND
     OLD.is_public IS NOT DISTINCT FROM NEW.is_public THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND
     (OLD.org_id IS DISTINCT FROM NEW.org_id OR OLD.id IS DISTINCT FROM NEW.id) THEN
    DELETE FROM support_kb_article_embeddings WHERE org_id=OLD.org_id AND article_id=OLD.id;
    DELETE FROM support_kb_article_embedding_jobs WHERE org_id=OLD.org_id AND article_id=OLD.id;
  END IF;
  DELETE FROM support_kb_article_embeddings WHERE org_id=NEW.org_id AND article_id=NEW.id;
  DELETE FROM support_kb_article_embedding_jobs WHERE org_id=NEW.org_id AND article_id=NEW.id;

  IF NEW.is_public THEN
    INSERT INTO support_kb_article_embedding_jobs (org_id, article_id, content_md5)
    VALUES (NEW.org_id, NEW.id, md5(NEW.title || E'\n' || NEW.body));
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER support_kb_article_embedding_lifecycle
AFTER INSERT OR UPDATE OR DELETE
ON support_kb_articles
FOR EACH ROW EXECUTE FUNCTION enqueue_public_support_article_embedding();

INSERT INTO support_kb_article_embedding_jobs (org_id, article_id, content_md5)
SELECT org_id, id, md5(title || E'\n' || body)
FROM support_kb_articles
WHERE is_public=true
ON CONFLICT (org_id, article_id) DO NOTHING;
