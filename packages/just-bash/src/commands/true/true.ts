import type { ExecResult, RuntimeCommand } from "../../types.js";

export const trueCommand: RuntimeCommand = {
  name: "true",

  async execute(): Promise<ExecResult> {
    return { stdout: "", stderr: "", exitCode: 0 };
  },
};

export const falseCommand: RuntimeCommand = {
  name: "false",

  async execute(): Promise<ExecResult> {
    return { stdout: "", stderr: "", exitCode: 1 };
  },
};
