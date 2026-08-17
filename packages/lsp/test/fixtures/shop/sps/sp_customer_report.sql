/** Totals one customer's orders, and counts the ones already delivered. */
CREATE PROCEDURE `sp_customer_report`(IN pCustomerId int, OUT pTotal decimal(10,2))
BEGIN
  DECLARE vDelivered int DEFAULT 0;

  SELECT SUM(o.total) INTO pTotal FROM orders o WHERE o.customer_id = pCustomerId;

  SELECT COUNT(*) INTO vDelivered
  FROM shipments s
  JOIN orders o ON o.order_id = s.order_id
  WHERE o.customer_id = pCustomerId AND s.state = 'D';

  SELECT pTotal, vDelivered;
END;
