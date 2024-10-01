import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { logger } from "../util.js";

const reverse_endians = {
    big: 'LE',
    BE: 'LE',
    little: 'BE',
    LE: 'BE',
    BEBS: 'LEBS',
    LEBS: 'BEBS',
}

export class TData extends EventEmitter {
    /**
     * @type {Buffer}
     * @readonly
     * @description Internal buffer
     * all data items are stored in Big-Endian format.
     * word items are an exception and are stored in Little-Endian format
     * because they are considered to be a combination of bits or bytes in sequence.
     */
    #buffer;
    /**
     * get the internal buffer
     *
     * @return {Buffer} - the internal buffer.
     */
    get buffer() { return this.#buffer; }
    get size() {
        return this.#buffer.length;
    }
    /**
     * @type {Buffer|null}
     * @description IO buffer for data exchange with the driver.
     * The endianness (BE, LE, BEBS, or LEBS) is determined by the driver.
     * BE: Big Endian
     * LE: Little Endian
     * BEBS: Big Endian Byte Swap
     * LEBS: Little Endian Byte Swap
     */
    #IO_buffer = null;
    get IO_buffer() { return this.#IO_buffer; }

    name;

    #tags = {};  // values cache
    get(tagname) {
        return this.#tags[tagname];
    }

    #couplings = {};
    check_tag(tag) {
        const name = tag.name ?? tag;
        const _tag = this.#tags[name];
        if (_tag == null) {
            logger.debug(`${this.name} has no tag named ` + tagname);
            return;
        }
        const old_value = _tag.value;
        const new_value = _tag._value;
        if (old_value !== new_value) {
            _tag.value = new_value;
            // the change event must be after the new value is applied
            this.emit("change", name, old_value, new_value);
        }
    }
    check_coupling(tagname) {
        const coupling = this.#couplings[tagname];
        if (Array.isArray(coupling)) for (const tn of coupling) {
            this.check_tag(tn);
        }
    }
    check_all_tags() {
        for (const tag of Object.values(this.#tags)) {
            this.check_tag(tag);
        }
    }

    #poll; // polling function from driver
    #push; // pushing function to driver
    /**
     * Sets up the IO operations for the driver.
     *
     * @param {Object} driver - The driver object to start and listen for data.
     * @param {Object} options - The buffer information, unit: byte.
     * @param {number} [options.start=0] The starting address on the instance buffer, default is 0
     * @param {number} [options.remote_start=0] The starting address of the buffer on the remote device, default is 0
     * @param {number} [options.length] The effective length of the exchange data area, defaults to the remaining length of the buffer
     * @param {string} [options.endian] - Endianness for data interpretation
     * @param {boolean} [options.combined_endian] - Whether to use combined endianness
     * @return {void}
     */
    set_IO(driver, options, ...extras) {
        if (driver == null) {
            this.driver = null;
            this.buffer_info = null;
            this.IO_read = null;
            this.IO_write = null;
            return;
        }
        this.driver = driver;

        // starting position of exchange data segment in the current TData buffer.
        const IO_start = options.start ?? 0;
        // starting position of exchange data segment in the driver.
        const remote_start = options.remote_start ?? 0;
        // length of the exchange data segment
        const IO_length = options.length ?? this.#buffer.length - IO_start;
        const endian = options.endian ?? "BE";
        const combined_endian = options.combined_endian ?? "LE";
        this.create_tag_group = () => new Tag_Group(
            this,
            { IO_start, remote_start, IO_length, endian, combined_endian }
        );

        this.buffer_info = options;

        const offset = remote_start - IO_start;
        const check_driver = (range) => {
            if (!driver.is_connected) {
                console.error('driver is not connected');
                return false;
            }
            if (range.start < IO_start || range.start + range.length > IO_start + IO_length) {
                logger.error(`invalid range ${JSON.stringify(range)}`);
                process.exit(1);
            }
            return true;
        }
        this.IO_read = async (range) => {
            if (!check_driver(range)) return false;
            const start = offset + range.start;
            const length = range.length;
            const buffer = await driver.read({ start, length }, ...extras);
            if (buffer) {
                buffer.copy(this.#IO_buffer, range.start, /*start*/0, /*end*/length);
                return true;
            } else {
                this.emit("read_error");
                return false;
            }
        }
        this.IO_write = async (buffer, range) => {
            if (!check_driver(range)) return false;
            const start = range.start + offset;
            await driver.write(buffer, { start }, ...extras);
            return true;
        }
        this.read_all = async () => {
            const start = remote_start;
            const length = IO_length;
            if (!check_driver({ start: IO_start, length })) return false;
            const buffer = await driver.read({ start, length }, ...extras);
            if (buffer) {
                buffer.copy(this.#IO_buffer, IO_start);
                this.emit("data", buffer);
                return true;
            } else {
                this.emit("read_error");
                return false;
            }
        }
    }

    LE_list = [];
    init(_item) {
        const offset = _item.offset;
        const type = _item.type.toLowerCase();
        const name = _item.name;
        const value = _item.init_value;
        if (this[name]) {
            logger.error(`new tag has duplicated name: ${name}`);
            process.exit(1);
        }
        const byte_offset = offset >> 3;
        const bit_offset = offset % 8;
        const bit_mask = 1 << bit_offset;
        if (type !== "bool" && bit_offset !== 0) {
            logger.error(`tag ${name} has bit offset: ${bit_offset}`);
            process.exit(1);
        }
        if (type !== "bool" && type !== "byte" && byte_offset % 2 === 1) {
            // Byte index value with word units as delimiters
            logger.error(`${type} tag "${name}" has wrong offset: ${offset}`);
            process.exit(1);
        }
        if (this.#tags[name] != null) {
            logger.error(`duplicated tag name: ${name}`);
            process.exit(1);
        }

        const tag = {
            name, type, value,
            byte_offset, bit_offset, bit_mask,
            length: 2,
        }
        this.#couplings[name] = _item.coupling.map(cp => cp.name);
        let self = this;
        switch (type) {
            case 'bool':
                this.#tags[name] = {
                    ...tag,
                    get _value() {
                        return (self.#buffer.readUInt8(byte_offset) & bit_mask) > 0;
                    },
                    set _value(v) {
                        let byte = self.#buffer.readUInt8(byte_offset);
                        if (v) byte = byte | bit_mask;
                        else byte = byte & ~bit_mask;
                        self.#buffer.writeUInt8(byte, byte_offset);
                    },
                    length: 1,
                };
                break;
            case 'byte':
                this.#tags[name] = {
                    ...tag,
                    get _value() {
                        return self.#buffer.readUInt8(byte_offset);
                    },
                    set _value(v) {
                        self.#buffer.wirteUInt8(v, byte_offset);
                    },
                    length: 1,
                };
                break;
            case 'int':
                this.#tags[name] = {
                    ...tag,
                    get _value() {
                        return self.#buffer.readInt16BE(byte_offset);
                    },
                    set _value(v) {
                        self.#buffer.writeInt16BE(v, byte_offset);
                    },
                };
                break;
            case 'uint':
                this.#tags[name] = {
                    ...tag,
                    get _value() {
                        return self.#buffer.readUInt16BE(byte_offset);
                    },
                    set _value(v) {
                        self.#buffer.writeUInt16BE(v, byte_offset);
                    },
                };
                break;
            case 'word':
                // For the combination of bits and bytes, use little_endian
                this.LE_list.push(byte_offset);
                this.#tags[name] = {
                    ...tag,
                    get _value() {
                        return self.#buffer.readUInt16LE(byte_offset);
                    },
                    set _value(v) {
                        self.#buffer.writeUInt16LE(v, byte_offset);
                    },
                };
                break;
            case 'dint':
                this.#tags[name] = {
                    ...tag,
                    get _value() {
                        return self.#buffer.readInt32BE(byte_offset);
                    },
                    set _value(v) {
                        self.#buffer.writeInt32BE(v, byte_offset);
                    },
                    length: 4,
                };
                break;
            case 'udint':
                this.#tags[name] = {
                    ...tag,
                    get _value() {
                        return self.#buffer.readUInt32BE(byte_offset);
                    },
                    set _value(v) {
                        self.#buffer.writeUInt32BE(v, byte_offset);
                    },
                    length: 4,
                };
                break;
            case 'dword':
                // For the combination of bits and bytes, use little_endian
                this.LE_list.push(byte_offset, byte_offset + 2);
                this.#tags[name] = {
                    ...tag,
                    get _value() {
                        return self.#buffer.readUInt32LE(byte_offset);
                    },
                    set _value(v) {
                        self.#buffer.writeUInt32LE(v, byte_offset);
                    },
                    length: 4,
                }
            case 'real':
                this.#tags[name] = {
                    ...tag,
                    get _value() {
                        return self.#buffer.readFloatBE(byte_offset);
                    },
                    set _value(v) {
                        self.#buffer.writeFloatBE(v, byte_offset);
                    },
                    length: 4,
                };
                break;
            default:
                break;
        }
        Object.defineProperty(self, name, {
            get() {
                return self.#tags[name].value;
            },
            set(value) {
                const tag = self.#tags[name];
                tag._value = value;
                self.check_tag(name);
                self.check_coupling(name);
            },
            enumerable: true,
            configurable: false,
        });
    }

    constructor(data_struct, name) {
        super();
        this.name = name;
        this.setMaxListeners(100);
        const size = data_struct.length >> 3;
        const buffer = Buffer.alloc(size, 0);
        this.#buffer = buffer;
        this.#IO_buffer = Buffer.alloc(size, 0);
        this.groups = data_struct.groups;
        for (const item of data_struct.items) {
            this.init(item);
        }
    }
}

