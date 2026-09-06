import "./local-env.mjs";

// This launcher always binds numeric loopback, including production builds.
process.env.HOST = "127.0.0.1";
process.env.PERSISTENCE_MODE = "local";
await import("../server/production.mjs");
