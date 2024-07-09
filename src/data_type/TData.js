import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { logger } from "../util.js";

export class TData extends EventEmitter {
    // only read
    #buffer;
    /**
     * get the internal buffer
     * all data items are stored in Big-Endian format.
     * word items are an exception and are stored in Little-Endian format
     * because they are considered to be a combination of bits or bytes in sequence.
     *
     * @return {Buffer} - the internal buffer.
     */
    get buffer() { return this.#buffer; }
    get size() {
        return this.#buffer.length;
    }
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

        const IO_start = options.start ?? 0;
        const remote_start = options.remote_start ?? 0;
        const IO_length = options.length ?? this.#buffer.length - IO_start;
        const endian = options.endian ?? "big";
        const combined_endian = options.combined_endian ?? "little";
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
            assert(range.start >= IO_start);
            assert(range.start + range.length <= IO_start + IO_length);
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
        if (this[name]) throw new Error(`new tag has duplicated name: ${name}`);
        let byte_offset = offset >> 3;
        const byte_remainder = byte_offset % 2;
        const bit_offset = offset % 8;
        const bit_mask = 1 << bit_offset;
        const tag = {
            name, type, value,
            byte_offset, bit_offset, bit_mask,
            length: 2,
        }
        if (type === "byte") assert(bit_offset === 0);
        if (type !== "bool" && type !== "byte") {
            // Byte index value with word units as delimiters
            assert(byte_remainder === 0 && bit_offset === 0);
        }
        this.#couplings[name] = _item.coupling.map(cp => cp.name);

        assert(this.#tags[name] == null);
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
        this.buffer = tdata.buffer;
        this.IO_start = options.IO_start;
        this.remote_offset = options.remote_start - this.IO_start;
        this.IO_length = options.IO_length;
        this.skip_endian = options.endian === 'big';
        this.skip_combined = options.combined_endian === 'little';
    }

    convert_tag_endian(buffer, tag) {
        if (tag.type === 'bit' || tag.type === 'byte') return;
        if (tag.type === 'word' || tag.type === 'dword') {
            if (this.skip_combined) return;
        } else {
            if (this.skip_endian) return;
        }
        const index = tag.byte_offset;
        if (tag.length === 2) {
            buffer.writeUInt16BE(buffer.readUInt16LE(index), index);
        }
        if (tag.length === 4) {
            buffer.writeUInt32BE(buffer.readUInt32LE(index), index);
        }
    }

    get_copy_of_buffer() {
        return Buffer.from(this.tdata.buffer);
    }

    /**
     * Asynchronously reads the IO buffer if the driver is connected, otherwise logs an error and returns null.
     *
     * @return {Promise<Buffer|null>} The IO buffer if the driver is connected, otherwise null.
     */
    async read_IO_buffer() {
        if (await this.tdata.read_all()) {
            return this.tdata.IO_buffer;
        }
        return null;
    }

    async read() {
        const IO_buffer = await this.read_IO_buffer();
        if (IO_buffer === null) return;
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
        this.#tags.push(tag);
        if (!tag) throw new Error('Invalid tag configuration');
        const tag_start = tag.byte_offset;
        const length = tag.length;
        if (typeof tag_start !== 'number' || typeof length !== 'number' || length < 0) {
            throw new Error('Invalid tag configuration');
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
            throw new Error('Invalid tag configuration');
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
