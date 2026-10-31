DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chaste_app') THEN
    GRANT USAGE ON SCHEMA jobs_worker TO chaste_app;
  END IF;
END $$;
