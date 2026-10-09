// The upward Modbus server side of the data layer (doc/design-scan.md 1.1):
// the unit map that places data blocks at unit ids and byte offsets, and the
// es-modbus server vector that serves them. Writes go through the TData
// write methods, so that changes are detected or notified by the TData.

const SILENT_LOGGER = { warn() { } };

const get_register_info = (addr, units) => {
	const byte_offset = addr * 2;
	for (const { tdata, start, offset, end } of units ?? []) {
		if (tdata.buffer && byte_offset >= start && byte_offset < end) {
			// return.offset: the index in the buffer
			return { tdata, offset: byte_offset + offset - start };
		}
	}
	return { tdata: null, offset: -1 };
};

const get_coil_info = (addr, units) => {
	const byte_offset = addr >> 3;
	const bit_offset = addr % 8;
	const bit_mask = 1 << bit_offset;
	for (const { tdata, start, offset, end } of units ?? []) {
		if (tdata.buffer && byte_offset >= start && byte_offset < end) {
			// return.offset: the index in the buffer
			return { tdata, offset: byte_offset + offset - start, bit_mask };
		}
	}
	return { tdata: null, offset: -1 };
};

/**
 * Creates the es-modbus server vector that serves the data blocks of a unit map.
 *
 * @param {Unit_Map} unit_map - The data blocks attached per unit id.
 * @param {Object} [options]
 * @param {{warn: (message: string) => void}} [options.logger] - Reports unmapped addresses; silent by default.
 * @return {Object} The vector: get_input_register, get_holding_register, set_register, get_coil, set_coil.
 */
export function create_vector(unit_map, { logger = SILENT_LOGGER } = {}) {
	// An unmapped address (e.g. the gap between the node data and command
	// blocks) reads as 0 and ignores writes, so that a block read by the HMI
	// spanning the gap still succeeds. Each one is logged once.
	const reported = new Set();
	const report_unmapped = (kind, addr, unit_id) => {
		const key = `${kind}:${unit_id}:${addr}`;
		if (reported.has(key)) return;
		reported.add(key);
		logger.warn(`unmapped ${kind} address ${addr} in unit ${unit_id}`);
	};

	const read_register = (kind) => (addr, unit_id) => {
		const { tdata, offset } = get_register_info(addr, unit_map[unit_id]);
		if (tdata == null) {
			report_unmapped(kind, addr, unit_id);
			return 0;
		}
		return tdata.buffer.readUInt16BE(offset);
	};

	const vector = {
		get_input_register: read_register("input register"),
		get_holding_register: read_register("holding register"),
		set_register: (addr, value, unit_id) => {
			const { tdata, offset } = get_register_info(addr, unit_map[unit_id]);
			if (tdata == null) {
				report_unmapped("holding register", addr, unit_id);
				return;
			}
			tdata.write_register(offset, value);
		},

		get_coil: (addr, unit_id) => {
			const { tdata, offset, bit_mask } = get_coil_info(addr, unit_map[unit_id]);
			if (tdata == null) {
				report_unmapped("coil", addr, unit_id);
				return false;
			}
			return (tdata.buffer.readUInt8(offset) & bit_mask) > 0;
		},

		set_coil: (addr, value, unit_id) => {
			const { tdata, offset, bit_mask } = get_coil_info(addr, unit_map[unit_id]);
			if (tdata == null) {
				report_unmapped("coil", addr, unit_id);
				return;
			}
			tdata.write_bit(offset, bit_mask, value);
		},
	};
	return vector;
}

export class Unit_Map {
	unit_ids = [];

	/**
	 * Attaches a unit to the unit map.
	 *
	 * @param {number} unit_id - The ID of the unit.
	 * @param {import('./TData.js').TData} tdata - The TData object that contains the data associated with the unit.
	 * @param {number} [start=0] - The starting index of the unit's data.
	 * @param {number} [offset=0] - The starting index of the TData object.
	 * @return {void} This function does not return anything.
	 */
	attach_unit(unit_id, tdata, start = 0, offset = 0) {
		if (this[unit_id] == null) {
			this.unit_ids.push(unit_id);
			this[unit_id] = [];
		}
		this[unit_id].push({
			tdata,
			start,
			offset,
			end: tdata.size - offset + start,
		});
	}
}
