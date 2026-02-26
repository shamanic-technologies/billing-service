import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sql } from "../src/db/index.js";

migrate(db, { migrationsFolder: "./drizzle" })
  .then(() => {
    console.log("Migrations complete");
    return sql.end();
  })
  .catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
