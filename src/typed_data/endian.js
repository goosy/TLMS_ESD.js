// Conversion between the device byte order of an IO buffer and the big-endian
// buffer of a TData, per layout entry (doc/spec.md 3.6). Device byte order acts
// per 16-bit register and per 32-bit value; the IO buffer is indexed like the
// TData buffer.

// Endians that swap the two bytes of a 16-bit register.
const BYTE_SWAP_ENDIANS = ["LE", "little", "BEBS"];

/**
 * Converts the endianness of a 2-byte value between the specified endian format and Big Endian (BE).
 *
 * This function performs bidirectional conversion:
 * - If the data is not in BE, it converts it to BE.
 * - If the data is in BE, it converts it to the specified endian format.
 *
 * @param {Buffer} buffer_from - The source buffer containing the data to be converted.
 * @param {Buffer} buffer_to - The destination buffer where the converted data will be written.
 * @param {number} index - The starting index in the buffers for the 2-byte value.
 * @param {string} endian - The endian format to convert to/from ('LE', 'little', 'BEBS', or 'BE').
 */
function convert_endian_2byte(buffer_from, buffer_to, index, endian) {
	switch (endian) {
		case "LE":
		case "little":
		case "BEBS": {  // BA
			buffer_to[index] = buffer_from[index + 1];
			buffer_to[index + 1] = buffer_from[index];
			break;
		}
		default: { // BE LEBS
			buffer_from.copy(buffer_to, index, index, index + 2);
		}
	}
}

/**
 * Converts the endianness of a 4-byte value between the specified endian format and Big Endian (BE).
 *
 * This function performs bidirectional conversion:
 * - If the data is not in BE, it converts it to BE.
 * - If the data is in BE, it converts it to the specified endian format.
 *
 * The function handles different endian formats:
 * - LE (Little Endian): DCBA <-> ABCD
 * - BEBS (Big Endian Byte Swap): BADC <-> ABCD
 * - LEBS (Little Endian Byte Swap): CDAB <-> ABCD
 *
 * @param {Buffer} buffer_from - The source buffer containing the data to be converted.
 * @param {Buffer} buffer_to - The destination buffer where the converted data will be written.
 * @param {number} index - The starting index in the buffers for the 4-byte value.
 * @param {string} endian - The endian format to convert to/from ('LE', 'little', 'BEBS', 'LEBS', or 'BE').
 */
function convert_endian_4bytes(buffer_from, buffer_to, index, endian) {
	switch (endian) {
		case "LE":
		case "little": { // DCBA <-> ABCD
			buffer_to[index] = buffer_from[index + 3];
			buffer_to[index + 1] = buffer_from[index + 2];
			buffer_to[index + 2] = buffer_from[index + 1];
			buffer_to[index + 3] = buffer_from[index];
			break;
		}
		case "BEBS": { // BADC <-> ABCD
			buffer_to[index] = buffer_from[index + 1];
			buffer_to[index + 1] = buffer_from[index];
			buffer_to[index + 2] = buffer_from[index + 3];
			buffer_to[index + 3] = buffer_from[index + 2];
			break;
		}
		case "LEBS": { // CDAB <-> ABCD
			buffer_to[index] = buffer_from[index + 2];
			buffer_to[index + 1] = buffer_from[index + 3];
			buffer_to[index + 2] = buffer_from[index];
			buffer_to[index + 3] = buffer_from[index + 1];
			break;
		}
		default: { // BE
			buffer_from.copy(buffer_to, index, index, index + 4);
		}
	}
}

/**
 * Index in a device-ordered IO buffer of the byte of a single-byte entry
 * (Bool, Byte, SInt, USInt): when the endian swaps the register bytes, the
 * byte sits in the other half of its register.
 */
export function io_index(byte, endian) {
	return BYTE_SWAP_ENDIANS.includes(endian) ? byte ^ 1 : byte;
}

/** Byte range [start, end) an entry occupies in a device-ordered IO buffer. */
export function io_range(entry, endian) {
	const start = entry.size === 1 ? io_index(entry.byte, endian) : entry.byte;
	return { start, end: start + entry.size };
}

/**
 * Copies an entry from a device-ordered IO buffer into a big-endian buffer.
 * A Bool only changes its own bit. No change is detected here.
 */
export function load_entry(entry, io_buffer, buffer, endian) {
	const { byte, size, mask } = entry;
	if (entry.type === "bool") {
		const value = io_buffer[io_index(byte, endian)] & mask;
		buffer[byte] = value ? buffer[byte] | mask : buffer[byte] & ~mask;
	} else if (size === 1) {
		buffer[byte] = io_buffer[io_index(byte, endian)];
	} else if (size === 2) {
		convert_endian_2byte(io_buffer, buffer, byte, endian);
	} else {
		convert_endian_4bytes(io_buffer, buffer, byte, endian);
	}
}

/** Copies an entry from a big-endian buffer into a device-ordered IO buffer. */
export function store_entry(entry, buffer, io_buffer, endian) {
	const { byte, size, mask } = entry;
	if (entry.type === "bool") {
		const index = io_index(byte, endian);
		io_buffer[index] = buffer[byte] & mask ? io_buffer[index] | mask : io_buffer[index] & ~mask;
	} else if (size === 1) {
		io_buffer[io_index(byte, endian)] = buffer[byte];
	} else if (size === 2) {
		convert_endian_2byte(buffer, io_buffer, byte, endian);
	} else {
		convert_endian_4bytes(buffer, io_buffer, byte, endian);
	}
}
