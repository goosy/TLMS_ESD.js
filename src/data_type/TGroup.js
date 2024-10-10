
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
     * @param {string} options.combined_endian - The combined endianness for specific data types
     */
    constructor(tdata, options) {
        this.tdata = tdata;
        this.IO_start = options.IO_start ?? 0;
        this.IO_length = options.IO_length ?? tdata.size - this.IO_start;
        this.endian = options.endian ?? 'BE';
        this.combined_endian = options.combined_endian ?? 'BE';
    }

    async read() {
        if (!await this.tdata.IO_read_all()) return;
        const IO_buffer = this.tdata.IO_buffer;
        if (IO_buffer === null) return;
        this.#tags.forEach(tag => {
            const endian = tag.type === 'word' || tag.type === 'dword'
                ? this.combined_endian
                : this.endian;
            tag.read_from(IO_buffer, endian);
        });
        this.tdata.check_all_tags();
    }
    async write() {
        const IO_buffer = this.tdata.IO_buffer;
        this.#tags.forEach(tag => {
            const endian = tag.type === 'word' || tag.type === 'dword'
                ? this.combined_endian
                : this.endian;
            tag.write_to(IO_buffer, endian);
        });
        for (const area of this.#areas) {
            const { start, end } = area;
            const length = end - start;
            const subbuffer = IO_buffer.subarray(start, end);
            await this.tdata.IO_write(subbuffer, { start, length });
        };
    }

    #add(tagname) {
        const tag = this.tdata.get(tagname);
        if (!tag) {
            logger.error('Invalid tag configuration');
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
            if (tag_start > area.end) {
                left = mid + 1;
                continue;
            } else if (tag_end < area.start) {
                right = mid - 1;
                continue;
            }
            if (tag_start == area.end) {
                // Merge right side
                area.end = tag_end;
                const next = areas[mid + 1];
                if (next && tag_end == next.start) {
                    area.end = next.end;
                    areas.splice(mid + 1, 1);
                }
                return mid;
            }
            if (tag_end == area.start) {
                // Merge left side
                area.start = tag_start;
                const prev = areas[mid - 1];
                if (prev && tag_start == prev.end) {
                    area.start = prev.start;
                    areas.splice(mid - 1, 1);
                }
                return mid;
            }
            logger.error('Invalid tag configuration');
            process.exit(1);
        }

        // insert new area
        areas.splice(left, 0, { start: tag_start, end: tag_end });
        return left;
    }

    add(...tags) {
        for (const tag of tags) {
            this.#add(tag);
        }
    }
}
