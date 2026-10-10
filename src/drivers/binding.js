// IO binding of a data block to a device driver (doc/design.md 4.5).
// Not part of the data layer component: it uses TData through its
// interface and writes its buffer only when loading device data.
import { Buffer } from "node:buffer";

const SWAP_REGISTER = ["LE", "little", "BEBS"];

/**
 * Index in the device-ordered IO buffer of each byte of a data block
 * (doc/design.md 4.5). Device byte order acts per 16-bit register,
 * and per 32-bit value for 4-byte tags.
 */
function io_indexes(layout, endian) {
	const size = layout.size;
	const io_index = new Int32Array(size);
	const swap = SWAP_REGISTER.includes(endian);
	for (let i = 0; i < size; i++) io_index[i] = swap ? i ^ 1 : i;
	for (const { byte, size: tag_size, type } of layout.entries.values()) {
		if (tag_size !== 4 || type === "bool") continue;
		for (let k = 0; k < 4; k++) {
			let index;
			switch (endian) {
				case "LE":
				case "little": index = byte + 3 - k; break;
				case "BEBS": index = byte + (k ^ 1); break;
				case "LEBS": index = byte + ((k + 2) % 4); break;
				default: index = byte + k;
			}
			io_index[byte + k] = index;
		}
	}
	return io_index;
}

/**
 * Tags of a data block exchanged with the device together
 * (replaces TGroup). Created by Binding#create_group.
 */
class Binding_Group {
	/**
	 * @param {Binding} binding
	 * @param {Object[]} entries - The layout entries of the tags.
	 * @param {number[]} bytes - The bytes of the data block owned by the group, ascending.
	 * @param {Uint8Array} own - The bits owned by the group in each byte.
	 * @param {{start: number, end: number}[]} areas - The IO areas to write, in write units.
	 */
	constructor(binding, entries, bytes, own, areas) {
		this.binding = binding;
		this.entries = entries;
		this.bytes = bytes;
		this.own = own;
		this.areas = areas;
	}
}

export class Binding {
	#driver;
	#extras;
	#io_index;
	#IO_buffer;
	#offset;
	#reading = null;
	#write_requests = new Set();
	#write_done = new Map();
	#on_update;

	/** True when the IO buffer holds data read but not loaded yet. */
	fresh = false;
	/** Whether the driver is connected (from its connect / connfailed events). */
	connected;
	/** Whether the last read succeeded. */
	read_ok = true;

