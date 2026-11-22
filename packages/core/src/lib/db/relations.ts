import { defineRelations } from "drizzle-orm";
import * as schema from "./schema";

/** Relational-query (RQB v2) config: every core table, no relations between them. */
export const relations = defineRelations(schema);
