CREATE TABLE `jobs` (
  `job_id` int NOT NULL AUTO_INCREMENT,
  `state` char(1) NOT NULL DEFAULT 'P',
  PRIMARY KEY (`job_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
