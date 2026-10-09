import { EventEmitter } from "node:events";
import { logger } from "../util.js";
import { CODECS } from "./codecs.js";

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

export class TTag extends EventEmitter {
	name;
	type;
	value;
	buffer;
	byte_offset;
	bit_offset;
	bit_mask;
	constructor(buffer, name, type, offset, init_value) {
		super();
		this.buffer = buffer;
		this.name = name;
		this.type = type.toLowerCase();
		this.value = init_value;
		this.byte_offset = offset >> 3;
		this.bit_offset = offset % 8;
		this.validate();
		this.init();
	}

	validate() {
		if (
			!["number", "boolean"].includes(typeof this.value)
			|| typeof this.name !== "string"
		) {
			logger.error("Invalid tag configuration: the tag value is not a number or boolean");
			process.exit(1);
		}
		if (this.type === "bool") {
			this.bit_mask = 1 << this.bit_offset;
		} else {
			this.bit_mask = 255;
			if (this.bit_offset !== 0) {
				logger.error(`tag ${this.name} has bit offset: ${this.bit_offset}`);
				process.exit(1);
			}
			const is_single_byte = ["byte", "sint", "usint"].includes(this.type);
			if (!is_single_byte && this.byte_offset % 2 === 1) {
				// Byte index value with word units as delimiters
				logger.error(`${this.type} tag "${this.name}" has wrong offset: ${this.byte_offset}.${this.bit_offset}`);
				process.exit(1);
			}
		}
	}

	/**
	 * Byte index of a single-byte tag (Bool, Byte, SInt, USInt) in a device-ordered IO buffer.
	 * Device endianness acts per 16-bit register: when the endian swaps the
	 * register bytes, the byte sits in the other half of its register.
	 */
	IO_index(endian) {
		return BYTE_SWAP_ENDIANS.includes(endian) ? this.byte_offset ^ 1 : this.byte_offset;
	}

	/**
	 * Byte range [start, end) the tag occupies in a device-ordered IO buffer.
	 */
	IO_range(endian) {
		const start = this.length === 1 ? this.IO_index(endian) : this.byte_offset;
		return { start, end: start + this.length };
	}

	check_change() {
		const old_value = this.value;
		const new_value = this.get_value();
		const both_NaN = Number.isNaN(old_value) && Number.isNaN(new_value);
		if (old_value !== new_value && !both_NaN) {
			this.value = new_value;
			// the change event must be after the new value is applied
			this.emit("change", old_value, new_value);
		}
	}

	init() {
		const codec = CODECS[this.type];
		if (!codec) {
			logger.error(`Unknown tag type: ${this.type}`);
			process.exit(1);
		}
		const byte = this.byte_offset;
		const mask = this.bit_mask;
		this.length = codec.size;
		this.get_value = () => codec.get(this.buffer, byte, mask);
		this.set_value = (v) => {
			codec.set(this.buffer, byte, mask, v);
			this.check_change();
		};
		if (this.type === "bool") {
			this.read_from = (buffer, endian) => {
				codec.set(this.buffer, byte, mask, buffer[this.IO_index(endian)] & mask);
				this.check_change();
			};
			this.write_to = (buffer, endian) => {
				codec.set(buffer, this.IO_index(endian), mask, this.get_value());
			};
		} else if (codec.size === 1) {
			// Byte, SInt, USInt: the byte is copied unchanged
			this.read_from = (buffer, endian) => {
				this.buffer[byte] = buffer[this.IO_index(endian)];
				this.check_change();
			};
			this.write_to = (buffer, endian) => {
				buffer[this.IO_index(endian)] = this.buffer[byte];
			};
		} else {
			const convert = codec.size === 2 ? convert_endian_2byte : convert_endian_4bytes;
			this.read_from = (buffer, endian) => {
				convert(buffer, this.buffer, byte, endian);
				this.check_change();
			};
			this.write_to = (buffer, endian) => {
				convert(this.buffer, buffer, byte, endian);
			};
		}
		this.set_value(this.value); // initialize the buffer with the initial value
	}
}
