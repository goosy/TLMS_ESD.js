import { logger } from "../util.js";
import { io_range, load_entry, store_entry } from "./endian.js";

export class TGroup {
	#tags = [];
	#areas = [];

	/**
	 * Creates a new TTag_Group instance.
	 * @param {import('./TData.js').TData} tdata - The TData instance this group belongs to.
	 * @param {Object} options - Configuration options for the group.
	 * @param {number} [options.IO_start=0] - The starting position of the I/O buffer.
	 * @param {number} [options.IO_length] - The length of the I/O buffer. Defaults to tdata.size - IO_start if not provided.
	 * @param {string} options.endian - The endianness of the data.
	 * @param {number} [options.write_unit=1] - The smallest writable unit of the driver in bytes.
	 */
	constructor(tdata, options) {
		this.tdata = tdata;
		this.IO_start = options.IO_start ?? 0;
		this.IO_length = options.IO_length ?? tdata.size - this.IO_start;
		this.endian = options.endian ?? "BE";
		this.write_unit = options.write_unit ?? 1;
	}

	/**
	 * Reads data from the device to the IO buffer, loads all tags of the
	 * group into the TData buffer, then detects their changes at once.
	 * @returns {Promise<boolean>} Returns true if the read operation was successful, false otherwise.
	 */
	async read() {
		const read_OK = await this.tdata.IO_read_all();
		if (!read_OK) return false;
		const { IO_buffer, buffer } = this.tdata;
		for (const entry of this.#tags) {
			load_entry(entry, IO_buffer, buffer, this.endian);
		}
		this.tdata.detect();
		return true;
	}

	/**
	 * Writes data from all tags in the group to the IO buffer
	 * and then writes to the device.
	 * @returns {Promise<boolean>} Returns true if all write operations were successful, false otherwise.
	 */
	async write() {
		let write_OK = true;
		const { IO_buffer, buffer } = this.tdata;
		for (const entry of this.#tags) {
			store_entry(entry, buffer, IO_buffer, this.endian);
		}
		for (const area of this.#areas) {
			const { start, end } = area;
			const length = end - start;
			const subbuffer = IO_buffer.subarray(start, end);
			const area_write_OK = await this.tdata.IO_write(subbuffer, { start, length });
			write_OK &&= area_write_OK;
		};
		return write_OK;
	}

	#add(tagname) {
		const tag = this.tdata.layout.entries.get(tagname);
		if (!tag) {
			logger.error("Invalid tag configuration: no such tag");
			process.exit(1);
		}

		if (this.#tags.includes(tag)) return;

		// Overlap rules are enforced by the layout validation,
		// so the group only merges the byte ranges it has to write.
		const { start: tag_start, end: tag_end } = io_range(tag, this.endian);
		if (
			tag_start < this.IO_start
			|| tag_end > this.IO_start + this.IO_length
		) {
			logger.error(`tag ${tag.name} is out of IO exchange area`);
			process.exit(1);
		}
		this.#tags.push(tag);

		// expand to whole write units
		const unit = this.write_unit;
		let start = Math.floor(tag_start / unit) * unit;
		let end = Math.ceil(tag_end / unit) * unit;

		// absorb every area that intersects or touches [start, end)
		const areas = [];
		for (const area of this.#areas) {
			if (area.end < start || area.start > end) {
				areas.push(area);
				continue;
			}
			start = Math.min(start, area.start);
			end = Math.max(end, area.end);
		}
		const index = areas.findIndex((area) => area.start > end);
		areas.splice(index === -1 ? areas.length : index, 0, { start, end });
		this.#areas = areas;
	}

	add(...tags) {
		for (const tag of tags) {
			this.#add(tag);
		}
	}

	/**
	 * Copies the values of the tags of the group from another data block,
	 * by name, then detects their changes at once.
	 */
	copy_from(tdata) {
		const buffer = this.tdata.buffer;
		for (const { name, codec, byte, mask } of this.#tags) {
			const value = tdata[name];
			if (value === undefined) continue;
			codec.set(buffer, byte, mask, value);
		}
		this.tdata.detect();
	}
}
