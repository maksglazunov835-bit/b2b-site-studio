import { readFile, writeFile } from "node:fs/promises";
import { installedManifest } from "./execution-manifest.mjs";
const target = new URL("../../server/execution/validator-manifest.json", import.meta.url);
const text = JSON.stringify(await installedManifest(), null, 2) + "\n";
if (process.argv.includes("--check")) {
  if ((await readFile(target, "utf8")).replaceAll("\r\n", "\n") !== text) throw new Error("Built-in validator manifest is stale.");
  console.log("EXECUTION_VALIDATOR_MANIFEST current");
} else {
  await writeFile(target, text);
  console.log("EXECUTION_VALIDATOR_MANIFEST generated");
}
