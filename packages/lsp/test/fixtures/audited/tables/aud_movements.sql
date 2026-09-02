CREATE TABLE `aud_movements` (
  `aud_id` int NOT NULL AUTO_INCREMENT,
  `aud_at` datetime NOT NULL,
  `aud_by` varchar(60) NOT NULL,
  `aud_action` char(1) NOT NULL,
  `movement_id` int NOT NULL,
  `account_id` int NOT NULL,
  `amount` decimal(10,2) NOT NULL,
  `channel` char(3) NOT NULL,
  PRIMARY KEY (`aud_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
