import { EventEmitter } from "node:events";

/**
 * The interface of one tag of a TData (doc/spec-data-api.md 3). It holds no
 * value: reading `value` decodes it from the buffer of the TData, writing it
 * is the same as `tdata[name] = value`. `change` events (old_value, new_value)
 * are emitted by the Observer of the TData.
 */
export class TTag extends EventEmitter {
	#tdata;
	#entry;

	/**
	 * @param {import("./TData.js").TData} tdata - The TData the tag belongs to.
	 * @param {Object} entry - The layout entry of the tag.
	 */
	constructor(tdata, entry) {
		super();
		this.#tdata = tdata;
		this.#entry = entry;
		this.setMaxListeners(20);
	}

	get name() { return this.#entry.name; }
	get type() { return this.#entry.type; }
	/** Size in bytes. */
	get length() { return this.#entry.size; }
	get entry() { return this.#entry; }
	get value() { return this.#tdata[this.#entry.name]; }
	set value(value) { this.#tdata[this.#entry.name] = value; }
}
