import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';

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
            if (old_value !== new_value) this.emit("change", tagname, old_value, new_value);
            this.#values[tagname] = new_value;
        }
    }

    /**
     * Sets up the IO operations for the driver.
     *
     * @param {Object} driver - The driver object to start and listen for data.
     * @param {{start:number, length:number}} buffer_info - The buffer information, unit: byte.
     * @return {void}
     */
    setIO(driver, buffer_info) {
        driver.start();
        this.buffer_info = buffer_info;
        const area_start = buffer_info.start;
        if (buffer_info.pollable) driver.on("tick", async () => {
            const buffer = await driver.read(buffer_info);
            this.emit("data", buffer);
        });
        // @todo debouncing it
        if (buffer_info.writewritable) this.on("change", async (tagname) => {
            const info = this.get_tag_info(tagname);
            assert(info != null);
            const { start, length } = info;
            const buffer = this.#buffer.subarray(start, start + length);
            await driver.write(buffer, { start: area_start + start, length });
        });
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
