// Writes src/layout_types.d.ts from src/layouts.yaml.
// Run: pnpm gen:types
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { render_types } from "../src/typed_data/types.js";

export const types_file = join(import.meta.dirname, "../src/layout_types.d.ts");

/** The declarations of the controller layouts. */
export async function controller_types() {
	const structs = await import("../src/layouts.js");
	const { LINE, SECTION, NODE, COMMAND, RECORD } = structs;
	return render_types(
		{ LINE, SECTION, NODE, COMMAND, RECORD },
		{ source: "src/layouts.yaml", tdata_module: "./typed_data/TData.js" },
	);
}

if (process.argv[1] === import.meta.filename) {
	writeFileSync(types_file, await controller_types());
}
