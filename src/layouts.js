// The layout sources of the controller (doc/design.md 3.2). The file sits
// next to this module in the source tree and next to main.js in the build
// output. The layouts are registered by modbus-emulator when the upward
// emulator is created (src/upward.js); this module only reads the fragments
// that the code needs by name before that.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

export const layouts_file = join(import.meta.dirname, "layouts.yaml");

const description = parse(readFileSync(layouts_file, "utf8"), { version: "1.2" });

/** The items of the node parameter block, with offsets relative to the block. */
export const node_parameters = description.node_parameters;

/** The bits of a command word, with offsets relative to the word. */
export const node_commands = description.node_commands;
