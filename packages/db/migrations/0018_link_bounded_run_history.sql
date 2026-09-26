WITH old_runs AS (
  SELECT
    id AS run_id,
    thread_id,
    gen_random_uuid() AS message_id,
    COALESCE(error_message, 'Stopped before completing the task.') AS content,
    COALESCE(completed_at, created_at) AS message_time
  FROM agent_run
  WHERE status = 'failed'
    AND error_code IN ('AGENT_MAX_TURNS', 'AGENT_DEADLINE')
    AND result_message_id IS NULL
), added_messages AS (
  INSERT INTO agent_message (id, thread_id, role, content, created_at)
  SELECT message_id, thread_id, 'assistant', content, message_time
  FROM old_runs
  RETURNING id
)
UPDATE agent_run AS run
SET result_message_id = old_runs.message_id
FROM old_runs
JOIN added_messages ON added_messages.id = old_runs.message_id
WHERE run.id = old_runs.run_id;
