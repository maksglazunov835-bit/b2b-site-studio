import { main } from "../../agent/session.mjs";
// Test-only relay: Windows TerminateProcess cannot deliver POSIX signals.
process.on("message", (value) => { if (value === "SIGINT" || value === "SIGTERM") process.emit(value); });
await main();
