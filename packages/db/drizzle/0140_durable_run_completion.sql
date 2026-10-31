CREATE OR REPLACE FUNCTION public.complete_durable_run_after_final_step()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.status = 'committed' AND OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO public.jobs (
      org_id, type, payload, status, max_attempts, available_at,
      created_by_actor_type, created_by_actor_id, run_id, run_step_index, approved_approval_id
    )
    SELECT run.org_id, next_step.capability_id, next_step.input, 'pending', 3, clock_timestamp(),
           run.initiated_by_actor_type, run.initiated_by_actor_id, run.id, next_step.step_index, next_step.approval_id
    FROM public.agent_runs AS run
    JOIN public.agent_run_steps AS next_step
      ON next_step.org_id = run.org_id AND next_step.run_id = run.id
     AND next_step.step_index = NEW.step_index + 1 AND next_step.status = 'pending'
    WHERE run.id = NEW.run_id AND run.org_id = NEW.org_id
      AND run.status NOT IN ('completed', 'cancelled', 'failed')
      AND NOT EXISTS (
        SELECT 1 FROM public.jobs AS existing
        WHERE existing.org_id = run.org_id AND existing.run_id = run.id
          AND existing.run_step_index = next_step.step_index
      );

    UPDATE public.agent_runs AS run
    SET status = 'completed',
        current_step = GREATEST(run.current_step, NEW.step_index),
        finished_at = COALESCE(run.finished_at, clock_timestamp()),
        updated_at = clock_timestamp()
    WHERE run.id = NEW.run_id
      AND run.org_id = NEW.org_id
      AND run.status NOT IN ('completed', 'cancelled', 'failed')
      AND EXISTS (
        SELECT 1 FROM public.agent_run_steps AS step
        WHERE step.org_id = NEW.org_id AND step.run_id = NEW.run_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.agent_run_steps AS step
        WHERE step.org_id = NEW.org_id AND step.run_id = NEW.run_id
          AND step.status <> 'committed'
      );
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.complete_durable_run_after_final_step() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_run_step_complete_run ON public.agent_run_steps;
--> statement-breakpoint
CREATE TRIGGER agent_run_step_complete_run
AFTER UPDATE OF status ON public.agent_run_steps
FOR EACH ROW
EXECUTE FUNCTION public.complete_durable_run_after_final_step();
