import { handleApi } from "./api.mjs";
import { PersistenceError } from "../persistence/errors.mjs";

// Trusted local UI is not a human login. Bearers are never operator authority.
export function handleOperatorApi(request, action, status = 200) {
  return handleApi(() => {
    if (request.headers.has("authorization") || request.headers.has("proxy-authorization")) {
      throw new PersistenceError("UNAUTHORIZED_OPERATOR", "Agent credentials cannot authorize local operator operations.", { status: 403 });
    }
    return action();
  }, status);
}
