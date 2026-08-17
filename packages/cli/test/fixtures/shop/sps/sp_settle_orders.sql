CREATE PROCEDURE `sp_settle_orders`(IN pCustomerId int)
BEGIN
  DECLARE vBatchSize int DEFAULT 100;

  INSERT INTO orders (order_id, customer_id, total) VALUES (1, pCustomerId);

  UPDATE customers SET status = 'S';
END;
