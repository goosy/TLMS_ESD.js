import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { debounce } from "../util.js";

export class TData extends EventEmitter {
    // only read
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
    #getters = {}; // get value from buffer
    #setters = {}; // set value to buffer

    name;

    #values = {};  // values cache
    get(tagname) {
        return this.#values[tagname];
    }
    set(tagname, value) {
        const setter = this.#setters[tagname];
        if (setter == null) {
            console.log(`${this.name} has no setter for ` + tagname);
            return;
        }
        const old_value = this.#values[tagname];
        setter(value);
        this.#values[tagname] = value;
        // the change event must be after the new value is applied
        if (old_value !== value) this.emit("change", tagname, old_value, value);
    }

    #tags_info = {};  // buffer information affected by tags
    get_tag_info(tagname) {
        return this.#tags_info[tagname];
    }

    /**
     * Replaces the internal buffer with the provided buffer.
     *
     * @param {Buffer} buffer - The buffer to replace the internal buffer with.
     */
    replace_buffer(buffer, start = 0) {
        buffer.copy(this.#buffer, start);
        this.refresh_value();
    }

    refresh_value() {
        for (const [tagname, old_value] of Object.entries(this.#values)) {
            const new_value = this.#getters[tagname]();
            this.#values[tagname] = new_value;
            // the change event must be after the new value is applied
            if (old_value !== new_value) this.emit("change", tagname, old_value, new_value);
        }
    }

    #poll; // polling function from driver
    #push; // pushing function to driver
    /**
     * Sets up the IO operations for the driver.
     *
     * @param {Object} driver - The driver object to start and listen for data.
     * @param {{start:number, length:number}} buffer_info - The buffer information, unit: byte.
     * @return {void}
     */
    set_IO(driver, buffer_info) {
        if (typeof this.#poll === 'function') { // remove previous polling listener
            this?.driver?.on("tick", this.#poll);
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
        driver.start();

        this.buffer_info = buffer_info;
        const area_start = buffer_info.start;
        this.IO_read = async (range) => {
            const start = area_start + range.start;
            const length = range.length;
            return await driver.read({ start, length });
        }
        this.IO_write = async (range) => {
            const { start, length } = range;
            const subbuffer = this.#buffer.subarray(start, start + length);
            await driver.write(subbuffer, { start: area_start + start });
        }

        this.#poll = async () => {
            const buffer = await this.IO_read(buffer_info);
            if (buffer) this.emit("data", buffer);
            else this.emit("read_error");
        }
        if (buffer_info.poll) driver.on("tick", this.#poll);

        // debouncing push
        this.#push = (tagname) => {
            const key = `${this.name}:${tagname}`;
            debounce(key, async () => {
                const tag_info = this.get_tag_info(tagname);
                assert(tag_info != null);
                await this.IO_write(tag_info);
            }, 200);
        };
        if (buffer_info.push) this.on("change", this.#push);
    }

    init(item) {
        const offset = item.offset;
        const type = item.type.toLowerCase();
        const name = item.name;
        let byte_offset = offset >> 3;
        const byte_remainder = byte_offset % 2;
        const bit_offset = offset % 8;
        const bit_number = 1 << bit_offset;
        const tag_info = {
            start: byte_offset,
            length: 2,
        }
        if (type === "bool" || type === "byte") {
            if (type === "byte") assert(bit_offset === 0);
            byte_offset += 1 - byte_remainder * 2; // swap high and low bytes for big_endian
        } else {
            // Byte index value with word units as delimiters
            assert(byte_remainder === 0 && bit_offset === 0);
        }

        assert(this.#tags_info[name] == null);
        this.#tags_info[name] = tag_info;
        const getters = this.#getters;
        assert(getters[name] == null);
        const setters = this.#setters;
        assert(setters[name] == null);
        switch (type) {
            case 'bool':
                getters[name] = () => (this.#buffer.readUInt8(byte_offset) & bit_number) > 0;
                setters[name] = (value) => {
                    let byte = this.#buffer.readUInt8(byte_offset);
                    if (value) byte = byte | bit_number;
                    else byte = byte & ~bit_number;
                    this.#buffer.writeUInt8(byte, byte_offset);
                };
                break;
            case 'byte':
                getters[name] = () => this.#buffer.readUInt8(byte_offset);
                getters[name] = () => this.#buffer.wirteUInt8(byte_offset);
                break;
            case 'int':
                getters[name] = () => this.#buffer.readInt16BE(byte_offset);
                setters[name] = (value) => {
                    this.#buffer.writeInt16BE(value, byte_offset);
                };
                break;
            case 'uint':
            case 'word':
                getters[name] = () => this.#buffer.readUInt16BE(byte_offset);
                setters[name] = (value) => {
                    this.#buffer.writeUInt16BE(value, byte_offset);
                };
                break;
            case 'dint':
                getters[name] = () => this.#buffer.readInt32BE(byte_offset);
                tag_info.length = 4;
                setters[name] = (value) => {
                    this.#buffer.writeInt32BE(value, byte_offset);
                };
                break;
            case 'udint':
                getters[name] = () => this.#buffer.readUInt32BE(byte_offset);
                tag_info.length = 4;
                setters[name] = (value) => {
                    this.#buffer.writeUInt32BE(value, byte_offset);
                };
                break;
            case 'real':
                getters[name] = () => this.#buffer.readFloatBE(byte_offset);
                setters[name] = (value) => {
                    this.#buffer.writeFloatBE(value, byte_offset);
                };
                tag_info.length = 4;
                break;
            default:
                break;
        }
        this.#values[name] = getters[name]();
        const self = this;
        Object.defineProperty(self, name, {
            get() {
                return self.#values[name];
            },
            set(value) {
                self.set(name, value);
            },
            enumerable: true,
            configurable: false,
        });
    }

    constructor(data_struct) {
        super();
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