class Tag_Group {

    #tags = [];
    #areas = [];

    constructor(tdata, options) {
        this.tdata = tdata;
        this.IO_start = options.IO_start;
        this.IO_length = options.IO_length;
        this.endian = options.endian;
        this.combined_endian = options.combined_endian;
    }

    /**
     * Converts the endianness of a specific tag in the buffer between the specified endian format and Big Endian (BE).
     *
     * This method performs bidirectional conversion:
     * - If the data is not in BE, it converts it to BE.
     * - If the data is in BE, it converts it to the specified endian format.
     *
     * The method handles different endian formats:
     * - LE (Little Endian): DCBA <-> ABCD
     * - BEBS (Big Endian Byte Swap): BADC <-> ABCD
     * - LEBS (Little Endian Byte Swap): CDAB <-> ABCD
     *
     * @param {Buffer} buffer - The buffer containing the data to be converted.
     * @param {Object} tag - The tag object containing information about the data to be converted.
     * @param {string} tag.type - The data type of the tag (e.g., 'bit', 'byte', 'word', 'dword').
     * @param {number} tag.byte_offset - The offset in the buffer where the tag data starts.
     * @param {number} tag.length - The length of the tag data in bytes.
     *
     * @returns {void} This method modifies the buffer in place and does not return a value.
     */
    convert_tag_endian(buffer, tag) {
        if (tag.type === 'bit' || tag.type === 'byte') return;

        const index = tag.byte_offset;
        const is_combined = tag.type === 'word' || tag.type === 'dword';
        const endian = is_combined ? reverse_endians[this.combined_endian] : this.endian;

        if (endian === 'BE' || endian === 'big') return;

        if (tag.length === 2) {
            switch (endian) {
                case 'LE':
                case 'little': // BA
                case 'BEBS': // BA
                    const value = buffer.readUInt16LE(index);
                    buffer.writeUInt16BE(value, index);
                    break;
                case 'LEBS': // AB
                // LEBS for 2 bytes is the same as BE
                default:
                    break;
            }
        } else if (tag.length === 4) {
            switch (endian) {
                case 'LE':
                case 'little': // DCBA <-> ABCD
                    const value = buffer.readUInt32LE(index);
                    buffer.writeUInt32BE(value, index);
                    break;
                case 'BEBS': // BADC <-> ABCD
                    const LE0 = buffer.readUInt16LE(index);
                    const LE1 = buffer.readUInt16LE(index + 2);
                    buffer.writeUInt16BE(LE0, index);
                    buffer.writeUInt16BE(LE1, index + 2);
                    break;
                case 'LEBS': // CDAB <-> ABCD
                    const BE0 = buffer.readUInt16BE(index);
                    const BE1 = buffer.readUInt16BE(index + 2);
                    buffer.writeUInt16BE(BE0, index + 2);
                    buffer.writeUInt16BE(BE1, index);
                    break;
                default:
                    break;
            }
        }
    }

