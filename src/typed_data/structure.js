// Expansion and validation of data block structures (doc/spec.md 3.6,
// doc/design.md 3.1). Part of the data layer: no dependency on the controller.
import { TData } from "./TData.js";

function add_item(data_struct, item, base_offset, name_prefix) {
	const items = data_struct.items;
	// duplicated names are kept and reported by validate_structure
	if (item.name) items.push(item);
	if (name_prefix) item.name = name_prefix + item.name;

	item.offset = item.offset + base_offset;
	const length = item.offset + item.length;
	if (data_struct.length < length) data_struct.length = length;

	const includes = item.includes;
	if (includes && Array.isArray(includes)) {
		for (const _item of includes) {
			add_item(data_struct, { ..._item }, item.offset, item.name_prefix);
		}
		// The "includes" and "coupling" attributes can only be chosen one at a time.
		return;
	}

	const coupling = [];
	const _coupling = item.coupling;
	if (_coupling && Array.isArray(_coupling)) {
		for (const _cp of _coupling) {
			const cp = { ..._cp };
			add_item(data_struct, cp, item.offset, item.name_prefix);
			cp.coupling ??= [];
			cp.coupling.push(item.name);
			coupling.push(cp);
		}
		share_init_value(item, coupling);
	}
	item.coupling = coupling.map((item) => item.name);
}

// Items whose init_value is given both on the word and on some of its bits,
// with the names of those bits; reported by validate_structure.
const init_conflicts = new WeakMap();

/**
 * Only one side of a combined word gives the init values (doc/spec.md 3.6):
 * either the word, whose bits then take theirs from it, or the bits, from
 * which the word is composed (a bit without init_value is false).
 */
function share_init_value(word, bits) {
	const given = bits.filter((bit) => bit.init_value !== undefined);
	if (word.init_value !== undefined && given.length > 0) {
		// keep the given values (the bits are written after the word) and
		// report the conflict; the other bits still take theirs from the word
		init_conflicts.set(word, given.map((bit) => bit.name));
	}
	const size = word.length >> 3;
	// big-endian word: byte k of the word holds bits (size - 1 - k) * 8 ..
	// a bit outside the word has no value in it (reported by validate_structure)
	const bit_value = (bit) => {
		const relative = bit.offset - word.offset;
		if (!(relative >= 0 && relative < word.length)) return 0;
		return 2 ** ((size - 1 - (relative >> 3)) * 8 + relative % 8);
	};
	if (word.init_value === undefined) {
		word.init_value = 0;
		for (const bit of bits) {
			bit.init_value ??= false;
			if (bit.init_value === true) word.init_value += bit_value(bit);
		}
		return;
	}
	if (typeof word.init_value !== "number") return;
	for (const bit of bits) {
		if (bit.init_value !== undefined) continue;
		const value = bit_value(bit);
		bit.init_value = value > 0 && Math.floor(word.init_value / value) % 2 === 1;
	}
}

export function build_structure(data_struct, items) {
	data_struct.length = 0;
	data_struct.items = [];
	if (!items) return;
	for (const item of items) {
		add_item(data_struct, item, 0);
	}
	return data_struct;
}

// bit length of each tag type
export const TYPE_BITS = {
	bool: 1,
	byte: 8, sint: 8, usint: 8,
	int: 16, uint: 16, word: 16,
	dint: 32, udint: 32, dword: 32, real: 32,
};

// value range of each integer type
const INTEGER_RANGES = {
	byte: [0, 0xff], usint: [0, 0xff], sint: [-0x80, 0x7f],
	int: [-0x8000, 0x7fff], uint: [0, 0xffff], word: [0, 0xffff],
	dint: [-0x80000000, 0x7fffffff], udint: [0, 0xffffffff], dword: [0, 0xffffffff],
};

let tdata_probe = null;
// A tag name must not shadow any member of a TData instance.
function is_reserved_name(name) {
	tdata_probe ??= new TData({ length: 0, items: [] }, "probe");
	return name in tdata_probe;
}

