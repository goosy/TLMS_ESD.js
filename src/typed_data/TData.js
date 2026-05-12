import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { logger } from "../util.js";
import { TTag } from './TTag.js';
import { TGroup } from './TGroup.js';

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

    /**
     * @type {string}
     */
    name;

    /**
     * @type {Object.<string, TTag>}
     * @private
     * @description A collection of TTag objects, where the key is the tag name (string) and the value is the TTag object.
     */
    #tags = {};
    /**
     * Retrieves a TTag object by its name.
     * @param {string} tagname - The name of the tag to retrieve.
     * @returns {TTag|undefined} The TTag object if found, undefined otherwise.
     */
    get(tagname) {
        return this.#tags[tagname];
    }

    #couplings = {};
    check_tag(tag) {
        const name = tag.name ?? tag;
        const _tag = this.#tags[name];
        if (_tag == null) {
            logger.debug(`${this.name} has no tag named ${tagname}`);
            return;
        }
        _tag.check_change();
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

    /**
     * Sets up the IO operations for the driver.
     *
     * @param {Object} driver - The driver object to start and listen for data.
     * @param {Object} options - The buffer information, unit: byte.
     * @param {number} [options.start=0] The starting address on the instance buffer, default is 0
     * @param {number} [options.remote_start=0] The starting address of the buffer on the remote device, default is 0
     * @param {number} [options.length] The effective length of the exchange data area, defaults to the remaining length of the buffer
     * @param {string} [options.endian] - Endianness for data interpretation
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
        this.create_tag_group = () => new TGroup(
            this,
            { IO_start, remote_start, IO_length, endian }
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
            }
            return false;
        }
        this.IO_write = async (buffer, range) => {
            if (!check_driver(range)) return false;
            const start = range.start + offset;
            return await driver.write(buffer, { start }, ...extras);
        }
        this.IO_read_all = async () => {
            const start = remote_start;
            const length = IO_length;
            if (!check_driver({ start: IO_start, length })) return false;
            const buffer = await driver.read({ start, length }, ...extras);
            if (buffer) {
                buffer.copy(this.#IO_buffer, IO_start);
                this.emit("data", buffer);
                return true;
            }
            return false;
        }
    }

    init(_item) {
        const { offset, type, name, init_value, coupling, is_combined } = _item;
        if (this[name] || this.#tags[name] != null) {
            logger.error(`new tag name is duplicated or not allowed: ${name}`);
            process.exit(1);
        }

        const tag = new TTag(this.buffer, name, type, offset, init_value);
        this.#tags[name] = tag;
        this.#couplings[name] = coupling;

        if (is_combined) {
            // @todo: Record the overall starting address for coupling tags.
        }

        tag.on("change", (old_value, new_value) => {
            this.emit("change", name, old_value, new_value);
        })

        const self = this;
        Object.defineProperty(self, name, {
            get() {
                return self.#tags[name].value;
            },
            set(value) {
                const tag = self.#tags[name];
                tag.set_value(value);
                self.check_coupling(name);
            },
            enumerable: true,
            configurable: false,
        });
    }

    /**
     * Creates a new TData instance.
     * @param {Object} data_struct - The data structure object.
     * @param {Array} data_struct.items - Array of data items to initialize.
     * @param {Object} data_struct.groups - Groups of data items.
     * @param {string} name - The name of the TData instance.
     */
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
