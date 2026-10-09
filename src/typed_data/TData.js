import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { TTag } from "./TTag.js";
import { Observer } from "./observer.js";
import { layout_of } from "./layout.js";

export class TData extends EventEmitter {
	/**
	 * @type {Buffer}
	 * @readonly
	 * @description Internal buffer
	 * all data items, including combined words, are stored in Big-Endian format.
	 * Device endianness is converted only at the IO boundary (the IO binding).
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
	 * @type {string}
	 */
	name;

	#layout;
	/**
	 * The compiled layout of this data block (doc/design-scan.md 2.2), read-only.
	 * The tag accessors are defined once on the prototype of layout.Data_Class.
	 */
	get layout() { return this.#layout; }

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
	 * Writes a 16-bit register (big-endian) at a byte offset
	 * (doc/spec-data-api.md 2.5).
	 */
	write_register(offset, value) {
		this.#buffer.writeUInt16BE(value, offset);
		this.#written();
	}

	/** Writes the bits selected by mask of the byte at offset. */
	write_bit(offset, mask, value) {
		const buffer = this.#buffer;
		buffer[offset] = value ? buffer[offset] | mask : buffer[offset] & ~mask;
		this.#written();
	}

	/** Writes the bytes of source from a byte offset. */
	write_bytes(offset, source) {
		source.copy(this.#buffer, offset);
		this.#written();
	}

	/**
	 * After a write: detects the change at once in the immediate mode, then
	 * notifies the user in both modes (doc/spec-data-api.md 4.2).
	 */
	#written() {
		if (this.#detection === "immediate") this.#observer.diff();
		this.#on_write?.(this);
	}

	/**
	 * Called by a tag setter after the value is written into the buffer:
	 * detects the change at once in the immediate mode, then notifies the
	 * user in both modes (doc/spec-data-api.md 4.2).
	 *
	 * @param {{name: string}} _entry - The layout entry of the tag.
	 */
	after_write(_entry) {
		this.#written();
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