	/**
	 * @param {import("../typed_data/TData.js").TData} data - The data block.
	 * @param {Object} driver - The device driver (read, write, is_connected, write_unit).
	 * @param {Object} [options] - The exchange area, in bytes.
	 * @param {number} [options.start=0] - Start of the exchange area in the data block.
	 * @param {number} [options.remote_start=0] - Start of the exchange area on the device.
	 * @param {number} [options.length] - Length of the exchange area, to the end of the data block by default.
	 * @param {string} [options.endian="BE"] - Device byte order: BE, LE (little), BEBS, LEBS.
	 * @param {(binding: Binding) => void} [options.on_update] - Called when new data or a state change arrives.
	 * @param {...*} extras - Passed to the driver unchanged (Modbus: unit_id; S7: area, db).
	 * @throws {Error} When the exchange area is not aligned to the write unit of the driver.
	 */
	constructor(data, driver, options = {}, ...extras) {
		this.data = data;
		this.#driver = driver;
		this.#extras = extras;
		this.start = options.start ?? 0;
		this.remote_start = options.remote_start ?? 0;
		this.length = options.length ?? data.size - this.start;
		this.endian = options.endian ?? "BE";
		this.write_unit = driver.write_unit ?? 1;
		this.#on_update = options.on_update;
		const { start, remote_start, length, write_unit } = this;
		if (start % write_unit || remote_start % write_unit || length % write_unit) {
			throw new Error(`${data.name}: IO area ${JSON.stringify({ start, remote_start, length })} is not aligned to the write unit ${write_unit}`);
		}
		this.#offset = remote_start - start;
		this.#io_index = io_indexes(data.layout, this.endian);
		this.#IO_buffer = Buffer.alloc(data.size, 0);
		this.connected = Boolean(driver.is_connected);
		driver.on?.("connect", () => this.#set_connected(true));
		driver.on?.("connfailed", () => this.#set_connected(false));
	}

	/** The device-ordered buffer, indexed like the data block buffer. */
	get IO_buffer() { return this.#IO_buffer; }

	#set_connected(connected) {
		if (this.connected === connected) return;
		this.connected = connected;
		this.#on_update?.(this);
	}

	/**
	 * Creates a group of tags exchanged together.
	 * @throws {Error} For an unknown tag or a tag outside the exchange area.
	 */
	create_group(...names) {
		const { layout } = this.data;
		const io_index = this.#io_index;
		const area_end = this.start + this.length;
		const own = new Uint8Array(layout.size);
		const entries = [];
		for (const name of names) {
			const entry = layout.entries.get(name);
			if (!entry) throw new Error(`${this.data.name}: no tag named ${name}`);
			if (entries.includes(entry)) continue;
			for (let i = entry.byte; i < entry.byte + entry.size; i++) {
				const j = io_index[i];
				if (j < this.start || j >= area_end) {
					throw new Error(`${this.data.name}: tag ${name} is out of the IO exchange area`);
				}
				own[i] |= entry.mask;
			}
			entries.push(entry);
		}
		const bytes = [];
		for (let i = 0; i < own.length; i++) if (own[i]) bytes.push(i);
		// write areas: the write units holding the owned bytes, adjacent ones merged
		const unit = this.write_unit;
		const units = [...new Set(bytes.map((i) => Math.floor(io_index[i] / unit)))].sort((a, b) => a - b);
		const areas = [];
		for (const u of units) {
			const last = areas.at(-1);
			if (last && last.end === u * unit) last.end += unit;
			else areas.push({ start: u * unit, end: (u + 1) * unit });
		}
		return new Binding_Group(this, entries, bytes, own, areas);
	}

	/**
	 * Reads the whole exchange area into the IO buffer. A read already in
	 * progress is shared instead of starting another one.
	 * @returns {Promise<boolean>} Whether the read succeeded.
	 */
	request_read() {
		if (!this.#driver.is_connected) return Promise.resolve(false);
		this.#reading ??= (async () => {
			try {
				const buffer = await this.#driver.read(
					{ start: this.remote_start, length: this.length },
					...this.#extras,
				);
				const ok = Boolean(buffer);
				if (ok) {
					buffer.copy(this.#IO_buffer, this.start, 0, this.length);
					this.fresh = true;
				}
				this.read_ok = ok;
				this.#on_update?.(this);
				return ok;
			} finally {
				this.#reading = null;
			}
		})();
		return this.#reading;
	}

	/** Loads the bits owned by the group from the IO buffer into the data block buffer. */
	load(group) {
		const buffer = this.data.buffer;
		const io_buffer = this.#IO_buffer;
		const io_index = this.#io_index;
		const { bytes, own } = group;
		for (const i of bytes) {
			const m = own[i];
			buffer[i] = (buffer[i] & ~m) | (io_buffer[io_index[i]] & m);
		}
		this.fresh = false;
	}

	/** Registers a write of the group; several requests of a group before a flush write once. */
	request_write(group) {
		this.#write_requests.add(group);
	}

	/**
	 * Writes the requested groups to the device: exports their bits into the
	 * IO buffer, then writes their areas. Requests are kept while the driver
	 * is not connected.
	 * @returns {Promise<boolean>} Whether every area was written.
	 */
	async flush_writes() {
		if (!this.#driver.is_connected) return false;
		const groups = [...this.#write_requests];
		this.#write_requests.clear();
		const buffer = this.data.buffer;
		const io_buffer = this.#IO_buffer;
		const io_index = this.#io_index;
		let all_ok = true;
		for (const group of groups) {
			for (const i of group.bytes) {
				const j = io_index[i];
				const m = group.own[i];
				io_buffer[j] = (io_buffer[j] & ~m) | (buffer[i] & m);
			}
			let ok = true;
			for (const { start, end } of group.areas) {
				const area_ok = await this.#driver.write(
					io_buffer.subarray(start, end),
					{ start: start + this.#offset, length: end - start },
					...this.#extras,
				);
				ok &&= Boolean(area_ok);
			}
			const done = this.#write_done.get(group);
			this.#write_done.set(group, { seq: (done?.seq ?? 0) + 1, ok });
			all_ok &&= ok;
		}
		if (groups.length > 0) this.#on_update?.(this);
		return all_ok;
	}

	/** The last completed write of a group: its sequence number and result. */
	write_done(group) {
		return this.#write_done.get(group);
	}
}
