// Creates examples/shop.db from seed.sql:  node examples/make-db.ts
import { DatabaseSync } from "node:sqlite";
import { readFileSync, rmSync } from "node:fs";
const here = new URL(".", import.meta.url).pathname;
rmSync(here + "shop.db", { force: true });
const db = new DatabaseSync(here + "shop.db");
db.exec(readFileSync(here + "seed.sql", "utf8"));
db.close();
console.log("wrote examples/shop.db");