function check_init_value(item, type) {
	const value = item.init_value;
	if (type === "bool") return typeof value === "boolean";
	if (typeof value !== "number") return false;
	if (type === "real") return !Number.isNaN(value) && Math.abs(value) <= 3.4028234663852886e38;
	const [min, max] = INTEGER_RANGES[type];
	return Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Validates a structure built by build_structure against the layout rules
 * (doc/spec.md section 3.6, doc/design.md section 3.1).
 *
 * @param {{name: string, length: number, items: Object[]}} data_struct
 * @returns {string[]} descriptions of all violations, empty when the layout is valid
 */
export function validate_structure(data_struct) {
	const errors = [];
	const struct_name = data_struct.name;
	const report = (item, message) => errors.push(`${struct_name}.${item.name}: ${message}`);
	const items = data_struct.items;

	// names
	const by_name = new Map();
	for (const item of items) {
		if (by_name.has(item.name)) report(item, "duplicated name");
		else by_name.set(item.name, item);
		if (is_reserved_name(item.name)) report(item, "name collides with a TData member");
	}

	// type, length, alignment and init_value
	const valid_items = [];
	for (const item of items) {
		const type = item.type?.toLowerCase();
		if (!(type in TYPE_BITS)) {
			report(item, `unknown type ${item.type}`);
			continue;
		}
		if (item.length !== TYPE_BITS[type]) {
			report(item, `length ${item.length} does not match type ${item.type}`);
		}
		if (type !== "bool") {
			if (item.offset % 8 !== 0) {
				report(item, `offset ${item.offset} is not on a byte boundary`);
			} else if (TYPE_BITS[type] > 8 && (item.offset >> 3) % 2 !== 0) {
				report(item, `byte offset ${item.offset >> 3} is not even`);
			}
		}
		const conflict = init_conflicts.get(item);
		if (conflict) {
			report(item, `init_value is given both on the word and on its bits ${conflict.join(", ")}`);
		}
		if (!check_init_value(item, type)) {
			report(item, `init_value ${item.init_value} is not valid for type ${item.type}`);
		}
		valid_items.push({ item, type, end: item.offset + TYPE_BITS[type] });
	}

	// non-Bool tags must not overlap
	const words = valid_items
		.filter(({ type }) => type !== "bool")
		.sort((a, b) => a.item.offset - b.item.offset);
	let last = null;
	for (const word of words) {
		if (last && word.item.offset < last.end) {
			report(word.item, `overlaps ${last.item.name}`);
		}
		if (!last || word.end > last.end) last = word;
	}

	// each bit belongs to at most one Bool, and a Bool inside a non-Bool tag
	// must be one of its coupled bits
	const bits = new Map();
	for (const { item, type } of valid_items) {
		if (type !== "bool") continue;
		const other = bits.get(item.offset);
		if (other) report(item, `shares bit ${item.offset} with ${other.name}`);
		else bits.set(item.offset, item);
		for (const word of words) {
			if (item.offset < word.item.offset || item.offset >= word.end) continue;
			if (!item.coupling?.includes(word.item.name)) {
				report(item, `lies inside ${word.item.name} but is not one of its coupled bits`);
			}
		}
	}

	// coupled bits of a combined tag must lie inside it
	for (const { item, type, end } of valid_items) {
		if (type === "bool" || !item.coupling?.length) continue;
		for (const bit_name of item.coupling) {
			const bit = by_name.get(bit_name);
			if (!bit) {
				report(item, `coupled bit ${bit_name} does not exist`);
			} else if (bit.type?.toLowerCase() !== "bool") {
				report(item, `coupled tag ${bit_name} is not a Bool`);
			} else if (bit.offset < item.offset || bit.offset >= end) {
				report(item, `coupled bit ${bit_name} lies outside it`);
			}
		}
	}

	// whole registers
	if (data_struct.length % 16 !== 0) {
		errors.push(`${struct_name}: length ${data_struct.length} bits is not a whole number of registers`);
	}

	return errors;
}
