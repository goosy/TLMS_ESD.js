import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { logger } from "../util.js";

function nothing_to_do() { }

const reverse_endians = {
    big: 'LE',
    BE: 'LE',
    little: 'BE',
    LE: 'BE',
    BEBS: 'LEBS',
    LEBS: 'BEBS',
}

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
        case 'LE':
        case 'little':
        case 'BEBS': {  // BA
            const value = buffer_from.readUInt16LE(index);
            buffer_to.writeUInt16BE(value, index);
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
        case 'LE':
        case 'little': { // DCBA <-> ABCD
            buffer_to[index] = buffer_from[index + 3];
            buffer_to[index + 1] = buffer_from[index + 2];
            buffer_to[index + 2] = buffer_from[index + 1];
            buffer_to[index + 3] = buffer_from[index];
            break;
        }
        case 'BEBS': { // BADC <-> ABCD
            buffer_to[index] = buffer_from[index + 1];
            buffer_to[index + 1] = buffer_from[index];
            buffer_to[index + 2] = buffer_from[index + 3];
            buffer_to[index + 3] = buffer_from[index + 2];
            break;
        }
        case 'LEBS': {// CDAB <-> ABCD
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
            !['number', 'boolean'].includes(typeof this.value)
            || typeof this.name !== 'string'
        ) {
            logger.error('Invalid tag configuration: the tag value is not a number or boolean');
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
            if (this.type !== "byte" && this.byte_offset % 2 === 1) {
                // Byte index value with word units as delimiters
                logger.error(`${this.type} tag "${this.name}" has wrong offset: ${this.byte_offset}.${this.bit_offset}`);
                process.exit(1);
            }
        }
    }

    check_change() {
        const old_value = this.value;
        const new_value = this.get_value();
        if (old_value !== new_value) {
            this.value = new_value;
            // the change event must be after the new value is applied
            this.emit("change", old_value, new_value);
        }
    }

    init() {
        const tdata_buffer = this.buffer;
        const index = this.byte_offset;
        switch (this.type) {
            case 'bool': {
                this.length = 1;
                this.tag_buffer = tdata_buffer.subarray(index, index + this.length);
                this.get_value = () => (this.tag_buffer.readUInt8() & this.bit_mask) > 0;
                this.set_value = (v) => {
                    const byte = this.tag_buffer.readUInt8();
                    const new_byte = v ? (byte | this.bit_mask) : (byte & ~this.bit_mask);
                    this.tag_buffer.writeUInt8(new_byte);
                    this.check_change();
                };
                this.read_from = (buffer, endian) => { // @todo: implement endian conversion
                    const masked_value = buffer.readUInt8(index) & this.bit_mask;
                    this.set_value(masked_value > 0);
                };
                this.write_to = (buffer, endian) => { // @todo: implement endian conversion
                    const byte = buffer.readUInt8(index);
                    const new_byte = this.get_value() ? (byte | this.bit_mask) : (byte & ~this.bit_mask);
                    buffer.writeUInt8(new_byte, index);
                };
                break;
            }
            case 'sint':
            case 'usint':
            case 'byte': {
                this.length = 1;
                this.tag_buffer = tdata_buffer.subarray(index, index + this.length);
                this.get_value = () => this.tag_buffer.readUInt8();
                this.set_value = (v) => {
                    this.tag_buffer.writeUInt8(v);
                    this.check_change();
                };
                // Do not convert the byte members of combined tag
                this.read_from = (buffer) => { // @todo: implement endian conversion for byte
                    this.set_value(buffer.readUInt8(index));
                }
                this.write_to = (buffer) => { // @todo: implement endian conversion for byte
                    buffer.writeUInt8(this.get_value(), index);
                }
                break;
            }
            case 'int': {
                this.length = 2;
                this.tag_buffer = tdata_buffer.subarray(index, index + this.length);
                this.get_value = () => this.tag_buffer.readInt16BE();
                this.set_value = (v) => {
                    this.tag_buffer.writeInt16BE(v);
                    this.check_change();
                };
                this.read_from = (buffer, endian) => {
                    convert_endian_2byte(buffer, this.buffer, index, endian);
                    this.check_change();
                }
                this.write_to = (buffer, endian) => {
                    convert_endian_2byte(this.buffer, buffer, index, endian);
                }
                break;
            }
            case 'uint': {
                this.length = 2;
                this.tag_buffer = tdata_buffer.subarray(index, index + this.length);
                this.get_value = () => this.tag_buffer.readUInt16BE();
                this.set_value = (v) => {
                    this.tag_buffer.writeUInt16BE(v);
                    this.check_change();
                };
                this.read_from = (buffer, endian) => {
                    convert_endian_2byte(buffer, this.buffer, index, endian);
                    this.check_change();
                }
                this.write_to = (buffer, endian) => {
                    convert_endian_2byte(this.buffer, buffer, index, endian);
                }
                break;
            }
            case 'word': {
                this.length = 2;
                this.tag_buffer = tdata_buffer.subarray(index, index + this.length);
                this.get_value = () => this.tag_buffer.readUInt16BE();
                this.set_value = (v) => {
                    this.tag_buffer.writeUInt16BE(v);
                    this.check_change();
                };
                // the word tag combined from bits and bytes, needs to have its endian reversed.
                this.read_from = (buffer, endian) => {
                    convert_endian_2byte(buffer, this.buffer, index, endian);
                    this.check_change();
                }
                this.write_to = (buffer, endian) => {
                    convert_endian_2byte(this.buffer, buffer, index, endian);
                }
                break;
            }
            case 'dint':
                this.length = 4;
                this.tag_buffer = tdata_buffer.subarray(index, index + this.length);
                this.get_value = () => this.tag_buffer.readInt32BE();
                this.set_value = (v) => {
                    this.tag_buffer.writeInt32BE(v);
                    this.check_change();
                };
                this.read_from = (buffer, endian) => {
                    convert_endian_4bytes(buffer, this.buffer, index, endian);
                    this.check_change();
                }
                this.write_to = (buffer, endian) => {
                    convert_endian_4bytes(this.buffer, buffer, index, endian);
                }
                break;
            case 'udint':
                this.length = 4;
                this.tag_buffer = tdata_buffer.subarray(index, index + this.length);
                this.get_value = () => this.tag_buffer.readUInt32BE();
                this.set_value = (v) => {
                    this.tag_buffer.writeUInt32BE(v);
                    this.check_change();
                };
                this.read_from = (buffer, endian) => {
                    convert_endian_4bytes(buffer, this.buffer, index, endian);
                    this.check_change();
                }
                this.write_to = (buffer, endian) => {
                    convert_endian_4bytes(this.buffer, buffer, index, endian);
                }
                break;
            case 'dword': {
                this.length = 4;
                this.tag_buffer = tdata_buffer.subarray(index, index + this.length);
                this.get_value = () => this.tag_buffer.readUInt32BE();
                this.set_value = (v) => {
                    this.tag_buffer.writeUInt32BE(v);
                    this.check_change();
                };
                // the dword tag combined from bits and bytes, needs to have its endian reversed.
                this.read_from = (buffer, endian) => {
                    convert_endian_4bytes(buffer, this.buffer, index, endian);
                    this.check_change();
                }
                this.write_to = (buffer, endian) => {
                    convert_endian_4bytes(this.buffer, buffer, index, endian);
                }
                break;
            }
            case 'real': {
                this.length = 4;
                this.tag_buffer = tdata_buffer.subarray(index, index + this.length);
                this.get_value = () => this.tag_buffer.readFloatBE();
                this.set_value = (v) => {
                    this.tag_buffer.writeFloatBE(v);
                    this.check_change();
                };
                this.read_from = (buffer, endian) => {
                    convert_endian_4bytes(buffer, this.buffer, index, endian);
                    this.check_change();
                }
                this.write_to = (buffer, endian) => {
                    convert_endian_4bytes(this.buffer, buffer, index, endian);
                }
                break;
            }
            default:
                logger.error(`Unknown tag type: ${this.type}`);
                process.exit(1);
        }
        this.set_value(this.value); // initialize the buffer with the initial value
    }

}
