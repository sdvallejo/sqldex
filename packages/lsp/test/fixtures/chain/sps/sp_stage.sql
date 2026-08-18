CREATE PROCEDURE `sp_stage`()
BEGIN
  CREATE TEMPORARY TABLE tmp_jobs AS SELECT job_id, state FROM jobs;
END;
