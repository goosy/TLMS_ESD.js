// Writes src/layout_types.d.ts from src/layouts.yaml.
// Run: pnpm gen:types
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { get_layout, register_layout, render_types } from "modbus-emulator";
import { layouts_file } from "../src/layouts.js";

export const types_file = join(import.meta.dirname, "../src/layout_types.d.ts");

/** The declarations of the controller layouts. */
export async function controller_types() {
	register_layout(layouts_file);
	const names = ["LINE", "SECTION", "NODE", "COMMAND", "RECORD"];
	return render_types(
		Object.fromEntries(names.map((name) => [name, get_layout(name)])),
		{ source: "src/layouts.yaml", ldata_module: "modbus-emulator" },
	);
}

if (process.argv[1] === import.meta.filename) {
	writeFileSync(types_file, await controller_types());
}
