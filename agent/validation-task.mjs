import { Worker } from "node:worker_threads";
import { runnerEnvironment } from "./environment.mjs";
import { RunnerError } from "./transport.mjs";

export function validationTask(spec, attempt, { signal, timeoutMs = 30000 } = {}) {
  signal?.throwIfAborted();
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new RunnerError("INVALID_DEADLINE");
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./validation-worker.mjs", import.meta.url), {
      workerData: { spec, attempt }, env: runnerEnvironment(), execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 }, stdout: true, stderr: true
    });
    let message; let failure;
    const abort = () => { failure = new RunnerError("VALIDATION_CANCELLED"); void worker.terminate(); };
    const timer = setTimeout(() => { failure = new RunnerError("VALIDATION_TIMEOUT"); void worker.terminate(); }, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    worker.stdout.resume(); worker.stderr.resume();
    worker.on("message", (value) => { if (message) failure = new RunnerError("INVALID_WORKER_RESULT"); message = value; });
    worker.on("error", () => { failure = new RunnerError("VALIDATOR_FAILED"); });
    worker.once("exit", (code) => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (failure || code !== 0 || !message?.report || message.error) reject(failure ?? new RunnerError("VALIDATOR_FAILED"));
      else resolve(message.report);
    });
    if (signal?.aborted) abort();
  });
}
