const key = Symbol.for("b2b.persistence.runtime");
// Shared by the bundled API and the Node listener lifecycle module.
export const runtime = globalThis[key] ??= {
  pool: undefined, databaseConfig: undefined, stopping: false, localListener: false
};
