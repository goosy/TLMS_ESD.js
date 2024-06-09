import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';

export class TData extends EventEmitter {
    // only read
    #buffer;
    get buffer() { return this.#buffer; }
    #getters = {}; // get value from buffer
    #setters = {}; // set value to buffer
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
    /**
     * Replaces the internal buffer with the provided buffer.
     *
     * @param {Buffer} buffer - The buffer to replace the internal buffer with.
     */
    replace_buffer(buffer, start = 0) {
        buffer.copy(this.#buffer, start);
        for (const [tagname, old_value] of Object.entries(this.#values)) {
            const new_value = this.#getters[tagname]();
            if (old_value !== new_value) this.emit("change", tagname, old_value, new_value);
            this.#values[tagname] = new_value;
        }
    }
    setIO(driver, options) {
        driver.start();
        driver.on("tick", async () => {
            const buffer = await driver.read(options);
            this.replace_buffer(buffer, options.start);
        });
    }

    init(item) {
        const offset = item.offset;
        const type = item.type;
        const name = item.name;
        const byte_offset = offset >> 3;
        const bit_offset = offset % 8;
        const bit_number = 1 << bit_offset;

        const getters = this.#getters;
        assert(getters[name] == null);
        switch (type.toLowerCase()) {
            case 'bool':
                getters[name] = () => (this.#buffer.readUInt8(byte_offset) & bit_number) > 0;
                break;
            case 'int':
                getters[name] = () => this.#buffer.readInt16BE(byte_offset);
                break;
            case 'uint':
                getters[name] = () => this.#buffer.readUInt16BE(byte_offset);
                break;
            case 'dint':
                getters[name] = () => this.#buffer.readInt32BE(byte_offset);
                break;
            case 'udint':
                getters[name] = () => this.#buffer.readUInt32BE(byte_offset);
                break;
            case 'real':
                getters[name] = () => this.#buffer.readFloatBE(byte_offset);
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
                    let byte = this.#buffer.readUInt8(byte_offset);
                    if (value) byte = byte | bit_number;
                    else byte = byte & ~bit_number;
                    this.#buffer.writeUInt8(byte, byte_offset);
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
        const size = data_struct.length;
        const buffer = Buffer.alloc(size, 0);
        this.setMaxListeners(100);
        this.size = size;
        this.#buffer = buffer;
        for (const item of data_struct.items) {
            this.init(item);
        }
    }
}