    get_copy_of_buffer() {
        return Buffer.from(this.tdata.buffer);
    }

    async read() {
        if (!await this.tdata.read_all()) return;
        const IO_buffer = this.tdata.IO_buffer;
        this.#tags.forEach(tag => this.convert_tag_endian(IO_buffer, tag));
        this.#areas.forEach(area => {
            const { start, end } = area;
            IO_buffer.copy(this.tdata.buffer, start, start, end);
        });
        this.tdata.check_all_tags();
    }
    async write() {
        const IO_buffer = this.get_copy_of_buffer();
        this.#tags.forEach(tag => this.convert_tag_endian(IO_buffer, tag));
        for (const area of this.#areas) {
            const { start, end } = area;
            const length = end - start;
            const subbuffer = IO_buffer.subarray(start, end);
            await this.tdata.IO_write(subbuffer, { start, length });
        };
    }

    #add(tagname) {
        const tag = this.tdata.get(tagname);
        if (!tag) {
            logger.error('Invalid tag configuration');
            process.exit(1);
        }
        this.#tags.push(tag);
        const tag_start = tag.byte_offset;
        const length = tag.length;
        if (typeof tag_start !== 'number' || typeof length !== 'number' || length < 0) {
            logger.error('Invalid tag configuration');
            process.exit(1);
        }
        const tag_end = tag_start + length;
        const areas = this.#areas;
        let left = 0;
        let right = areas.length - 1;
        while (left <= right) {
            const mid = Math.floor((left + right) / 2);
            const area = areas[mid];
            if (tag_start > area.end) {
                left = mid + 1;
                continue;
            } else if (tag_end < area.start) {
                right = mid - 1;
                continue;
            }
            if (tag_start == area.end) {
                // Merge right side
                area.end = tag_end;
                const next = areas[mid + 1];
                if (next && tag_end == next.start) {
                    area.end = next.end;
                    areas.splice(mid + 1, 1);
                }
                return mid;
            }
            if (tag_end == area.start) {
                // Merge left side
                area.start = tag_start;
                const prev = areas[mid - 1];
                if (prev && tag_start == prev.end) {
                    area.start = prev.start;
                    areas.splice(mid - 1, 1);
                }
                return mid;
            }
            logger.error('Invalid tag configuration');
            process.exit(1);
        }

        // insert new area
        areas.splice(left, 0, { start: tag_start, end: tag_end });
        return left;
    }

    add(...tags) {
        for (const tag of tags) {
            this.#add(tag);
        }
    }
}
