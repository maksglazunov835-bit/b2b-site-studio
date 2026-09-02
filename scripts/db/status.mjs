import { pathToFileURL } from "node:url";

import { getMigrationStatus, safeDatabaseCommandError } from "./migration-lib.mjs";

export async function main() {
  const status = await getMigrationStatus();
  for (const migration of status) {
    console.log(`${migration.state.padEnd(17)} ${migration.name}`);
  }
  const invalid = status.filter((migration) => migration.state !== "applied");
  console.log(`MIGRATION_STATUS ${JSON.stringify({ total: status.length, applied: status.length - invalid.length })}`);
  if (invalid.length > 0) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(safeDatabaseCommandError(error));
    process.exitCode = 1;
  });
}
