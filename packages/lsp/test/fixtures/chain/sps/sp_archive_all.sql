CREATE PROCEDURE `sp_archive_all`()
BEGIN
  CALL sp_archive_stage();
END;
