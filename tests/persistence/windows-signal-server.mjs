await import("../../server/production.mjs");
process.once("message", () => {
  process.disconnect();
  process.emit("SIGTERM");
});
