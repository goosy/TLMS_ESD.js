// The data block layouts of the controller, compiled from layouts.yaml
// (doc/design-scan.md 2.1). The file sits next to this module in the source
// tree and next to main.js in the build output.
import { join } from "node:path";
import { compile_layout } from "./typed_data/layout.js";
import { logger } from "./util.js";

export const layouts_file = join(import.meta.dirname, "layouts.yaml");

let compiled;
try {
	compiled = compile_layout(layouts_file);
} catch (e) {
	// an invalid layout is a program error: refuse to start (doc/spec.md 3.6)
	for (const error of e.errors ?? [e.message]) logger.error(`invalid layout: ${error}`);
	process.exit(1);
}

export const { LINE, SECTION, NODE, COMMAND, RECORD } = compiled.layouts;

/** The items of the node parameter block, with offsets relative to the block. */
export const node_parameters = compiled.fragments.node_parameters;
