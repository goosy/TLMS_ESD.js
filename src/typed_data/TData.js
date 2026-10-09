import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { logger } from "../util.js";
import { TTag } from "./TTag.js";
import { TGroup } from "./TGroup.js";
import { layout_of } from "./layout.js";

export class TData extends EventEmitter {
	/**
	 * @type {Buffer}
	 * @readonly
	 * @description Internal buffer
	 * all data items, including combined words, are stored in Big-Endian format.
	 * Device endianness is converted only at the IO boundary (TTag.read_from/write_to).
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
	 * The compiled layout of this data block (doc/design-scan.md 2.2).
	 * The tag accessors are defined once on the prototype of layout.Data_Class.
	 */
	layout;

	// Members assigned by set_IO. They are declared here so that
	// layout_of() rejects tag names that would collide with them.
	driver = null;
	buffer_info = null;
	IO_read = null;
	IO_write = null;
	IO_read_all = null;
	create_tag_group = null;

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
			logger.debug(`${this.name} has no tag named ${name}`);
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
		// smallest writable unit of the driver in bytes
		const write_unit = driver.write_unit ?? 1;
		if (IO_start % write_unit || remote_start % write_unit || IO_length % write_unit) {
			logger.error(`${this.name}: IO area ${JSON.stringify({ IO_start, remote_start, IO_length })} is not aligned to the write unit ${write_unit}`);
			process.exit(1);
		}

		this.create_tag_group = (...tags) => {
			const tgroup = new TGroup(
				this,
				{ IO_start, remote_start, IO_length, endian, write_unit },
			);
			tgroup.add(...tags);
			return tgroup;
		};

		this.buffer_info = options;

		const offset = remote_start - IO_start;
		const check_driver = (range) => {
			if (!driver.is_connected) {
				console.error("driver is not connected");
				return false;
			}
			if (range.start < IO_start || range.start + range.length > IO_start + IO_length) {
				logger.error(`invalid range ${JSON.stringify(range)}`);
				process.exit(1);
			}
			return true;
		};
		this.IO_read = async (range) => {
			if (!check_driver(range)) return false;
			const start = offset + range.start;
			const length = range.length;
			const buffer = await driver.read({ start, length }, ...extras);
			if (buffer) {
				buffer.copy(this.#IO_buffer, range.start, /* start */0, /* end */length);
				return true;
			}
			return false;
		};
		this.IO_write = async (buffer, range) => {
			if (!check_driver(range)) return false;
			const start = range.start + offset;
			return await driver.write(buffer, { start, length: range.length }, ...extras);
		};
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
		};
	}

	/**
	 * Called by a tag setter after the value is written into the buffer:
	 * emits the change of the tag and refreshes the coupled tags.
	 *
	 * @param {{name: string}} entry - The layout entry of the tag.
	 */
	after_write(entry) {
		this.#tags[entry.name].check_change();
		this.check_coupling(entry.name);
	}

	/**
	 * Creates a new TData instance.
	 *
	 * `new TData(struct, name)` returns an instance of the class compiled for
	 * the struct (layout.Data_Class), whose prototype holds the tag accessors.
	 *
	 * @param {Object} data_struct - The expanded structure or its compiled layout.
	 * @param {string} data_struct.name - the name of data_struct.
	 * @param {Array} data_struct.items - Array of data items to initialize.
	 * @param {string} name - The name of the TData instance.
	 */
	constructor(data_struct, name) {
		if (new.target === TData) {
			const { Data_Class } = data_struct.Data_Class ? data_struct : layout_of(data_struct);
			// constructors may return an object: the instance of the compiled subclass
			return new Data_Class(data_struct, name);
		}
		super();
		this.name = name;
		this.layout = new.target.layout;
		this.setMaxListeners(100);
		const size = this.layout.size;
		this.#buffer = Buffer.alloc(size, 0);
		this.#IO_buffer = Buffer.alloc(size, 0);
		for (const entry of this.layout.entries.values()) {
			this.#add_tag(entry);
		}
	}

	#add_tag(entry) {
		const { name, item } = entry;
		const tag = new TTag(this.#buffer, name, item.type, item.offset, item.init_value);
		this.#tags[name] = tag;
		this.#couplings[name] = item.coupling;
		tag.on("change", (old_value, new_value) => {
			this.emit("change", name, old_value, new_value);
		});
	}
}
