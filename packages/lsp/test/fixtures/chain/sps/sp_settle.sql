CREATE PROCEDURE `sp_settle`()
BEGIN
  UPDATE jobs SET state = 'D' WHERE state = 'P';
END;
