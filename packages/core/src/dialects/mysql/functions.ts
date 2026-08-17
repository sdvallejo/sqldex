/**
 * MySQL's built-in functions: what each one is called with, what it does, and the family it
 * belongs to.
 *
 * ## Why this is written out rather than generated
 *
 * The obvious source is the `fill_help_tables.sql` that ships with the server — the same text the
 * client's `HELP` command reads. It is distributed under the GPL alongside the server, and
 * embedding it here would pull that licence onto this package. So the entries below are written
 * from scratch, and the summaries are one sentence rather than the manual's paragraph.
 *
 * ## Why these ones
 *
 * The manual documents several hundred functions and most of them never appear in a schema
 * repository. This list is the ones that do — the string, date and JSON functions procedures are
 * actually written with — plus the common ones that are simply expected to be here. It is not
 * meant to be exhaustive, and a name that is missing degrades to what an unknown name does
 * everywhere else: nothing is claimed about it.
 *
 * The `category` is what a completion list shows beside the name, which is the one place a reader
 * benefits from knowing that `JSON_EXTRACT` and `JSON_UNQUOTE` are the same kind of thing.
 */

/** One built-in, with the name it is written under. */
export interface BuiltinFunction {
  /** The catalog's spelling, always upper case. */
  name: string;
  /** With argument names, so signature help can point at the one being typed. */
  signature: string;
  /** One sentence. Two at most, and only when the first would mislead on its own. */
  summary: string;
  /** The family, shown beside the name in a completion list. */
  category: string;
}

