import type { RuntimeCommand } from "../../types.js";
import { createChecksumCommand } from "./checksum.js";

export const sha256sumCommand: RuntimeCommand = createChecksumCommand(
  "sha256sum",
  "sha256",
  "compute SHA256 message digest",
);
