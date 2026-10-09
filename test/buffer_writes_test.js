import "./share.js"; // must be first: sets LOG_LEVEL
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

const SRC = join(import.meta.dirname, "../src");
// the data layer owns the buffer; the IO binding loads device data into it
const ALLOWED = [join(SRC, "typed_data"), join(SRC, "drivers", "binding.js")];

// writes to a `.buffer`: write methods, fill/set, indexed assignment, copy target
const WRITE_PATTERNS = [
	/\.buffer\.(write\w*|fill|set)\(/,
	/\.buffer\[[^\]]+\]\s*(=(?!=)|\|=|&=|\^=)/,
	/\.copy\(\s*[\w.]*\.buffer\b/,
];

function* source_files(dir) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (ALLOWED.some((allowed) => path === allowed || path.startsWith(`${allowed}/`) || path.startsWith(`${allowed}\\`))) continue;
		if (entry.isDirectory()) yield* source_files(path);
		else if (entry.name.endsWith(".js")) yield path;
	}
}

test("no code outside the data layer and the IO binding writes a data block buffer directly", () => {
	const offences = [];
	for (const file of source_files(SRC)) {
		readFileSync(file, "utf8").split("\n").forEach((line, index) => {
			if (WRITE_PATTERNS.some((pattern) => pattern.test(line))) {
				offences.push(`${relative(SRC, file)}:${index + 1}: ${line.trim()}`);
			}
		});
	}
	assert.deepEqual(offences, []);
});
