import type { RuntimeCommand } from "../../types.js";
import { createChecksumCommand } from "./checksum.js";

export const sha1sumCommand: RuntimeCommand = createChecksumCommand(
  "sha1sum",
  "sha1",
  "compute SHA1 message digest",
);
