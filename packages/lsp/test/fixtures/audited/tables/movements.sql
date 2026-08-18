CREATE TABLE `movements` (
  `movement_id` int NOT NULL AUTO_INCREMENT,
  `account_id` int NOT NULL,
  `amount` decimal(10,2) NOT NULL,
  `note` varchar(200) DEFAULT NULL,
  PRIMARY KEY (`movement_id`),
  KEY `ix_account` (`account_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TRIGGER `movements_ai` AFTER INSERT ON `movements` FOR EACH ROW
BEGIN
  INSERT INTO aud_movements VALUES (0, NOW(), SUBSTRING_INDEX(USER(), '@', 1), 'I', NEW.movement_id, NEW.account_id, NEW.amount);
END;

CREATE TRIGGER `movements_ad` AFTER DELETE ON `movements` FOR EACH ROW
BEGIN
  INSERT INTO aud_movements VALUES (0, NOW(), SUBSTRING_INDEX(USER(), '@', 1), 'D', OLD.movement_id, OLD.account_id, OLD.amount);
END;
