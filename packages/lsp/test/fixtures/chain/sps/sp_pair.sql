CREATE PROCEDURE `sp_pair_first`()
BEGIN
  CALL sp_settle();
END;

CREATE PROCEDURE `sp_pair_second`()
BEGIN
  CALL sp_report();
END;
