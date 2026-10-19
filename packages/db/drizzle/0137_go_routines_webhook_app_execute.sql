DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chaste_app') THEN
    GRANT EXECUTE ON FUNCTION jobs_worker.enqueue_routine_webhook(text) TO chaste_app;
  END IF;
END $$;
