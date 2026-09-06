import { PersistenceError } from "../persistence/errors.mjs";
import { runtime } from "../persistence/runtime.mjs";

export function assertPersistenceAccess() {
  if (!runtime.localListener || runtime.stopping) {
    throw new PersistenceError("PERSISTENCE_DISABLED", "Persistence API is disabled for this server.", { status: 403 });
  }
}
