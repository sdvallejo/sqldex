-- No `tables/`, no `sps/`, no config file: the layout sqldex does not recognise. Naming the
-- directory on the command line is the declaration that it is one, which is what `sqldex check .`
-- has to honour where an editor would not.
CREATE TABLE `warehouses` (
  `warehouse_id` int NOT NULL,
  `city` varchar(80) NOT NULL,
  PRIMARY KEY (`warehouse_id`)
);

SELECT `city` FROM `warehouses`;
