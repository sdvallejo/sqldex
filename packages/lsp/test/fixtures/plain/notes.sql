-- A stray .sql file in a directory that is not a schema project: no `tables/`, no `sps/`, no
-- `.sqldex.json`. A server that indexed this would be indexing any repo it was pointed at.
SELECT * FROM whatever;
