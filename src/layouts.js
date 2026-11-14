// The layout sources of the controller (doc/design.md 3.2). The file sits
// next to this module in the source tree and next to main.js in the build
// output. Its layouts are inlined in the emulator description that the
// controller generates (src/description.js); modbus-emulator registers them
// when it loads that description.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

export const layouts_file = join(import.meta.dirname, "layouts.yaml");

/** The layout-data scope of the controller layouts, named in the emulator description. */
export const LAYOUT_SCOPE = "tlms";

const description = parse(readFileSync(layouts_file, "utf8"), { version: "1.2" });

/** The layout description of the file: the layout names and the item tables. */
export const layout_description = { layouts: description.layouts, item_tables: description.item_tables };

/** The items of the node parameter block, with offsets relative to the block. */
export const node_parameters = description.item_tables.node_parameters;

/** The bits of a command word, with offsets relative to the word. */
export const node_commands = description.item_tables.node_commands;
