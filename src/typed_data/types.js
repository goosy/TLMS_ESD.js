// Renders TypeScript declarations of compiled layouts, for editor completion
// of the tag accessors (doc/design-scan.md 2.4).

/** `NODE` -> `Node`, `my_block` -> `My_Block` */
function type_name(layout_name) {
	return layout_name
		.split("_")
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
		.join("_");
}

/**
 * Renders a declaration file with one interface per layout (`<Name>_Data`,
 * one property per tag) and the data block type (`<Name>_TData`).
 *
 * @param {Object<string, {items: Object[]}>} layouts - Compiled layouts by name.
 * @param {Object} options
 * @param {string} options.source - The layout file, named in the header.
 * @param {string} options.tdata_module - Module specifier of TData, relative to the output file.
 * @return {string}
 */
export function render_types(layouts, { source, tdata_module }) {
	const lines = [
		`// Generated from ${source} by \`pnpm gen:types\`. Do not edit.`,
		`import type { TData } from "${tdata_module}";`,
	];
	for (const [name, layout] of Object.entries(layouts)) {
		const base = type_name(name);
		lines.push("", `/** Tags of the ${name} data block. */`, `export interface ${base}_Data {`);
		for (const item of layout.items) {
			if (item.comment) lines.push(`\t/** ${item.comment} */`);
			const ts_type = item.type.toLowerCase() === "bool" ? "boolean" : "number";
			lines.push(`\t${item.name}: ${ts_type};`);
		}
		lines.push("}", `export type ${base}_TData = TData & ${base}_Data;`);
	}
	return `${lines.join("\n")}\n`;
}
