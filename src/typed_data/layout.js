import { readFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { CODECS } from "./codecs.js";
import { TData } from "./TData.js";
import { build_structure, validate_structure, TYPE_BITS } from "./structure.js";

/** Compiled layouts, keyed by the expanded structure they were compiled from. */
const layout_cache = new WeakMap();
const EMPTY_STRUCT = Object.freeze({ name: "EMPTY", length: 0, items: Object.freeze([]) });

let tdata_probe = null;
// a tag name must not shadow a member of TData: its accessor would hide the member
function is_reserved_name(name) {
	tdata_probe ??= new TData(EMPTY_STRUCT, "probe");
	return name in tdata_probe;
}

/**
 * Compiles an expanded structure (the result of build_structure) into a Layout
 * (doc/design-scan.md 2.2). The same structure object is compiled only once.
 * Throws on an unknown type, a duplicated name or a name colliding with a
 * TData member; the other layout rules are checked by validate_structure.
 *
 * @param {{name: string, length: number, items: Object[]}} data_struct
 * @return {Object} The Layout: name, length, items, size, entries, tags_at_byte, Data_Class.
 */
export function layout_of(data_struct) {
	const cached = layout_cache.get(data_struct);
	if (cached) return cached;

	const size = data_struct.length >> 3;
	const entries = new Map();
	const tags_at_byte = Array.from({ length: size }, () => []);
	for (const item of data_struct.items) {
		const { name, offset, init_value } = item;
		const type = item.type.toLowerCase();
		const codec = CODECS[type];
		if (!codec) throw new Error(`${data_struct.name}.${name}: unknown tag type ${item.type}`);
		if (entries.has(name)) throw new Error(`${data_struct.name}.${name}: duplicated tag name`);
		if (is_reserved_name(name)) throw new Error(`${data_struct.name}.${name}: tag name collides with a TData member`);
		const byte = offset >> 3;
		const entry = {
			name, type, init_value, byte,
			size: codec.size,
			mask: type === "bool" ? 1 << (offset % 8) : 0xff,
			codec,
			item,
		};
		entries.set(name, entry);
		// entries keep the item order: a combined word comes before its bits
		for (let i = byte; i < byte + codec.size && i < size; i++) tags_at_byte[i].push(entry);
	}

	const Data_Class = class extends TData { };
	Object.defineProperty(Data_Class, "name", { value: `TData_${data_struct.name}` });
	for (const entry of entries.values()) {
		const { codec, byte, mask } = entry;
		Object.defineProperty(Data_Class.prototype, entry.name, {
			get() { return codec.get(this.buffer, byte, mask); },
			set(value) {
				codec.set(this.buffer, byte, mask, value);
				this.after_write(entry);
			},
			enumerable: true,
			configurable: false,
		});
	}

	const layout = Object.freeze({
		name: data_struct.name,
		length: data_struct.length,
		items: data_struct.items,
		size,
		entries,
		tags_at_byte,
		Data_Class,
	});
	Data_Class.layout = layout;
	layout_cache.set(data_struct, layout);
	return layout;
}

/**
 * Resolves the fragment references of a list of items: `coupling` and
 * `includes` given as a fragment name are replaced by a copy of that
 * fragment, recursively. Omitted lengths are filled in from the type.
 */
function resolve_items(list, fragments, stack, where, errors) {
	if (!Array.isArray(list)) {
		errors.push(`${where}: expected a list of items`);
		return [];
	}
	const resolve_ref = (ref, field) => {
		if (Array.isArray(ref)) return resolve_items(ref, fragments, stack, where, errors);
		if (typeof ref !== "string") {
			errors.push(`${where}: ${field} must be a fragment name or a list of items`);
			return [];
		}
		if (stack.includes(ref)) {
			errors.push(`${where}: circular fragment reference ${[...stack, ref].join(" -> ")}`);
			return [];
		}
		if (!Object.hasOwn(fragments, ref)) {
			errors.push(`${where}: unknown fragment ${ref}`);
			return [];
		}
		return resolve_items(fragments[ref], fragments, [...stack, ref], `fragment ${ref}`, errors);
	};
	return list.map((_item) => {
		const item = { ..._item };
		if (item.coupling !== undefined) item.coupling = resolve_ref(item.coupling, "coupling");
		if (item.includes !== undefined) item.includes = resolve_ref(item.includes, "includes");
		const bits = TYPE_BITS[item.type?.toLowerCase()];
		if (item.length === undefined && bits !== undefined) item.length = bits;
		return item;
	});
}

/**
 * Reads the layout description file (doc/design-scan.md 2.1) and compiles
 * every layout in it. The root key `layouts` maps layout names to item
 * lists; every other root key is a fragment referenced by name.
 *
 * @param {string} yaml_path - Path of the YAML layout file.
 * @return {{layouts: Object<string, Object>, fragments: Object<string, Object[]>}}
 * @throws {Error} With `errors`, every violation found, when the file is not valid.
 */
export function compile_layout(yaml_path) {
	const fail = (errors) => {
		const error = new Error(`invalid layout file ${yaml_path}:\n${errors.join("\n")}`);
		error.errors = errors;
		throw error;
	};
	const doc = parseDocument(readFileSync(yaml_path, "utf8"), { version: "1.2" });
	if (doc.errors.length > 0) fail(doc.errors.map((e) => e.message));
	const root = doc.toJS();
	if (root === null || typeof root !== "object" || Array.isArray(root)) fail(["the root must be a mapping"]);
	const { layouts: layout_defs, ...fragment_defs } = root;
	if (layout_defs === null || typeof layout_defs !== "object" || Array.isArray(layout_defs)) {
		fail(["the root key `layouts` must map layout names to item lists"]);
	}

	const errors = [];
	const fragments = {};
	for (const [name, list] of Object.entries(fragment_defs)) {
		fragments[name] = resolve_items(list, fragment_defs, [name], `fragment ${name}`, errors);
	}
	const structs = {};
	for (const [name, list] of Object.entries(layout_defs)) {
		const items = resolve_items(list, fragment_defs, [], `layout ${name}`, errors);
		structs[name] = build_structure({ name }, items);
	}
	if (errors.length === 0) {
		for (const struct of Object.values(structs)) errors.push(...validate_structure(struct));
	}
	if (errors.length > 0) fail(errors);

	const layouts = {};
	for (const [name, struct] of Object.entries(structs)) layouts[name] = layout_of(struct);
	return { layouts, fragments };
}
