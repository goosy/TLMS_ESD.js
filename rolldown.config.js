import { readFileSync } from "node:fs";
import { defineConfig } from "rolldown";
import pkg from "./package.json" with { type: "json" };

// src/layouts.js reads layouts.yaml from its own directory, which is the
// directory of main.js once bundled: copy the layout file next to the bundle.
// It is emitted as a separate asset, not bundled into main.js.
const copy_layouts = {
	name: "copy-layouts",
	generateBundle() {
		this.emitFile({
			type: "asset",
			fileName: "layouts.yaml",
			source: readFileSync("src/layouts.yaml"),
		});
	},
};

export default defineConfig([{
	input: "src/main.js",
	platform: "node",
	plugins: [copy_layouts],
	output: {
		file: pkg.exports.default,
		format: "es",
	},
}, {
	input: "src/cli.js",
	platform: "node",
	output: {
		file: pkg.exports.cli,
		format: "es",
	},
	external: ["./main.js"],
}]);
