-- A CREATE TABLE missing the comma between its first two columns: a real MySQL syntax error the
-- fast backend's own permissive parser never detects on its own.
CREATE TABLE `warehouses` (
  `warehouse_id` int NOT NULL
  `city` varchar(80) NOT NULL,
  PRIMARY KEY (`warehouse_id`)
);
