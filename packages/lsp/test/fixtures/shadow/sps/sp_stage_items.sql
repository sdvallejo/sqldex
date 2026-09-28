CREATE PROCEDURE `sp_stage_items`()
BEGIN
  CREATE TEMPORARY TABLE tmp_items AS SELECT order_id, total FROM orders;
END;
