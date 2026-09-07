import { parentPort, workerData } from "node:worker_threads";
import { validationReport } from "../server/execution/contract.mjs";
try { parentPort.postMessage({ report: validationReport(workerData.spec, workerData.attempt) }); }
catch { parentPort.postMessage({ error: "VALIDATOR_FAILED" }); }
parentPort.close();
