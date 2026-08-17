/** The MySQL dialect: the four engine-specific decisions, in one place. */

import type { ColumnType } from "../../model/table.ts";
import type { Dialect } from "../dialect.ts";
import { isKeyword } from "./keywords.ts";

export const mysql: Dialect = {
  id: "mysql",

  /**
   * MySQL compares identifiers case-insensitively whether or not they were quoted, so `quoted`
   * plays no part here. It is in the signature because Postgres folds only unquoted names, and
   * that is the case this seam exists for.
   */
  foldIdentifier(name) {
    return name.toLowerCase();
  },

  quoteIdentifier(name) {
    return "`" + name.replaceAll("`", "``") + "`";
  },

  isKeyword,

  /**
   * Matched against the type as written rather than against the parsed name: the two differ on
   * shapes like `national char(10)`, where the parsed type token is only `national` and the
   * question "is this text?" is answered by the rest of the line.
   */
  isTextType(type: ColumnType) {
    const low = type.raw.toLowerCase();
    return low.includes("char") || low.includes("text") || low.startsWith("enum") || low.startsWith("set");
  },
};

export { isKeyword, KEYWORDS } from "./keywords.ts";
