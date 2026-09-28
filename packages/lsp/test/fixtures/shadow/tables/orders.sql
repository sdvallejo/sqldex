CREATE TABLE `orders` (
  `order_id` int NOT NULL AUTO_INCREMENT,
  `total` decimal(10,2) NOT NULL,
  PRIMARY KEY (`order_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
