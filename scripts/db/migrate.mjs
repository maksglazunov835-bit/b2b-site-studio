import { pathToFileURL } from "node:url";

import { runMigrations, safeDatabaseCommandError } from "./migration-lib.mjs";

export async function main() {
  const result = await runMigrations();
  for (const name of result.applied) console.log(`applied ${name}`);
  for (const name of result.skipped) console.log(`already applied ${name}`);
  console.log(`MIGRATION_SUMMARY ${JSON.stringify({ applied: result.applied.length, skipped: result.skipped.length })}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(safeDatabaseCommandError(error));
    process.exitCode = 1;
  });
}
