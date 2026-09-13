import assert from "node:assert/strict";
import { test } from "node:test";

import { isDatabaseUnavailableError } from "../errors.js";

test("isDatabaseUnavailableError matches node-postgres codes and causes", () => {
  assert.equal(
    isDatabaseUnavailableError(
      Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }),
    ),
    true,
  );
  assert.equal(
    isDatabaseUnavailableError({
      message: "Failed query",
      cause: Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
      }),
    }),
    true,
  );
  assert.equal(isDatabaseUnavailableError(new Error("validation failed")), false);
});
