CREATE PROCEDURE `sp_settle_orders`(IN pCustomerId int)
BEGIN
  INSERT INTO orders (order_id, customer_id, total) VALUES (1, pCustomerId);
END;
