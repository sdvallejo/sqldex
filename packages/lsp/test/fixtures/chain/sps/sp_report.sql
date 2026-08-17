CREATE PROCEDURE `sp_report`()
BEGIN
  -- sp_settle leaves the jobs in their final state
  SELECT 'sp_settle', COUNT(*) FROM jobs;
END;
