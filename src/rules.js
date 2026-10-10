// Rules of the scan: declarations, timing and ordering (doc/design-scan.md 7).
import { TData } from "./typed_data/TData.js";
import { Binding } from "./drivers/binding.js";

/** The states of a Binding a rule may read (doc/design-scan.md 4.4). */
export const BINDING_STATES = ["connected", "read_ok", "write_done"];
/** The binding states saved at the end of every scan (write_done takes a group). */
export const PREVIOUS_BINDING_STATES = ["connected", "read_ok"];

/**
 * Counts the periodic ticks since its rule started it (doc/design-scan.md 7.3).
 * The scheduler advances every running ticker once per periodic tick.
 */
export class Ticker {
	count = 0;
	running = false;
	#running_set;
	#period;

	/**
	 * @param {Set<Ticker>} running_set - The running tickers of the scheduler.
	 * @param {number} period - Milliseconds per tick.
	 */
	constructor(running_set, period) {
		this.#running_set = running_set;
		this.#period = period;
	}

	/** Milliseconds counted: count * period. */
	get elapsed() { return this.count * this.#period; }

	/** Starts counting from 0; a no-op while running, so a held condition keeps counting. */
	start() {
		if (this.running) return;
		this.running = true;
		this.count = 0;
		this.#running_set.add(this);
	}

	/** Stops and clears the count. */
	stop() {
		this.running = false;
		this.count = 0;
		this.#running_set.delete(this);
	}

	restart() {
		this.stop();
		this.start();
	}
}

/**
 * On-delay of a level condition (as a PLC TON): true once cond has held for
 * longer than delay_ms.
 */
export function on_delay(ticker, cond, delay_ms) {
	if (cond) ticker.start();
	else ticker.stop();
	return ticker.elapsed > delay_ms;
}

/**
 * Off-delay of a level condition (as a PLC TOF): true while cond holds,
 * and for delay_ms after it drops.
 */
export function off_delay(ticker, cond, delay_ms) {
	return !on_delay(ticker, !cond, delay_ms);
}

function rule_of(kind, { name, reads = [], writes = [], reads_previous = [], run }) {
	if (typeof run !== "function") throw new Error(`rule ${name}: run must be a function`);
	const check_keys = (keys, field) => {
		if (!Array.isArray(keys) || !keys.every((key) => Array.isArray(key) && key.length === 2)) {
			throw new Error(`rule ${name}: ${field} must be a list of [owner, name] keys`);
		}
	};
	check_keys(reads, "reads");
	check_keys(writes, "writes");
	check_keys(reads_previous, "reads_previous");
	return Object.freeze({ kind, name, reads, writes, reads_previous, run });
}

/**
 * Declares a derive rule: the only writer of its keys, fully determining
 * their values on every scan (doc/design-scan.md 7.2).
 */
export function derive(spec) {
	return rule_of("derive", spec);
}

/**
 * Declares an act rule: its keys may have other writers, and it may write
 * only when a condition holds (doc/design-scan.md 7.2).
 */
export function act(spec) {
	return rule_of("act", spec);
}

/**
 * The component bits of a combined word of a layout (doc/design-scan.md
 * 7.1): the Bool tags inside its bytes. Empty for any other tag.
 */
export function component_bits(layout, name) {
	const entry = layout.entries.get(name);
	if (!entry || entry.type === "bool") return [];
	const bits = [];
	for (let i = entry.byte; i < entry.byte + entry.size; i++) {
		for (const tag of layout.tags_at_byte[i]) if (tag.type === "bool") bits.push(tag.name);
	}
	return bits;
}

/** A readable name of a dependency key owner. */
function owner_label(owner) {
	if (owner instanceof TData) return owner.name;
	if (owner instanceof Binding) return `${owner.data.name} binding`;
	return owner?.name ?? "object";
}

/**
 * Checks the rules and orders them by their dependencies
 * (doc/design-scan.md 7.4): a writer of a key runs before its readers; a
 * read of a key the rule also writes, and a read of the previous value
 * (reads_previous), is no dependency; otherwise the declaration order is kept.
 * A read of a combined word reads all its bits; a combined word must not be
 * written (doc/design-scan.md 7.1).
 *
 * @param {Object[]} rules - Rules built by derive() / act(), in declaration order.
 * @param {(owner: Object, name: string) => boolean} is_var - Whether a key of a plain object is a registered variable.
 * @return {Object[]} The rules in execution order.
 * @throws {Error} With `errors`, every violation found.
 */
export function order_rules(rules, is_var) {
	const errors = [];
	const names = new Set();
	// key nodes by owner and name
	const keys = new Map();
	const key_of = (owner, name) => {
		if (!keys.has(owner)) keys.set(owner, new Map());
		const by_name = keys.get(owner);
		if (!by_name.has(name)) by_name.set(name, { owner, name, writers: [], readers: [] });
		return by_name.get(name);
	};
	// mode: "read", "write" or "previous"
	const check_key = (rule, owner, name, mode) => {
		const where = `rule ${rule.name}: ${owner_label(owner)}.${name}`;
		if (owner instanceof TData) {
			if (!owner.layout.entries.has(name)) errors.push(`${where}: no such tag`);
			else if (mode === "write" && component_bits(owner.layout, name).length > 0) {
				errors.push(`${where}: a combined word is not written, write its bits`);
			}
		} else if (owner instanceof Binding) {
			if (!BINDING_STATES.includes(name)) errors.push(`${where}: no such binding state`);
			else if (mode === "write") errors.push(`${where}: a binding state is read-only`);
			else if (mode === "previous" && !PREVIOUS_BINDING_STATES.includes(name)) {
				errors.push(`${where}: this binding state has no previous value`);
			}
		} else if (owner === null || typeof owner !== "object") {
			errors.push(`rule ${rule.name}: ${name}: a variable must be a property of an object`);
		} else if (!is_var(owner, name)) {
			errors.push(`${where}: variable not registered with add_var`);
		}
	};

	rules.forEach((rule, index) => {
		if (typeof rule.name !== "string" || rule.name === "") errors.push(`rule #${index}: no name`);
		else if (names.has(rule.name)) errors.push(`rule ${rule.name}: duplicated name`);
		names.add(rule.name);
		for (const [owner, name] of rule.writes) {
			check_key(rule, owner, name, "write");
			key_of(owner, name).writers.push(index);
		}
		const writes = new Set(rule.writes.map(([owner, name]) => key_of(owner, name)));
		// a read of the previous value is checked but makes no edge
		for (const [owner, name] of rule.reads_previous) check_key(rule, owner, name, "previous");
		for (const [owner, name] of rule.reads) {
			check_key(rule, owner, name, "read");
			// a combined word is read through its bits
			const bits = owner instanceof TData ? component_bits(owner.layout, name) : [];
			for (const read_name of [name, ...bits]) {
				const key = key_of(owner, read_name);
				// a read-modify-write of its own key is no dependency
				if (!writes.has(key)) key.readers.push(index);
			}
		}
	});

	// edges writer -> reader, labelled with their key
	const successors = rules.map(() => new Map());
	const indegree = rules.map(() => 0);
	for (const by_name of keys.values()) {
		for (const key of by_name.values()) {
			const derives = key.writers.filter((i) => rules[i].kind === "derive");
			if (derives.length > 0 && key.writers.length > 1) {
				const writer_names = key.writers.map((i) => rules[i].name).join(", ");
				errors.push(`${owner_label(key.owner)}.${key.name}: written by a derive rule and other rules (${writer_names})`);
			}
			for (const w of key.writers) {
				for (const r of key.readers) {
					if (w === r || successors[w].has(r)) continue;
					successors[w].set(r, key);
					indegree[r]++;
				}
			}
		}
	}

	// Kahn's algorithm, taking the ready rule declared first
	const order = [];
	const ready = [];
	indegree.forEach((degree, i) => { if (degree === 0) ready.push(i); });
	while (ready.length > 0) {
		ready.sort((a, b) => a - b);
		const i = ready.shift();
		order.push(i);
		for (const r of successors[i].keys()) {
			if (--indegree[r] === 0) ready.push(r);
		}
	}
	if (order.length < rules.length) errors.push(describe_cycle(rules, successors, indegree));

	if (errors.length > 0) {
		const error = new Error(`invalid rules:\n${errors.join("\n")}`);
		error.errors = errors;
		throw error;
	}
	return order.map((i) => rules[i]);
}

/**
 * Finds one cycle among the rules left by the topological sort. Every rule
 * left has a predecessor left, so walking predecessors must repeat a rule.
 */
function describe_cycle(rules, successors, indegree) {
	const left = new Set(indegree.flatMap((degree, i) => degree > 0 ? [i] : []));
	const predecessor = new Map();
	successors.forEach((edges, w) => {
		if (!left.has(w)) return;
		for (const [r, key] of edges) if (left.has(r) && !predecessor.has(r)) predecessor.set(r, [w, key]);
	});
	let i = [...left][0];
	const seen = new Set();
	while (!seen.has(i)) {
		seen.add(i);
		i = predecessor.get(i)[0];
	}
	// i is on the cycle: walk it once, then put it in edge order
	const cycle = [];
	let r = i;
	do {
		const [w, key] = predecessor.get(r);
		cycle.unshift([w, key]);
		r = w;
	} while (r !== i);
	const text = cycle.map(([w, key]) => `${rules[w].name} -(${owner_label(key.owner)}.${key.name})->`).join(" ");
	return `dependency cycle: ${text} ${rules[cycle[0][0]].name}; break it by reading the previous value of one key (reads_previous)`;
}
