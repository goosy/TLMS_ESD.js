import { Buffer } from "node:buffer";

// a change made by a change handler is detected in a further round
const MAX_DIFF_ROUNDS = 16;

const same_value = (a, b) => a === b || (Number.isNaN(a) && Number.isNaN(b));

/**
 * Detects the changes of a TData buffer by comparing it with a snapshot
 * (doc/design.md 3.5) and reports each changed tag once.
 *
 * Immediate mode (doc/design.md 3.5): the TData calls diff() after
 * every write. A diff() called while the changes are being reported, by a
 * handler writing a tag, is only recorded; the outer diff() runs another
 * round once the current changes are reported.
 */
export class Observer {
	#buffer;
	#layout;
	#snapshot;
	#scan_snapshot;
	#report;
	#diffing = false;
	#pending = false;
	#seen;
	#mark = 0;

	/**
	 * @param {Buffer} buffer - The buffer of the TData.
	 * @param {Object} layout - The compiled layout of the TData.
	 * @param {(entry: Object, old_value: *, new_value: *) => void} report - Called for each change.
	 */
	constructor(buffer, layout, report) {
		this.#buffer = buffer;
		this.#layout = layout;
		this.#report = report;
		this.#snapshot = Buffer.from(buffer);
		this.#scan_snapshot = Buffer.from(buffer);
		this.#seen = new Uint32Array(layout.entries.size);
	}

	/** The value of a tag at the end of the last scan (doc/design.md 3.5). */
	previous(name) {
		const entry = this.#layout.entries.get(name);
		return entry.codec.get(this.#scan_snapshot, entry.byte, entry.mask);
	}

	/** Called at the end of a scan: the current values become the previous ones. */
	take_scan_snapshot() {
		this.#buffer.copy(this.#scan_snapshot);
	}

	/** Reports every tag changed since the last diff. */
	diff() {
		if (this.#diffing) {
			this.#pending = true;
			return;
		}
		this.#diffing = true;
		try {
			let rounds = 0;
			do {
				this.#pending = false;
				if (++rounds > MAX_DIFF_ROUNDS) {
					throw new Error(`${this.#layout.name}: changes do not settle after ${MAX_DIFF_ROUNDS} rounds`);
				}
				for (const [entry, old_value, new_value] of this.#collect()) {
					this.#report(entry, old_value, new_value);
				}
			} while (this.#pending);
		} finally {
			this.#diffing = false;
		}
	}

	/**
	 * Collects the changed tags, in layout order, and updates the snapshot.
	 * Old values are decoded from the snapshot, so no value is cached.
	 */
	#collect() {
		const buffer = this.#buffer;
		const snapshot = this.#snapshot;
		const tags_at_byte = this.#layout.tags_at_byte;
		// entries already checked in this collection, by entry index
		const seen = this.#seen;
		if (this.#mark === 0xffffffff) {
			// the marks wrap around: clear them
			seen.fill(0);
			this.#mark = 0;
		}
		const mark = ++this.#mark;
		const changes = [];
		let in_order = true;
		let last_index = -1;
		for (let i = 0; i < buffer.length; i++) {
			if (buffer[i] === snapshot[i]) continue;
			for (const entry of tags_at_byte[i]) {
				if (seen[entry.index] === mark) continue;
				seen[entry.index] = mark;
				const { codec, byte, mask } = entry;
				const old_value = codec.get(snapshot, byte, mask);
				const new_value = codec.get(buffer, byte, mask);
				if (same_value(old_value, new_value)) continue;
				changes.push([entry, old_value, new_value]);
				if (entry.index < last_index) in_order = false;
				last_index = entry.index;
			}
		}
		buffer.copy(snapshot);
		if (!in_order) changes.sort((a, b) => a[0].index - b[0].index);
		return changes;
	}
}
