import { describe, expect, it } from "vitest";
import { rethrowFatalExecutionError } from "./fatal-execution-error.js";
import {
  ExecutionAbortedError,
  ExecutionLimitError,
} from "./interpreter/errors.js";

describe("rethrowFatalExecutionError", () => {
  it("rethrows safety failures unchanged", () => {
    const limit = new ExecutionLimitError("test", "iterations");
    const aborted = new ExecutionAbortedError();

    expect(() => rethrowFatalExecutionError(limit)).toThrow(limit);
    expect(() => rethrowFatalExecutionError(aborted)).toThrow(aborted);
  });

  it("allows ordinary command errors to be handled", () => {
    expect(() =>
      rethrowFatalExecutionError(new Error("ordinary")),
    ).not.toThrow();
  });
});
