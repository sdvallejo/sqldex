-- sqldex demo — one file, every rule sqldex has.
--
--   sqldex check demo/demo.sql
--
-- Everything below is deliberately wrong. Each block names the rule it triggers;
-- `sqldex explain <rule-id>` prints the reasoning behind any of them.
-- Nothing here is a syntax error: MySQL accepts most of it, which is the point.
--
-- The `.sqldex.json` next to this file is what makes `demo/` its own project, so the
-- catalog is built from this file alone and not from the rest of the repository.


-- ─── The schema ───────────────────────────────────────────────────────────────
-- Seven tables and an audit twin. The mistakes are in the DDL itself, and none of
-- them stops the file from applying.

CREATE TABLE customers (
  id int NOT NULL,
  code varchar(20) NOT NULL,
  name varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE orders (
  id int NOT NULL,
  customer_id bigint NOT NULL,
  customer_code varchar(20) NOT NULL,
  customer_name varchar(100) CHARACTER SET latin1 COLLATE latin1_swedish_ci NOT NULL,
  status char(1) NOT NULL COMMENT 'P=pendiente, S=enviado, C=cancelado',
  total decimal(10,2) NOT NULL,
  discount decimal(10,2) DEFAULT NULL,
  PRIMARY KEY (id),

  -- schema/redundant-index — idx_customer is a prefix of idx_customer_status.
  KEY idx_customer (customer_id),
  KEY idx_customer_status (customer_id, status),

  -- schema/index-unknown-column — there is no `produkt_id` on this table.
  KEY idx_typo (produkt_id),

  -- schema/fk-type-mismatch — bigint pointing at an int. InnoDB refuses this.
  CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers (id),

  -- schema/fk-missing-index — customers.code is not indexed, so every write here
  -- makes InnoDB scan the parent to check the constraint.
  CONSTRAINT fk_orders_code FOREIGN KEY (customer_code) REFERENCES customers (code),

  -- schema/fk-unknown-column — `nombre` does not exist on customers.
  CONSTRAINT fk_orders_name FOREIGN KEY (customer_name) REFERENCES customers (nombre),

  -- schema/fk-unknown-table — no such table in the schema.
  CONSTRAINT fk_orders_channel FOREIGN KEY (id) REFERENCES sales_channel (id)
);

CREATE TABLE order_lines (
  order_id int NOT NULL,
  customer_id int NOT NULL,
  sku varchar(20) NOT NULL,
  qty int NOT NULL,

  -- schema/no-primary-key — nothing identifies a row here.
  -- schema/duplicate-constraint-name — MySQL scopes a constraint name to the
  -- database, and `orders` already used this one.
  CONSTRAINT fk_orders_customer FOREIGN KEY (order_id) REFERENCES orders (id)
);

CREATE TABLE payments (
  id int NOT NULL,
  order_id int NOT NULL,
  customer_id int NOT NULL,
  kind char(1) NOT NULL,
  amount decimal(10,2) NOT NULL,
  PRIMARY KEY (id),
  -- The key that makes `WHERE order_id = ...` alone ambiguous, further down.
  UNIQUE KEY uq_payment (order_id, kind)
);

-- Two more tables that only exist to type `customer_id` the way the rest of the schema
-- does. schema/divergent-type — five tables use the name, four of them agree, and orders
-- is the one that stands alone. It is a hint because the rule cannot tell which side is
-- the mistake, only that one table disagrees with every other; here the foreign key says.
CREATE TABLE shipments (
  id int NOT NULL,
  customer_id int NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE invoices (
  id int NOT NULL,
  customer_id int NOT NULL,
  PRIMARY KEY (id)
);

-- The audit twin, missing two of the columns it is supposed to mirror.
-- audit/table-out-of-sync — reported on orders.discount and orders.status.
CREATE TABLE aud_orders (
  aud_id int NOT NULL,
  id int NOT NULL,
  customer_id bigint NOT NULL,
  customer_code varchar(20) NOT NULL,
  customer_name varchar(100) NOT NULL,
  total decimal(10,2) NOT NULL,
  PRIMARY KEY (aud_id)
);

-- audit/trigger-missing-column — the insert is positional, and this one runs out
-- of values before it reaches every column: those values are silently not audited.
-- query/insert-value-count — five values into a six-column table.
CREATE TRIGGER trg_orders_ai AFTER INSERT ON orders
FOR EACH ROW
BEGIN
  INSERT INTO aud_orders VALUES (0, NEW.id, NEW.customer_id, NEW.customer_code, NEW.total);
END;


-- ─── Names ────────────────────────────────────────────────────────────────────
-- The questions an editor answers with a live connection, answered from the files.

SELECT * FROM ordenes;                                    -- names/unknown-table
SELECT o.totall FROM orders o;                             -- names/unknown-column
SELECT x.total FROM orders o;                              -- names/unknown-alias
SELECT id FROM orders o JOIN customers c ON c.id = o.id;    -- names/ambiguous-column
SELECT estado FROM orders o;                               -- names/unqualified-column


-- ─── Writes ───────────────────────────────────────────────────────────────────

-- query/insert-value-count — four values for three columns.
INSERT INTO orders (id, customer_id, status) VALUES (1, 2, 'P', 99.00);

-- query/insert-unknown-column — `statuss`.
INSERT INTO orders (id, customer_id, statuss, total) VALUES (1, 2, 'P', 99.00);

-- query/insert-missing-required-column — four of the columns are NOT NULL with no
-- default, so this INSERT cannot succeed.
INSERT INTO orders (id, customer_id) VALUES (1, 2);

-- query/unfiltered-write — both of these hit every row in the table.
UPDATE orders SET status = 'C';
DELETE FROM orders;


-- ─── Queries the server accepts and answers wrongly ───────────────────────────

-- query/join-without-condition — a cartesian product.
SELECT * FROM orders o JOIN customers c;

-- query/join-multiplies-aggregate — one row per line item, so the money is
-- counted once per line. Only the schema knows order_lines.order_id is not unique.
SELECT o.id, SUM(o.total)
FROM orders o JOIN order_lines l ON l.order_id = o.id
GROUP BY o.id;

-- query/only-full-group-by — o.total is neither grouped nor aggregated.
SELECT c.id, c.name, o.total
FROM customers c JOIN orders o ON o.customer_id = c.id
GROUP BY c.id;

-- query/aggregate-without-group-by — one row back, and c.name is whichever row
-- the server happened to read.
SELECT c.name, SUM(o.total) FROM customers c JOIN orders o ON o.customer_id = c.id;

-- query/left-join-arithmetic — o.total is NULL for a customer with no orders, and
-- the NULL swallows the whole expression.
SELECT c.id, o.total * 1.21 FROM customers c LEFT JOIN orders o ON o.customer_id = c.id;

-- query/collation-mismatch — latin1 against utf8mb4: the index goes unused.
SELECT o.id FROM orders o JOIN customers c ON o.customer_name = c.name;

-- query/literal-type-mismatch — MySQL reads 'gratis' as the number 0.
SELECT * FROM orders o WHERE o.total = 'gratis';

-- query/enum-value-not-defined — status declares P, S and C in its own COMMENT, and 'E' is not one
-- of them: the condition is false for every row that exists, so this returns nothing, forever.
-- The COMMENT is the only source the rule will use — the codes it also derives from the procedures
-- are a lower bound, and a finding built on those would report every code that happens to be rare.
SELECT * FROM orders o WHERE o.status = 'E';
SELECT * FROM orders o WHERE o.status IN ('P', 'E');

-- query/insert-select-column-count — the audit convention written as an INSERT … SELECT, one column
-- short. `orders.*` is one token to a lexer and seven columns to MySQL, which is why the count needs
-- the catalog: 3 + 7 against the six aud_orders actually has.
INSERT INTO aud_orders SELECT 0, NOW(), 'demo', orders.* FROM orders WHERE id = 1;

-- query/nullable-scalar-subquery — SUM over no rows is NULL, and the NULL becomes the
-- whole sum and is written over the total. The fix goes inside the subquery —
-- `COALESCE(SUM(amount), 0)` — because a COALESCE around the outside would only be
-- writing a confident 0 over a total nobody actually knows.
UPDATE orders
SET total = total + (SELECT SUM(amount) FROM payments WHERE order_id = orders.id)
WHERE id = 1;

-- query/scalar-subquery-many-rows — the WHERE starts uq_payment (order_id, kind)
-- and abandons it, so two payment kinds for one order is error 1242.
SELECT o.id, (SELECT amount FROM payments WHERE order_id = o.id) FROM orders o;


-- ─── Routines ─────────────────────────────────────────────────────────────────

CREATE PROCEDURE sp_customer_total(IN p_customer int, OUT p_total decimal(10,2))
BEGIN
  DECLARE v_discount decimal(10,2);
  DECLARE v_note varchar(100);
  DECLARE v_unused int;                    -- routine/unused-variable
  DECLARE c_orders CURSOR FOR SELECT id FROM orders;  -- routine/cursor-never-opened

  -- routine/select-into-arity — three columns read into two variables. MySQL answers error 1222
  -- and the procedure stops here, on every dataset, which is why it displaces the row-count rule
  -- below: advice about how many rows this might match is advice about a statement that never runs.
  SELECT id, kind, amount INTO p_total, v_discount FROM payments WHERE id = 1;

  -- routine/select-into-many-rows — the same abandoned unique key, in the other
  -- place a routine reads a single value: error 1172 the day a second kind exists.
  SELECT amount INTO p_total FROM payments WHERE order_id = p_customer;

  -- routine/nullable-into-arithmetic — orders.discount is nullable, so v_discount
  -- is, and the sum is NULL with nothing to absorb it.
  SELECT discount INTO v_discount FROM orders WHERE id = p_customer;
  SET p_total = p_total - v_discount;

  -- routine/nullable-variable-in-predicate — a NULL is not "different from" 0, so this
  -- comparison is unknown, which reads as false: the branch never runs.
  IF v_discount != 0 THEN
    SET p_total = 0;
  END IF;

  -- routine/variable-never-assigned — v_note can only ever hold NULL here.
  -- routine/nullable-variable-in-predicate — and CONCAT turns the whole string to NULL.
  SELECT CONCAT('total: ', v_note, v_discount);
END;

CREATE PROCEDURE sp_run()
BEGIN
  DECLARE v_total decimal(10,2);

  CALL sp_customer_total(1);              -- routine/call-arity
  CALL sp_customer_total(1, 2, 3);        -- routine/call-arity
  CALL sp_customer_total(1, 99.00);       -- routine/out-argument-not-variable
  CALL sp_customer_total(1, v_total);     -- correct: nothing reported
  CALL sp_no_such_proc(1);                -- names/unknown-routine
END;

-- routine/declare-after-statement — MySQL will not even parse this one. It lives
-- in its own procedure because a body that does not parse has no locals to check.
CREATE PROCEDURE sp_bad_declare()
BEGIN
  SELECT 1;
  DECLARE v_late int;
END;
