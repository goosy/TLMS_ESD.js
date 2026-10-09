import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { TTag } from "./TTag.js";
import { TGroup } from "./TGroup.js";
import { Observer } from "./observer.js";
import { layout_of } from "./layout.js";

export class TData extends EventEmitter {
	/**
	 * @type {Buffer}
	 * @readonly
	 * @description Internal buffer
	 * all data items, including combined words, are stored in Big-Endian format.
	 * Device endianness is converted only at the IO boundary (endian.js).
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

	#layout;
	/**
	 * The compiled layout of this data block (doc/design-scan.md 2.2), read-only.
	 * The tag accessors are defined once on the prototype of layout.Data_Class.
	 */
	get layout() { return this.#layout; }

	// Members assigned by set_IO. They are declared here so that
	// layout_of() rejects tag names that would collide with them.
	driver = null;
	buffer_info = null;
	IO_read = null;
	IO_write = null;
	IO_read_all = null;
	create_tag_group = null;

	/** @type {Observer} */
	#observer;
	/** "immediate" or "deferred" (doc/spec-data-api.md 4) */
	#detection;
	/** called after each write, after its detection in the immediate mode */
	#on_write;
	/** The change detector of this data block (doc/design-scan.md 5). */
	get observer() { return this.#observer; }

	/**
	 * @type {Map<string, TTag>}
	 * @description The tag handles created so far, by tag name.
	 */
	#handles = new Map();
	/**
	 * Retrieves the handle of a tag, creating it on first use.
	 * @param {string} tagname - The name of the tag to retrieve.
	 * @returns {TTag|undefined} The TTag handle, undefined for an unknown name.
	 */
	get(tagname) {
		let tag = this.#handles.get(tagname);
		if (tag) return tag;
		const entry = this.layout.entries.get(tagname);
		if (!entry) return undefined;
		tag = new TTag(this, entry);
		this.#handles.set(tagname, tag);
		return tag;
	}

	/**
	 * Detects every change since the last detection and emits its events
	 * (doc/spec-data-api.md 2.6). Needed after writing the buffer directly,
	 * and in the deferred mode whenever the user chooses.
	 */
	detect() {
		this.#observer.diff();
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
	 * @throws {Error} When the IO area is not aligned to the write unit of the driver.
	 */
	set_IO(driver, options, ...extras) {
		if (driver == null) {
			this.driver = null;
			this.buffer_info = null;
			this.IO_read = null;
			this.IO_write = null;
			return;
		}

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
			throw new Error(`${this.name}: IO area ${JSON.stringify({ IO_start, remote_start, IO_length })} is not aligned to the write unit ${write_unit}`);
		}
		this.driver = driver;

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
			if (range.start < IO_start || range.start + range.length > IO_start + IO_length) {
				throw new Error(`${this.name}: invalid range ${JSON.stringify(range)}`);
			}
			return driver.is_connected;
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
	 * detects the change at once in the immediate mode, then notifies the
	 * user in both modes (doc/spec-data-api.md 4.2).
	 *
	 * @param {{name: string}} _entry - The layout entry of the tag.
	 */
	after_write(_entry) {
		if (this.#detection === "immediate") this.#observer.diff();
		this.#on_write?.(this);
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
	 * @param {Object} [options]
	 * @param {"immediate"|"deferred"} [options.detection="immediate"] - When changes are detected.
	 * @param {(tdata: TData) => void} [options.on_write] - Called after each write, after its detection in the immediate mode.
	 */
	constructor(data_struct, name, options = {}) {
		if (new.target === TData) {
			const { Data_Class } = data_struct.Data_Class ? data_struct : layout_of(data_struct);
			// constructors may return an object: the instance of the compiled subclass
			return new Data_Class(data_struct, name, options);
		}
		super();
		const { detection = "immediate", on_write } = options;
		if (detection !== "immediate" && detection !== "deferred") {
			throw new Error(`${name}: unknown detection mode ${detection}`);
		}
		this.#detection = detection;
		this.#on_write = on_write;
		this.name = name;
		this.#layout = new.target.layout;
		this.setMaxListeners(100);
		const size = this.layout.size;
		this.#buffer = Buffer.alloc(size, 0);
		this.#IO_buffer = Buffer.alloc(size, 0);
		// init values in layout order: the bits of a combined word after the word
		for (const { codec, byte, mask, init_value } of this.layout.entries.values()) {
			codec.set(this.#buffer, byte, mask, init_value);
		}
		this.#observer = new Observer(this.#buffer, this.layout, (entry, old_value, new_value) => {
			// the data block event first, as when it relayed the tag events
			this.emit("change", entry.name, old_value, new_value);
			this.#handles.get(entry.name)?.emit("change", old_value, new_value);
		});
	}
}
