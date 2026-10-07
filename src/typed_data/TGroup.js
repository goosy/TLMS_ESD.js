import { logger } from "../util.js";

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
     */
    constructor(tdata, options) {
        this.tdata = tdata;
        this.IO_start = options.IO_start ?? 0;
        this.IO_length = options.IO_length ?? tdata.size - this.IO_start;
        this.endian = options.endian ?? 'BE';
    }

    /**
     * Reads data from  the device to the IO buffer
     * and updates all tags in the group.
     * @returns {Promise<boolean>} Returns true if the read operation was successful, false otherwise.
     */
    async read() {
        const read_OK = await this.tdata.IO_read_all();
        if (!read_OK) return false;
        const IO_buffer = this.tdata.IO_buffer;
        for (const tag of this.#tags) {
            tag.read_from(IO_buffer, this.endian);
        }
        return true;
    }

    /**
     * Writes data from all tags in the group to the IO buffer
     * and then writes to the device.
     * @returns {Promise<boolean>} Returns true if all write operations were successful, false otherwise.
     */
    async write() {
        let write_OK = true;
        const IO_buffer = this.tdata.IO_buffer;
        for (const tag of this.#tags) {
            tag.write_to(IO_buffer,  this.endian);
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
        const tag = this.tdata.get(tagname);
        if (!tag) {
            logger.error('Invalid tag configuration: no such tag');
            process.exit(1);
        }

        this.#tags.push(tag);

        const tag_start = tag.byte_offset;
        const length = tag.length;
        const tag_end = tag_start + length;
        if (
            tag_start < this.IO_start
            || tag_end > this.IO_start + this.IO_length
        ) {
            logger.error('tag offset is out of IO exchange area');
            process.exit(1);
        }

        const areas = this.#areas;
        let left = 0;
        let right = areas.length - 1;
        while (left <= right) {
            const mid = Math.floor((left + right) / 2);
            const area = areas[mid];
            // find overlapping area
            if (tag_start > area.end) {
                left = mid + 1;
                continue;
            }
            if (tag_end < area.start) {
                right = mid - 1;
                continue;
            }
            // merge area
            if (tag_start === area.end) { // Merge right side
                area.end = tag_end;
                const next = areas[mid + 1];
                if (next && tag_end === next.start) {
                    area.end = next.end;
                    areas.splice(mid + 1, 1);
                }
                return;
            }
            if (tag_end === area.start) { // Merge left side
                area.start = tag_start;
                const prev = areas[mid - 1];
                if (prev && tag_start === prev.end) {
                    area.start = prev.start;
                    areas.splice(mid - 1, 1);
                }
                return;
            }
            // if tag.type is bool, permits intervals entirely within existing ones.
            if (tag.type === "bool" || tag_start >= area.start && tag_end <= area.end) {
                return;
            }
            // otherwise, it's an invalid configuration
            logger.error(`Invalid tag configuration: the ${tag.name} tag overlaps with existing ones`);
            process.exit(1);
        }

        // insert new area
        areas.splice(left, 0, { start: tag_start, end: tag_end });
    }

    add(...tags) {
        for (const tag of tags) {
            this.#add(tag);
        }
    }

    copy_from(tdata) {
        for (const tag of this.#tags) {
            const value = tdata[tag.name];
            if (value !== undefined) tag.set_value(value);
        }
    }
}
