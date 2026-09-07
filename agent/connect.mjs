import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runnerEnvironment } from "./environment.mjs";

// Foreground launcher: only this fixed Node entrypoint, never a shell or server command.
const child = spawn(process.execPath, [fileURLToPath(new URL("./session.mjs", import.meta.url)), ...process.argv.slice(2)], {
  env: runnerEnvironment(), stdio: ["inherit","inherit","inherit","ipc"], windowsHide: true
});
let timer;
const stop = () => {
  if (!child.connected || timer) return;
  child.send("STOP");
  timer = setTimeout(() => { console.error("RUNNER_SHUTDOWN_TIMEOUT"); child.kill("SIGKILL"); }, 7000);
};
process.once("SIGINT", stop); process.once("SIGTERM", stop);
child.once("error", () => { console.error("RUNNER_START_FAILED"); process.exitCode = 1; });
child.once("exit", (code, signal) => {
  clearTimeout(timer); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
  process.exitCode = signal === null && code === 0 ? 0 : 1;
});
