import Database from "better-sqlite3";
const db = new Database(":memory:");
db.pragma("journal_mode = WAL");
console.log("WAL OK");
db.pragma("foreign_keys = ON");
console.log("FK OK");
