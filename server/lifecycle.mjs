import { closeDatabasePool } from "./persistence/database.mjs";
import { runtime } from "./persistence/runtime.mjs";

export function installLifecycle(server) {
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.once("listening", () => {
    const address = server.address();
    runtime.localListener = process.env.PERSISTENCE_MODE === "local" &&
      typeof address === "object" && address !== null &&
      ["127.0.0.1", "::1"].includes(address.address);
  });
  let shutdownPromise;
  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    runtime.stopping = true;
    runtime.localListener = false;
    shutdownPromise = (async () => {
      let drainTimer;
      const deadline = setTimeout(() => process.exit(1), 8000);
      try {
        await new Promise((resolve) => {
          server.close(resolve);
          server.closeIdleConnections();
          drainTimer = setTimeout(() => {
            for (const socket of sockets) socket.destroy();
          }, 4000);
        });
        clearTimeout(drainTimer);
        await closeDatabasePool();
        console.log("SERVER_SHUTDOWN_COMPLETE");
        process.exitCode = 0;
      } catch {
        process.exitCode = 1;
      } finally {
        clearTimeout(drainTimer);
        clearTimeout(deadline);
        process.removeListener("SIGTERM", shutdown);
        process.removeListener("SIGINT", shutdown);
      }
    })();
    return shutdownPromise;
  }
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
