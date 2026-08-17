CREATE TABLE `customers` (
  `customer_id` int NOT NULL AUTO_INCREMENT,
  `email` varchar(120) NOT NULL,
  `status` char(1) NOT NULL DEFAULT 'A' COMMENT 'A=active, S=suspended',
  PRIMARY KEY (`customer_id`),
  UNIQUE KEY `uq_email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
