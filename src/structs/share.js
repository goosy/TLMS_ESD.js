import { TData } from "../typed_data/TData.js";

export const node_commands = [
	{ name: "stop_pumps", type: "Bool", offset: 8, length: 1, init_value: false }, // Stop pump command
	{ name: "cancel_stop", type: "Bool", offset: 9, length: 1, init_value: false }, // Cancel stop pump
	{ name: "horn", type: "Bool", offset: 10, length: 1, init_value: false }, // Output alarm
	{ name: "reset_horn", type: "Bool", offset: 11, length: 1, init_value: false }, // Stop alarm
	{ name: "enable_pressure_SD", type: "Bool", offset: 12, length: 1, init_value: false }, // Set pressure linked pump stop
	{ name: "disable_pressure_SD", type: "Bool", offset: 13, length: 1, init_value: false }, // Cancel pressure linked pump stop
	{ name: "read_paras", type: "Bool", offset: 14, length: 1, init_value: false }, // Read all parameters
	{ name: "write_paras", type: "Bool", offset: 15, length: 1, init_value: false }, // Write parameter command
	{ name: "enable_pressure_alarm", type: "Bool", offset: 0, length: 1, init_value: false }, // Allow pressure alarm
	{ name: "disable_pressure_alarm", type: "Bool", offset: 1, length: 1, init_value: false }, // Disable pressure alarm
	{ name: "enable", type: "Bool", offset: 2, length: 1, init_value: false }, // Allow the node to work
	{ name: "disable", type: "Bool", offset: 3, length: 1, init_value: false }, // Disable the node
	{ name: "reset_CPU", type: "Bool", offset: 4, length: 1, init_value: false }, // Reset CPU
	{ name: "reset_conn", type: "Bool", offset: 5, length: 1, init_value: false }, // Reset connection
	{ name: "reserve", type: "Bool", offset: 6, length: 1, init_value: false }, // Reserve
	{ name: "executing", type: "Bool", offset: 7, length: 1, init_value: false }, // Executing
];

export const node_parameters = [
	{ name: "temperature_zero_raw", type: "Int", offset: 0, length: 16, init_value: 0 }, // Raw temperature zero point
	{ name: "temperature_span_raw", type: "Int", offset: 16, length: 16, init_value: 27648 }, // Raw temperature range
	{ name: "temperature_underflow", type: "Int", offset: 32, length: 16, init_value: -500 }, // Temperature underflow setting value
	{ name: "temperature_overflow", type: "Int", offset: 48, length: 16, init_value: 28000 }, // Temperature overflow setting value
	{ name: "temperature_zero", type: "Real", offset: 64, length: 32, init_value: 0 }, // Temperature zero point
	{ name: "temperature_span", type: "Real", offset: 96, length: 32, init_value: 100 }, // Temperature range
	{ name: "temperature_AH", type: "Real", offset: 128, length: 32, init_value: 0 }, // Temperature AH value
	{ name: "temperature_WH", type: "Real", offset: 160, length: 32, init_value: 0 }, // Temperature WH value
	{ name: "temperature_WL", type: "Real", offset: 192, length: 32, init_value: 0 }, // Temperature WL value
	{ name: "temperature_AL", type: "Real", offset: 224, length: 32, init_value: 0 }, // Temperature AL value
	{ name: "temperature_DZ", type: "Real", offset: 256, length: 32, init_value: 0.5 }, // Temperature comparison dead zone
	{ name: "temperature_FT", type: "UDInt", offset: 288, length: 32, init_value: 0 }, // Temperature comparison fault tolerance time
	{ name: "pressure_zero_raw", type: "Int", offset: 320, length: 16, init_value: 0 }, // Raw pressure zero point
	{ name: "pressure_span_raw", type: "Int", offset: 336, length: 16, init_value: 27648 }, // Raw pressure range
	{ name: "pressure_underflow", type: "Int", offset: 352, length: 16, init_value: -500 }, // Pressure underflow setting value
	{ name: "pressure_overflow", type: "Int", offset: 368, length: 16, init_value: 28000 }, // Pressure overflow setting value
	{ name: "pressure_zero", type: "Real", offset: 384, length: 32, init_value: 0 }, // Pressure zero point
	{ name: "pressure_span", type: "Real", offset: 416, length: 32, init_value: 4 }, // Pressure range
	{ name: "pressure_AH", type: "Real", offset: 448, length: 32, init_value: 0 }, // Pressure AH value
	{ name: "pressure_WH", type: "Real", offset: 480, length: 32, init_value: 0 }, // Pressure WH value
	{ name: "pressure_WL", type: "Real", offset: 512, length: 32, init_value: 0 }, // Pressure WL value
	{ name: "pressure_AL", type: "Real", offset: 544, length: 32, init_value: 0 }, // Pressure AL value
	{ name: "pressure_DZ", type: "Real", offset: 576, length: 32, init_value: 0.05 }, // Pressure comparison dead zone
	{ name: "pressure_FT", type: "UDInt", offset: 608, length: 32, init_value: 0 }, // Pressure comparison fault tolerance time
	{ name: "reserve1", type: "Real", offset: 640, length: 32, init_value: 0 }, // Reserve 1
	{ name: "reserve2", type: "Real", offset: 672, length: 32, init_value: 0 }, // Reserve 2
	{ name: "reserve3", type: "Real", offset: 704, length: 32, init_value: 0 }, // Reserve 3
	{ name: "invalid_value_of_AI", type: "Real", offset: 736, length: 32, init_value: -100000.0 }, // Value when AI is invalid
	{ name: "delay_protect_time", type: "UDInt", offset: 768, length: 32, init_value: 5000 }, // Communication interrupt delay protection time
	{ name: "flow_smooth_factor", type: "Real", offset: 800, length: 32, init_value: 0.9 }, // Flow smoothing factor
	{ name: "equS1", type: "DInt", offset: 832, length: 32, init_value: 10000 }, // Flow 1 equivalent value
	{ name: "equS2", type: "DInt", offset: 864, length: 32, init_value: 10000 }, // Flow 2 equivalent value
	{ name: "equS3", type: "DInt", offset: 896, length: 32, init_value: 10000 }, // Flow 3 equivalent value
	{ name: "equS4", type: "DInt", offset: 928, length: 32, init_value: 10000 }, // Flow 4 equivalent value
	{ name: "equS5", type: "DInt", offset: 960, length: 32, init_value: 10000 }, // Flow 5 equivalent value
	{ name: "pump_change_delay", type: "UDInt", offset: 992, length: 32, init_value: 180000 }, // Pump operation delay
];

export const command_code = { none: 0 };
for (const item of node_commands) {
	command_code[item.name] = 1 << item.offset;
}

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
	}
	item.coupling = coupling.map((item) => item.name);
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
const TYPE_BITS = {
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
