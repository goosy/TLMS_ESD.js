import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { debounce } from "../util.js";

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
            console.log(`${this.name} has no tag named ` + tagname);
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
     * @param {boolean} [options.poll=false] Whether to periodically poll data
     * @param {boolean} [options.push=false] Whether to push data to the device when it changes
     * @return {void}
     */
    set_IO(driver, options, ...extras) {
        if (typeof this.#poll === 'function') { // remove previous polling listener
            this?.driver?.off("tick", this.#poll);
        }
        if (typeof this.#push === 'function') { // remove previous pushing listener
            this.off("change", this.#push);
        }
        if (driver == null) {
            this.driver = null;
            this.buffer_info = null;
            this.IO_read = null;
            this.IO_write = null;
            return;
        }
        this.driver = driver;

        options.start ??= 0;
        options.remote_start ??= 0;
        options.length ??= this.#buffer.length - options.start;
        this.buffer_info = options;

        const offset = options.remote_start - options.start;
        const validateRange = (range) => {
            assert(range.start >= options.start);
            assert(range.start + range.length <= options.start + options.length);
        }
        this.IO_read = async (range) => {
            validateRange(range);
            const start = offset + range.start;
            const length = range.length;
            return await driver.read({ start, length }, ...extras);
        }
        this.IO_write = async (range) => {
            validateRange(range);
            const { start, length } = range;
            const subbuffer = this.#buffer.subarray(start, start + length);
            await driver.write(subbuffer, { start: offset + start }, ...extras);
        }

        this.#poll = async () => {
            const buffer = await this.IO_read(options);
            if (buffer) this.emit("data", buffer);
            else this.emit("read_error");
        }
        if (options.poll) driver.on("tick", this.#poll);

        // debouncing push
        this.#push = (tagname) => {
            const key = `${this.name}:${tagname}`;
            debounce(key, async () => {
                const tag = this.get(tagname);
                assert(tag != null);
                const { byte_offset: start, length } = tag;
                await this.IO_write({ start, length });
            }, 200);
        };
        if (options.push) this.on("change", this.#push);
    }

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

        if (this.#tags[name]) console.log(name);
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
                debounce(`${self.name}_${name}_inner_setter`, () => {
                    self.check_coupling(name);
                }, 100);
            },
            enumerable: true,
            configurable: false,
        });
    }

    constructor(data_struct, name) {
        super();
        this.name = name;
        const size = data_struct.length >> 3;
        const buffer = Buffer.alloc(size, 0);
        this.setMaxListeners(100);
        this.#buffer = buffer;
        this.groups = data_struct.groups;
        for (const item of data_struct.items) {
            this.init(item);
        }
    }
}
