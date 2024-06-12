import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';

export class TData extends EventEmitter {
    // only read
    #buffer;
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
            console.log("no setter for " + tagname);
        }
        const old_value = this.#values[tagname];
        setter(value);
        this.#values[tagname] = value;
        this.emit("change", tagname, old_value, value);
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
     * @param {{start:number, length:number}} buff_info - The buffer information, unit: byte.
     * @return {void}
     */
    setIO(driver, buff_info) {
        driver.start();
        const area_start = buff_info.start;
        if (buff_info.pollable) driver.on("tick", async () => {
            const buffer = await driver.read(buff_info);
            this.replace_buffer(buffer, area_start);
        });
        if (buff_info.writewritable) this.on("change", async (tagname) => {
            const info = this.get_tag_info(tagname);
            assert(info != null);
            const { start, length } = info;
            const buffer = this.#buffer.subarray(start, start + length);
            await driver.write(buffer, { start: area_start + start, length });
        });
    }

    init(item) {
        const offset = item.offset;
        const type = item.type;
        const name = item.name;
        const byte_offset = offset >> 4 << 1; // Byte index value with word units as delimiters
        const bit_offset = offset % 16;
        const bit_number = 1 << bit_offset;
        const tag_info = {
            start: byte_offset,
            length: 2,
        }

        assert(this.#tags_info[name] == null);
        this.#tags_info[name] = tag_info;
        const getters = this.#getters;
        assert(getters[name] == null);
        switch (type.toLowerCase()) {
            case 'bool':
                getters[name] = () => (this.#buffer.readUInt16BE(byte_offset) & bit_number) > 0;
                break;
            case 'int':
                getters[name] = () => this.#buffer.readInt16BE(byte_offset);
                break;
            case 'uint':
                getters[name] = () => this.#buffer.readUInt16BE(byte_offset);
                break;
            case 'dint':
                getters[name] = () => this.#buffer.readInt32BE(byte_offset);
                tag_info.length = 4;
                break;
            case 'udint':
                getters[name] = () => this.#buffer.readUInt32BE(byte_offset);
                tag_info.length = 4;
                break;
            case 'real':
                getters[name] = () => this.#buffer.readFloatBE(byte_offset);
                tag_info.length = 4;
                break;
            default:
                break;
        }
        this.#values[name] = getters[name]();

        const setters = this.#setters;
        assert(setters[name] == null);
        switch (type.toLowerCase()) {
            case 'bool':
                setters[name] = (value) => {
                    let word = this.#buffer.readUInt16BE(byte_offset);
                    if (value) word = word | bit_number;
                    else word = word & ~bit_number;
                    this.#buffer.writeUInt16BE(word, byte_offset);
                }
                break;
            case 'int':
                setters[name] = (value) => {
                    this.#buffer.writeInt16BE(value, byte_offset);
                }
                break;
            case 'uint':
                setters[name] = (value) => {
                    this.#buffer.writeUInt16BE(value, byte_offset);
                }
                break;
            case 'dint':
                setters[name] = (value) => {
                    this.#buffer.writeInt32BE(value, byte_offset);
                }
                break;
            case 'udint':
                setters[name] = (value) => {
                    this.#buffer.writeUInt32BE(value, byte_offset);
                }
                break;
            case 'real':
                setters[name] = (value) => {
                    this.#buffer.writeFloatBE(value, byte_offset);
                }
                break;
            default:
                break;
        }
    }

    constructor(data_struct, options) {
        super();
        const size = data_struct.length >> 3;
        const buffer = Buffer.alloc(size, 0);
        this.setMaxListeners(100);
        this.#buffer = buffer;
        for (const item of data_struct.items) {
            this.init(item);
        }
    }
}
