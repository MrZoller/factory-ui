import { describe, expect, test } from "bun:test";

import { serviceName } from "./index";

describe("factory-ui", () => {
  test("exports its service name", () => {
    expect(serviceName).toBe("factory-ui");
  });
});
