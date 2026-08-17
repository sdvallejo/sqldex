CREATE PROCEDURE `sp_nightly`()
BEGIN
  CALL sp_settle();
  CALL sp_settle();
  CALL sp_report();
  CALL sp_settle_batch();
  CALL sp_vanished();
END;
