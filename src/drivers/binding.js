// IO binding of a data block to a device driver (doc/design.md 4.5).
// Not part of the data layer component: it exchanges the device-ordered
// IO buffer with the data block per tag (Ltag load / store).
import { Buffer } from "node:buffer";
import { io_index_table } from "modbus-emulator";

/**
 * Tags of a data block exchanged with the device together
 * (replaces TGroup). Created by Binding#create_group.
 */
class Binding_Group {
	/**
	 * @param {Binding} binding
	 * @param {import("modbus-emulator").Ltag[]} tags - The tags of the group, without duplicates.
	 * @param {{start: number, end: number}[]} areas - The IO areas to write, in write units.
	 */
	constructor(binding, tags, areas) {
		this.binding = binding;
		this.tags = tags;
		this.areas = areas;
	}
}

export class Binding {
	#driver;
	#extras;
	#io_index;
	#items;
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
	 * @param {import("modbus-emulator").Ldata} data - The data block.
	 * @param {Object} driver - The device driver (read, write, is_connected, write_unit).
	 * @param {Object} [options] - The exchange area, in bytes.
	 * @param {number} [options.start=0] - Start of the exchange area in the data block.
	 * @param {number} [options.remote_start=0] - Start of the exchange area on the device.
	 * @param {number} [options.length] - Length of the exchange area, to the end of the data block by default.
	 * @param {string} [options.endian="BE"] - Device byte order: BE, LE, BEBS, LEBS.
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
		this.#io_index = io_index_table(data.layout, this.endian);
		this.#items = new Map(data.layout.items.map((item) => [item.name, item]));
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
		const io_index = this.#io_index;
		const area_end = this.start + this.length;
		const owned = new Set();
		const group_tags = [];
		for (const name of names) {
			const item = this.#items.get(name);
			if (!item) throw new Error(`${this.data.name}: no tag named ${name}`);
			const tag = this.data.get(name);
			if (group_tags.includes(tag)) continue;
			// a Bool has a length of one bit and lies in one byte
			const first = item.offset >> 3;
			for (let i = first; i < first + Math.max(1, item.length >> 3); i++) {
				const j = io_index[i];
				if (j < this.start || j >= area_end) {
					throw new Error(`${this.data.name}: tag ${name} is out of the IO exchange area`);
				}
				owned.add(i);
			}
			group_tags.push(tag);
		}
		const bytes = [...owned].sort((a, b) => a - b);
		// write areas: the write units holding the owned bytes, adjacent ones merged
		const unit = this.write_unit;
		const units = [...new Set(bytes.map((i) => Math.floor(io_index[i] / unit)))].sort((a, b) => a - b);
		const areas = [];
		for (const u of units) {
			const last = areas.at(-1);
			if (last && last.end === u * unit) last.end += unit;
			else areas.push({ start: u * unit, end: (u + 1) * unit });
		}
		return new Binding_Group(this, group_tags, areas);
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

	/** Loads the tags of the group from the IO buffer into the data block, as one write. */
	load(group) {
		const { endian } = this;
		const io_buffer = this.#IO_buffer;
		try {
			this.data.transaction(() => {
				for (const tag of group.tags) tag.load(io_buffer, endian);
			});
		} finally {
			// a failing change handler runs after the commit: the data is loaded
			this.fresh = false;
		}
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
		const { endian } = this;
		const io_buffer = this.#IO_buffer;
		let all_ok = true;
		for (const group of groups) {
			// exported right before its areas are written: a scan may run between two groups
			for (const tag of group.tags) tag.store(io_buffer, endian);
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
