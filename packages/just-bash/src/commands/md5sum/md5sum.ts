import type { RuntimeCommand } from "../../types.js";
import { createChecksumCommand } from "./checksum.js";

export const md5sumCommand: RuntimeCommand = createChecksumCommand(
  "md5sum",
  "md5",
  "compute MD5 message digest",
);