const CATALOG: Record<string, Omit<BuiltinFunction, "name">> = {
  // -------------------------------------------------------------- control flow
  CASE: {
    signature: "CASE [expr] WHEN v THEN r [...] [ELSE r] END",
    summary: "Picks among several branches. Without `ELSE` it returns NULL when none matches.",
    category: "control flow",
  },
  COALESCE: {
    signature: "COALESCE(value, ...)",
    summary: "The first argument that is not NULL, or NULL if they all are.",
    category: "control flow",
  },
  IF: {
    signature: "IF(condition, then, else)",
    summary: "Returns one or the other depending on the condition. An expression, unlike a procedure's `IF ... THEN`.",
    category: "control flow",
  },
  IFNULL: {
    signature: "IFNULL(expr, alternative)",
    summary: "`expr` unless it is NULL, otherwise `alternative`. It is a two-argument `COALESCE`.",
    category: "control flow",
  },
  ISNULL: {
    signature: "ISNULL(expr)",
    summary: "1 if `expr` is NULL, 0 otherwise.",
    category: "control flow",
  },
  NULLIF: {
    signature: "NULLIF(a, b)",
    summary: "NULL when `a = b`, otherwise `a`. Handy to avoid dividing by zero: `x / NULLIF(y, 0)`.",
    category: "control flow",
  },

  // ------------------------------------------------------------------- numeric
  ABS: {
    signature: "ABS(x)",
    summary: "Absolute value.",
    category: "numeric",
  },
  CEIL: {
    signature: "CEIL(x)",
    summary: "Smallest integer not less than `x`.",
    category: "numeric",
  },
  CEILING: {
    signature: "CEILING(x)",
    summary: "A synonym for `CEIL`.",
    category: "numeric",
  },
  EXP: {
    signature: "EXP(x)",
    summary: "e raised to `x`.",
    category: "numeric",
  },
  FLOOR: {
    signature: "FLOOR(x)",
    summary: "Largest integer not greater than `x`.",
    category: "numeric",
  },
  GREATEST: {
    signature: "GREATEST(v1, v2, ...)",
    summary: "The largest argument. NULL if any of them is NULL.",
    category: "numeric",
  },
  LEAST: {
    signature: "LEAST(v1, v2, ...)",
    summary: "The smallest argument. NULL if any of them is NULL.",
    category: "numeric",
  },
  LN: {
    signature: "LN(x)",
    summary: "Natural logarithm.",
    category: "numeric",
  },
  LOG: {
    signature: "LOG([base,] x)",
    summary: "Natural logarithm, or in the given base.",
    category: "numeric",
  },
  LOG10: {
    signature: "LOG10(x)",
    summary: "Base-10 logarithm.",
    category: "numeric",
  },
  MOD: {
    signature: "MOD(n, m)",
    summary: "Division remainder. Same as `n % m`.",
    category: "numeric",
  },
  PI: {
    signature: "PI()",
    summary: "The number pi.",
    category: "numeric",
  },
  POW: {
    signature: "POW(x, y)",
    summary: "`x` raised to `y`.",
    category: "numeric",
  },
  POWER: {
    signature: "POWER(x, y)",
    summary: "A synonym for `POW`.",
    category: "numeric",
  },
  RAND: {
    signature: "RAND([seed])",
    summary: "Random value in [0, 1). Without a seed it changes per row, which is why `ORDER BY RAND()` does not scale.",
    category: "numeric",
  },
  ROUND: {
    signature: "ROUND(x [, decimals])",
    summary: "Rounds. A negative `decimals` rounds to tens, hundreds and so on.",
    category: "numeric",
  },
  SIGN: {
    signature: "SIGN(x)",
    summary: "-1, 0 or 1 depending on the sign.",
    category: "numeric",
  },
  SQRT: {
    signature: "SQRT(x)",
    summary: "Square root. NULL when `x` is negative.",
    category: "numeric",
  },
  TRUNCATE: {
    signature: "TRUNCATE(x, decimals)",
    summary: "Drops decimals **without rounding**. The argument is not optional.",
    category: "numeric",
  },

  // -------------------------------------------------------------------- string
  ASCII: {
    signature: "ASCII(str)",
    summary: "Code of the first character.",
    category: "string",
  },
  CHAR: {
    signature: "CHAR(n, ... [USING charset])",
    summary: "Characters from their codes.",
    category: "string",
  },
  CHAR_LENGTH: {
    signature: "CHAR_LENGTH(str)",
    summary: "Length in characters, whatever the character set.",
    category: "string",
  },
  CONCAT: {
    signature: "CONCAT(str, ...)",
    summary: "Concatenates. **If any argument is NULL the whole result is NULL**, which is the classic trap.",
    category: "string",
  },
  CONCAT_WS: {
    signature: "CONCAT_WS(separator, str, ...)",
    summary: "Concatenates with a separator. Unlike `CONCAT`, it skips NULLs instead of propagating them.",
    category: "string",
  },
  ELT: {
    signature: "ELT(n, str1, str2, ...)",
    summary: "The nth argument, 1-based. The inverse of `FIELD`.",
    category: "string",
  },
  FIELD: {
    signature: "FIELD(str, v1, v2, ...)",
    summary: "Position of `str` in the list, 0 when absent. Used for `ORDER BY FIELD(...)`.",
    category: "string",
  },
  FORMAT: {
    signature: "FORMAT(number, decimals [, locale])",
    summary: "Formats with thousand separators and returns **text**. Not usable for further arithmetic.",
    category: "string",
  },
  HEX: {
    signature: "HEX(n_or_str)",
    summary: "Hexadecimal representation.",
    category: "string",
  },
  INSTR: {
    signature: "INSTR(haystack, needle)",
    summary: "Like `LOCATE`, with the arguments the other way round.",
    category: "string",
  },
  LEFT: {
    signature: "LEFT(str, length)",
    summary: "The first `length` characters.",
    category: "string",
  },
  LENGTH: {
    signature: "LENGTH(str)",
    summary: "Length **in bytes**. Under utf8mb4 an `ñ` counts as 2: to count characters use `CHAR_LENGTH`.",
    category: "string",
  },
  LOCATE: {
    signature: "LOCATE(needle, haystack [, from])",
    summary: "Position of the first occurrence, 1-based. 0 when absent.",
    category: "string",
  },
  LOWER: {
    signature: "LOWER(str)",
    summary: "To lower case.",
    category: "string",
  },
  LPAD: {
    signature: "LPAD(str, length, padding)",
    summary: "Left-pads up to `length`. If `str` is longer, it **truncates** it.",
    category: "string",
  },
  LTRIM: {
    signature: "LTRIM(str)",
    summary: "Strips leading whitespace.",
    category: "string",
  },
  REGEXP_LIKE: {
    signature: "REGEXP_LIKE(str, pattern [, flags])",
    summary: "Does the string match the regular expression? MySQL 8.0+; MariaDB uses `str REGEXP pattern`.",
    category: "string",
  },
  REGEXP_REPLACE: {
    signature: "REGEXP_REPLACE(str, pattern, replacement)",
    summary: "Replaces whatever matches the regular expression. MySQL 8.0+.",
    category: "string",
  },
  REGEXP_SUBSTR: {
    signature: "REGEXP_SUBSTR(str, pattern)",
    summary: "The part matching the regular expression. MySQL 8.0+.",
    category: "string",
  },
  REPEAT: {
    signature: "REPEAT(str, times)",
    summary: "Repeats the string.",
    category: "string",
  },
  REPLACE: {
    signature: "REPLACE(str, search, replacement)",
    summary: "Replaces every occurrence. Not the same as the `REPLACE INTO` statement.",
    category: "string",
  },
  REVERSE: {
    signature: "REVERSE(str)",
    summary: "Reverses the string.",
    category: "string",
  },
  RIGHT: {
    signature: "RIGHT(str, length)",
    summary: "The last `length` characters.",
    category: "string",
  },
  RPAD: {
    signature: "RPAD(str, length, padding)",
    summary: "Right-pads up to `length`. If `str` is longer, it truncates it.",
    category: "string",
  },
  RTRIM: {
    signature: "RTRIM(str)",
    summary: "Strips trailing whitespace.",
    category: "string",
  },
  SPACE: {
    signature: "SPACE(n)",
    summary: "A string of `n` spaces.",
    category: "string",
  },
  SUBSTR: {
    signature: "SUBSTR(str, from [, length])",
    summary: "A synonym for `SUBSTRING`.",
    category: "string",
  },
  SUBSTRING: {
    signature: "SUBSTRING(str, from [, length])",
    summary: "Substring. Positions start at 1; a negative one counts from the end.",
    category: "string",
  },
  SUBSTRING_INDEX: {
    signature: "SUBSTRING_INDEX(str, delimiter, count)",
    summary: "The part up to the nth occurrence of the delimiter. A negative `count` counts from the end.",
    category: "string",
  },
  TRIM: {
    signature: "TRIM([{BOTH|LEADING|TRAILING} [remstr] FROM] str)",
    summary: "Strips whitespace —  or another string —  from the ends.",
    category: "string",
  },
  UNHEX: {
    signature: "UNHEX(str)",
    summary: "Undoes `HEX`.",
    category: "string",
  },
  UPPER: {
    signature: "UPPER(str)",
    summary: "To upper case.",
    category: "string",
  },

  // ------------------------------------------------------------- date and time
  ADDDATE: {
    signature: "ADDDATE(date, INTERVAL amount unit | days)",
    summary: "Like `DATE_ADD`, and with a bare number it adds days.",
    category: "date and time",
  },
  CONVERT_TZ: {
    signature: "CONVERT_TZ(date, from_tz, to_tz)",
    summary: "Shifts time zone. With zone names it needs the time-zone tables loaded.",
    category: "date and time",
  },
  CURDATE: {
    signature: "CURDATE()",
    summary: "Today's date, no time.",
    category: "date and time",
  },
  CURTIME: {
    signature: "CURTIME()",
    summary: "Current time, no date.",
    category: "date and time",
  },
  DATE: {
    signature: "DATE(expr)",
    summary: "The date part, dropping the time.",
    category: "date and time",
  },
  DATEDIFF: {
    signature: "DATEDIFF(date1, date2)",
    summary: "Days between the two, `date1 - date2`. Only the date part counts.",
    category: "date and time",
  },
  DATE_ADD: {
    signature: "DATE_ADD(date, INTERVAL amount unit)",
    summary: "Adds an interval: `DATE_ADD(d, INTERVAL 1 MONTH)`.",
    category: "date and time",
  },
  DATE_FORMAT: {
    signature: "DATE_FORMAT(date, format)",
    summary: "Date to text: `%Y-%m-%d` for year-month-day, `%H:%i:%s` for the time.",
    category: "date and time",
  },
  DATE_SUB: {
    signature: "DATE_SUB(date, INTERVAL amount unit)",
    summary: "Subtracts an interval.",
    category: "date and time",
  },
  DAY: {
    signature: "DAY(date)",
    summary: "Day of the month, 1 to 31.",
    category: "date and time",
  },
  DAYNAME: {
    signature: "DAYNAME(date)",
    summary: "Name of the day, in the server's language.",
    category: "date and time",
  },
  DAYOFMONTH: {
    signature: "DAYOFMONTH(date)",
    summary: "A synonym for `DAY`.",
    category: "date and time",
  },
  DAYOFWEEK: {
    signature: "DAYOFWEEK(date)",
    summary: "Day of the week, **1 = Sunday** … 7 = Saturday. Careful: `WEEKDAY` numbers it differently.",
    category: "date and time",
  },
  DAYOFYEAR: {
    signature: "DAYOFYEAR(date)",
    summary: "Day of the year, 1 to 366.",
    category: "date and time",
  },
  EXTRACT: {
    signature: "EXTRACT(unit FROM date)",
    summary: "Pulls out one part: `EXTRACT(YEAR_MONTH FROM d)`.",
    category: "date and time",
  },
  FROM_UNIXTIME: {
    signature: "FROM_UNIXTIME(seconds [, format])",
    summary: "Undoes `UNIX_TIMESTAMP`.",
    category: "date and time",
  },
  HOUR: {
    signature: "HOUR(time)",
    summary: "The hour.",
    category: "date and time",
  },
  LAST_DAY: {
    signature: "LAST_DAY(date)",
    summary: "Last day of that date's month.",
    category: "date and time",
  },
  MAKEDATE: {
    signature: "MAKEDATE(year, day_of_year)",
    summary: "Builds a date from a year and a day of the year.",
    category: "date and time",
  },
  MINUTE: {
    signature: "MINUTE(time)",
    summary: "The minutes.",
    category: "date and time",
  },
  MONTH: {
    signature: "MONTH(date)",
    summary: "The month, 1 to 12.",
    category: "date and time",
  },
  MONTHNAME: {
    signature: "MONTHNAME(date)",
    summary: "Name of the month, in the server's language.",
    category: "date and time",
  },
  NOW: {
    signature: "NOW()",
    summary: "Date and time of the **statement's start**: two `NOW()` in one statement give the same value.",
    category: "date and time",
  },
  QUARTER: {
    signature: "QUARTER(date)",
    summary: "The quarter, 1 to 4.",
    category: "date and time",
  },
  SECOND: {
    signature: "SECOND(time)",
    summary: "The seconds.",
    category: "date and time",
  },
  SEC_TO_TIME: {
    signature: "SEC_TO_TIME(seconds)",
    summary: "Seconds to a TIME value.",
    category: "date and time",
  },
  STR_TO_DATE: {
    signature: "STR_TO_DATE(str, format)",
    summary: "Text to date, with the same specifiers as `DATE_FORMAT`. NULL when it does not match.",
    category: "date and time",
  },
  SUBDATE: {
    signature: "SUBDATE(date, INTERVAL amount unit | days)",
    summary: "Like `DATE_SUB`, and with a bare number it subtracts days.",
    category: "date and time",
  },
  SYSDATE: {
    signature: "SYSDATE()",
    summary: "Date and time at the moment of evaluation, which may differ from `NOW()` within one statement.",
    category: "date and time",
  },
  TIME: {
    signature: "TIME(expr)",
    summary: "The time part.",
    category: "date and time",
  },
  TIMEDIFF: {
    signature: "TIMEDIFF(time1, time2)",
    summary: "Difference as a TIME value.",
    category: "date and time",
  },
  TIMESTAMPADD: {
    signature: "TIMESTAMPADD(unit, amount, date)",
    summary: "Adds an amount of the given unit.",
    category: "date and time",
  },
  TIMESTAMPDIFF: {
    signature: "TIMESTAMPDIFF(unit, from, to)",
    summary: "Difference in the requested unit. **The order is the opposite of `DATEDIFF`**: it subtracts `from` from `to`.",
    category: "date and time",
  },
  TIME_FORMAT: {
    signature: "TIME_FORMAT(time, format)",
    summary: "Time to text.",
    category: "date and time",
  },
  TIME_TO_SEC: {
    signature: "TIME_TO_SEC(time)",
    summary: "The time in seconds.",
    category: "date and time",
  },
  UNIX_TIMESTAMP: {
    signature: "UNIX_TIMESTAMP([date])",
    summary: "Seconds since 1970-01-01 UTC. With no argument, the current moment.",
    category: "date and time",
  },
  UTC_TIMESTAMP: {
    signature: "UTC_TIMESTAMP()",
    summary: "Date and time in UTC.",
    category: "date and time",
  },
  WEEK: {
    signature: "WEEK(date [, mode])",
    summary: "Week number. `mode` decides which day starts it.",
    category: "date and time",
  },
  WEEKDAY: {
    signature: "WEEKDAY(date)",
    summary: "Day of the week, **0 = Monday** … 6 = Sunday. Does not line up with `DAYOFWEEK`.",
    category: "date and time",
  },
  WEEKOFYEAR: {
    signature: "WEEKOFYEAR(date)",
    summary: "ISO week of the year, 1 to 53.",
    category: "date and time",
  },
  YEAR: {
    signature: "YEAR(date)",
    summary: "The year.",
    category: "date and time",
  },

  // ---------------------------------------------------------------------- JSON
  JSON_ARRAY: {
    signature: "JSON_ARRAY(value, ...)",
    summary: "Builds a JSON array.",
    category: "JSON",
  },
  JSON_ARRAYAGG: {
    signature: "JSON_ARRAYAGG(column)",
    summary: "Aggregates the group's rows into a JSON array.",
    category: "JSON",
  },
  JSON_ARRAY_APPEND: {
    signature: "JSON_ARRAY_APPEND(json, path, value, ...)",
    summary: "Appends to the array found at the path.",
    category: "JSON",
  },
  JSON_ARRAY_INSERT: {
    signature: "JSON_ARRAY_INSERT(json, path, value, ...)",
    summary: "Inserts at an array position: the path includes the index.",
    category: "JSON",
  },
  JSON_CONTAINS: {
    signature: "JSON_CONTAINS(target, candidate [, path])",
    summary: "Does the document contain that value? Returns 0 or 1.",
    category: "JSON",
  },
  JSON_CONTAINS_PATH: {
    signature: "JSON_CONTAINS_PATH(json, 'one'|'all', path, ...)",
    summary: "Do the paths exist? With `'one'` any will do, with `'all'` every one must be there.",
    category: "JSON",
  },
  JSON_DEPTH: {
    signature: "JSON_DEPTH(json)",
    summary: "The document's maximum depth.",
    category: "JSON",
  },
  JSON_EXTRACT: {
    signature: "JSON_EXTRACT(json, path, ...)",
    summary: "Extracts by path (`$.a`, `$[0]`). The `->` operator is the same thing, written shorter.",
    category: "JSON",
  },
  JSON_INSERT: {
    signature: "JSON_INSERT(json, path, value, ...)",
    summary: "Writes only if the path does **not** exist.",
    category: "JSON",
  },
  JSON_KEYS: {
    signature: "JSON_KEYS(json [, path])",
    summary: "Array with the object's keys.",
    category: "JSON",
  },
  JSON_LENGTH: {
    signature: "JSON_LENGTH(json [, path])",
    summary: "Number of array elements, or of object keys. A scalar measures 1.",
    category: "JSON",
  },
  JSON_MERGE: {
    signature: "JSON_MERGE(json, ...)",
    summary: "Deprecated since MySQL 5.7.22. It is `JSON_MERGE_PRESERVE`.",
    category: "JSON",
  },
  JSON_MERGE_PATCH: {
    signature: "JSON_MERGE_PATCH(json, ...)",
    summary: "Merges by overwriting: on a repeated key the last one wins. This is the merge you expect.",
    category: "JSON",
  },
  JSON_MERGE_PRESERVE: {
    signature: "JSON_MERGE_PRESERVE(json, ...)",
    summary: "Merges by **accumulating**: on a repeated key it builds an array with both values.",
    category: "JSON",
  },
  JSON_OBJECT: {
    signature: "JSON_OBJECT(key, value, ...)",
    summary: "Builds a JSON object. Arguments come in pairs.",
    category: "JSON",
  },
  JSON_OBJECTAGG: {
    signature: "JSON_OBJECTAGG(key, value)",
    summary: "Aggregates the group's rows into a JSON object.",
    category: "JSON",
  },
  JSON_OVERLAPS: {
    signature: "JSON_OVERLAPS(a, b)",
    summary: "Do the two documents share any element? MySQL 8.0.17+.",
    category: "JSON",
  },
  JSON_PRETTY: {
    signature: "JSON_PRETTY(json)",
    summary: "Formats it with indentation.",
    category: "JSON",
  },
  JSON_QUOTE: {
    signature: "JSON_QUOTE(str)",
    summary: "Turns a string into a JSON literal.",
    category: "JSON",
  },
  JSON_REMOVE: {
    signature: "JSON_REMOVE(json, path, ...)",
    summary: "Deletes the given paths.",
    category: "JSON",
  },
  JSON_REPLACE: {
    signature: "JSON_REPLACE(json, path, value, ...)",
    summary: "Writes only if the path **already** exists.",
    category: "JSON",
  },
  JSON_SEARCH: {
    signature: "JSON_SEARCH(json, 'one'|'all', search [, escape [, path ...]])",
    summary: "Path where a string appears. `search` accepts `LIKE` wildcards.",
    category: "JSON",
  },
  JSON_SET: {
    signature: "JSON_SET(json, path, value, ...)",
    summary: "Writes the path whether or not it exists. Returns the new JSON; **it does not modify the column**.",
    category: "JSON",
  },
  JSON_TABLE: {
    signature: "JSON_TABLE(json, path COLUMNS (...)) AS alias",
    summary: "Expands a JSON array as rows of a derived table. MySQL 8.0+.",
    category: "JSON",
  },
  JSON_TYPE: {
    signature: "JSON_TYPE(json)",
    summary: "The type as text: OBJECT, ARRAY, STRING, INTEGER, NULL…",
    category: "JSON",
  },
  JSON_UNQUOTE: {
    signature: "JSON_UNQUOTE(json)",
    summary: "Unquotes a JSON scalar. `->>` is `JSON_UNQUOTE(JSON_EXTRACT(...))`.",
    category: "JSON",
  },
  JSON_VALID: {
    signature: "JSON_VALID(str)",
    summary: "Is it well-formed JSON? 0 or 1.",
    category: "JSON",
  },
  JSON_VALUE: {
    signature: "JSON_VALUE(json, path [RETURNING type])",
    summary: "Extracts and unquotes in one step, with an optional return type. MySQL 8.0.21+.",
    category: "JSON",
  },

  // ----------------------------------------------------------------- aggregate
  AVG: {
    signature: "AVG(expr)",
    summary: "Average, ignoring NULLs.",
    category: "aggregate",
  },
  BIT_AND: {
    signature: "BIT_AND(expr)",
    summary: "Bitwise AND of every value.",
    category: "aggregate",
  },
  BIT_OR: {
    signature: "BIT_OR(expr)",
    summary: "Bitwise OR of every value.",
    category: "aggregate",
  },
  COUNT: {
    signature: "COUNT(expr | *)",
    summary: "Counts rows. `COUNT(col)` **skips NULLs** and `COUNT(*)` does not.",
    category: "aggregate",
  },
  GROUP_CONCAT: {
    signature: "GROUP_CONCAT([DISTINCT] expr [ORDER BY ...] [SEPARATOR ', '])",
    summary: "Concatenates the group's values. **Truncated at `group_concat_max_len`**, 1024 bytes by default.",
    category: "aggregate",
  },
  MAX: {
    signature: "MAX(expr)",
    summary: "The group's maximum.",
    category: "aggregate",
  },
  MIN: {
    signature: "MIN(expr)",
    summary: "The group's minimum.",
    category: "aggregate",
  },
  STDDEV: {
    signature: "STDDEV(expr)",
    summary: "Population standard deviation.",
    category: "aggregate",
  },
  SUM: {
    signature: "SUM(expr)",
    summary: "Sum, ignoring NULLs. With no rows it returns **NULL, not 0**.",
    category: "aggregate",
  },
  VARIANCE: {
    signature: "VARIANCE(expr)",
    summary: "Population variance.",
    category: "aggregate",
  },

  // -------------------------------------------------------------------- window
  CUME_DIST: {
    signature: "CUME_DIST() OVER (...)",
    summary: "Cumulative distribution, between 0 and 1.",
    category: "window",
  },
  DENSE_RANK: {
    signature: "DENSE_RANK() OVER (...)",
    summary: "Rank with ties and no gaps: 1, 1, 2.",
    category: "window",
  },
  FIRST_VALUE: {
    signature: "FIRST_VALUE(expr) OVER (...)",
    summary: "First value of the frame.",
    category: "window",
  },
  LAG: {
    signature: "LAG(expr [, offset [, default]]) OVER (...)",
    summary: "The value from an earlier row of the partition.",
    category: "window",
  },
  LAST_VALUE: {
    signature: "LAST_VALUE(expr) OVER (...)",
    summary: "Last value of the frame. With the default frame that is the current row, which is rarely what you want.",
    category: "window",
  },
  LEAD: {
    signature: "LEAD(expr [, offset [, default]]) OVER (...)",
    summary: "The value from a later row of the partition.",
    category: "window",
  },
  NTH_VALUE: {
    signature: "NTH_VALUE(expr, n) OVER (...)",
    summary: "The nth value of the frame.",
    category: "window",
  },
  NTILE: {
    signature: "NTILE(n) OVER (...)",
    summary: "Splits the rows into `n` groups.",
    category: "window",
  },
  PERCENT_RANK: {
    signature: "PERCENT_RANK() OVER (...)",
    summary: "Relative rank, between 0 and 1.",
    category: "window",
  },
  RANK: {
    signature: "RANK() OVER (...)",
    summary: "Rank with ties, leaving gaps: 1, 1, 3.",
    category: "window",
  },
  ROW_NUMBER: {
    signature: "ROW_NUMBER() OVER (...)",
    summary: "Row number within the partition, no ties.",
    category: "window",
  },

  // ---------------------------------------------------------------- conversion
  BIN: {
    signature: "BIN(n)",
    summary: "Binary representation.",
    category: "conversion",
  },
  CAST: {
    signature: "CAST(expr AS type)",
    summary: "Converts type: `CAST(x AS DECIMAL(10,2))`, `CAST(x AS CHAR)`.",
    category: "conversion",
  },
  CONVERT: {
    signature: "CONVERT(expr, type) | CONVERT(expr USING charset)",
    summary: "The same as `CAST` with different syntax, plus the form that changes character set.",
    category: "conversion",
  },
  OCT: {
    signature: "OCT(n)",
    summary: "Octal representation.",
    category: "conversion",
  },

  // --------------------------------------------------------------- information
  CONNECTION_ID: {
    signature: "CONNECTION_ID()",
    summary: "Id of the current connection.",
    category: "information",
  },
  CURRENT_USER: {
    signature: "CURRENT_USER()",
    summary: "The account it **authenticated** as, which may not be the one from `USER()`.",
    category: "information",
  },
  DATABASE: {
    signature: "DATABASE()",
    summary: "Database in use, or NULL if there is none.",
    category: "information",
  },
  FOUND_ROWS: {
    signature: "FOUND_ROWS()",
    summary: "Rows the last `SELECT` would have returned without `LIMIT`. Deprecated in MySQL 8.0.17.",
    category: "information",
  },
  LAST_INSERT_ID: {
    signature: "LAST_INSERT_ID([expr])",
    summary: "Last AUTO_INCREMENT generated **on this connection**. For a multi-row `INSERT` it returns the first.",
    category: "information",
  },
  ROW_COUNT: {
    signature: "ROW_COUNT()",
    summary: "Rows affected by the last statement. It is overwritten immediately, so capture it right away.",
    category: "information",
  },
  USER: {
    signature: "USER()",
    summary: "The connection's user and host, as it connected.",
    category: "information",
  },
  VERSION: {
    signature: "VERSION()",
    summary: "Server version.",
    category: "information",
  },

  // ---------------------------------------------------------------- encryption
  AES_DECRYPT: {
    signature: "AES_DECRYPT(cipher, key)",
    summary: "Decrypts `AES_ENCRYPT` output.",
    category: "encryption",
  },
  AES_ENCRYPT: {
    signature: "AES_ENCRYPT(str, key)",
    summary: "Encrypts with AES. Returns binary.",
    category: "encryption",
  },
  COMPRESS: {
    signature: "COMPRESS(str)",
    summary: "Compresses to binary. Needs a server built with zlib.",
    category: "encryption",
  },
  MD5: {
    signature: "MD5(str)",
    summary: "MD5 hash, 32 hex characters. Not suitable for passwords.",
    category: "encryption",
  },
  RANDOM_BYTES: {
    signature: "RANDOM_BYTES(n)",
    summary: "`n` cryptographically secure random bytes.",
    category: "encryption",
  },
  SHA1: {
    signature: "SHA1(str)",
    summary: "SHA-1 hash, 40 hex characters.",
    category: "encryption",
  },
  SHA2: {
    signature: "SHA2(str, length)",
    summary: "SHA-2 hash, with `length` one of 224, 256, 384 or 512.",
    category: "encryption",
  },
  UNCOMPRESS: {
    signature: "UNCOMPRESS(binary)",
    summary: "Undoes `COMPRESS`.",
    category: "encryption",
  },
  UUID: {
    signature: "UUID()",
    summary: "A v1 UUID as 36 characters of text.",
    category: "encryption",
  },

  // ---------------------------------------------------------------------- misc
  GET_LOCK: {
    signature: "GET_LOCK(name, timeout)",
    summary: "Takes a named lock. 1 if it got it.",
    category: "misc",
  },
  RELEASE_LOCK: {
    signature: "RELEASE_LOCK(name)",
    summary: "Releases a `GET_LOCK` lock.",
    category: "misc",
  },
  SLEEP: {
    signature: "SLEEP(seconds)",
    summary: "Waits and returns 0. Blocks the connection.",
    category: "misc",
  },
};

/**
 * Keyed by the upper-case name, which is also each entry's own spelling — so a lookup and an
 * enumeration agree on what a function is called without the name being written twice.
 */
export const FUNCTIONS: ReadonlyMap<string, BuiltinFunction> = new Map(
  Object.entries(CATALOG).map(([name, entry]) => [name, { name, ...entry }]),
);

/** A built-in by name, however it was capitalised where it was written. */
export function builtin(name: string): BuiltinFunction | undefined {
  return FUNCTIONS.get(name.toUpperCase());
}
