import { readFile } from 'fs/promises';
import { Document, parseDocument } from 'yaml';

export class GCL {
    #file;
    get file() {
        return this.#file;
    }
    /** @type {Document[]} */
    #document;
    get document() {
        return this.#document;
    }
    #source;
    get source() {
        return this.#source;
    }
    #lines;
    get lines() {
        return this.#lines;
    }
    get_lines() {
        this.#lines = [];
        let index, position = 0;
        do {
            index = this.#source.indexOf('\n', position);
            if (index > -1) {
                this.#lines.push([position, index]);
                position = index + 1;
            }
        } while (index > -1);
        if (position < this.#source.length) this.#lines.push([position, this.#source.length]);
    }

    constructor() { }

    get_coorinfo(start, end) {
        const ln = 1 + this.#lines.findIndex(([s, e]) => s <= start && start < e);
        const col = start - this.#lines[ln - 1][0];
        const code = this.#source.substring(start, end + 1);
        return { ln, col, code };
    }

    async load(yaml, options = {}) {
        const {
            encoding = 'utf8',
            isFile = true,
            filename = '',
        } = options;
        if (isFile) {
            this.#file = yaml;
            yaml = this.#source = (await readFile(this.#file, { encoding }));
        } else {
            this.#file = filename;
            yaml = this.#source = yaml;
        }
        this.get_lines();
        this.#document = parseDocument(yaml, { version: '1.1' }); // only YAML 1.1 support merge key
        this.#document.gcl = this;
    }
}
