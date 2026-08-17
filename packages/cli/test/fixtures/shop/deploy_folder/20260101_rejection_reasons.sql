-- A migration of the shape this phase exists for: it declares a table and then writes to it, so
-- the file has to be read against a catalog that can see its own `CREATE TABLE`.
CREATE TABLE `rejection_reasons` (
  `reason_id` int NOT NULL,
  `label` varchar(60) NOT NULL,
  PRIMARY KEY (`reason_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `rejection_reasons` (`reason_id`, `label`) VALUES (1, 'expired');
INSERT INTO `rejection_reasons` (`reason_id`, `label`) VALUES (2, 'duplicate');

INSERT INTO `shipping_zones` (`zone_id`) VALUES (1);
