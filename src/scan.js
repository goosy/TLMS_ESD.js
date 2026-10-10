// The scan scheduler of the controller (doc/design-scan.md 6).
import { TData } from "./typed_data/TData.js";
import { set_access_tracer } from "./typed_data/layout.js";
import { Binding } from "./drivers/binding.js";
import { Ticker, order_rules, component_bits, PREVIOUS_BINDING_STATES } from "./rules.js";

const same_value = (a, b) => a === b || (Number.isNaN(a) && Number.isNaN(b));

export class Scheduler {
	#period;
	#on_error;
	#data_blocks = [];
	#bindings = [];
	#vars = new Map();
	#rules = [];
	#ordered = null;
	#running_tickers = new Set();
	#phase = "idle";
	#immediate = null;
	#interval = null;
	#binding_previous = new Map();
	#var_previous = new Map();
	// dependency tracing (doc/design-scan.md 7.6)
	#current_rule = null;

	/**
	 * @param {Object} options
	 * @param {number} options.period - Milliseconds between periodic ticks.
	 * @param {(error: Error, source: Object) => void} [options.on_error] - Reports isolated errors (6.4).
	 */
	constructor({ period, on_error } = {}) {
		if (!(period > 0)) throw new Error(`invalid scan period ${period}`);
		this.#period = period;
		this.#on_error = on_error;
	}

	get period() { return this.#period; }
	/** "idle", or the phase of the scan in progress: "input", "evaluate", "publish", "output". */
	get phase() { return this.#phase; }

	#check_open() {
		if (this.#ordered) throw new Error("the scheduler is prepared: nothing more can be added");
	}

	/** A data block detected in the publish phase, snapshot at the end of a scan. */
	add_data(tdata) {
		this.#check_open();
		this.#data_blocks.push(tdata);
	}

	/**
	 * A binding flushed in the output phase. With an input group, it is also
	 * read on periodic ticks and loaded in the input phase; without one, it
	 * is output only (doc/design-scan.md 6.5).
	 */
	add_binding(binding, input_group) {
		this.#check_open();
		this.#bindings.push({ binding, input_group });
	}

	/** A shared variable: the property `name` of the object `owner`. */
	add_var(owner, name) {
		this.#check_open();
		if (owner === null || typeof owner !== "object") throw new Error(`variable ${name}: the owner must be an object`);
		if (!this.#vars.has(owner)) this.#vars.set(owner, new Set());
		this.#vars.get(owner).add(name);
	}

	/** A rule built by derive() / act(). */
	add_rule(rule) {
		this.#check_open();
		this.#rules.push(rule);
	}

	/**
	 * Orders and checks the rules (doc/design-scan.md 7.4), gives each a
	 * ticker and takes the first snapshot of the previous values.
	 * @throws {Error} With `errors`, every violation found.
	 */
	prepare() {
		this.#check_open();
		const ordered = order_rules(this.#rules, (owner, name) => this.#vars.get(owner)?.has(name) ?? false);
		this.#ordered = ordered.map((rule) => ({ rule, ticker: new Ticker(this.#running_tickers, this.#period) }));
		this.#take_snapshots();
	}

	/** The rules in execution order. */
	get ordered_rules() {
		return this.#ordered?.map(({ rule }) => rule) ?? [];
	}

	/** Starts the periodic ticks. */
	start() {
		if (!this.#ordered) throw new Error("prepare() the scheduler before starting it");
		this.stop();
		this.#interval = setInterval(() => this.#tick(), this.#period);
	}

	stop() {
		if (this.#interval) clearInterval(this.#interval);
		if (this.#immediate) clearImmediate(this.#immediate);
		this.#interval = null;
		this.#immediate = null;
	}

	/**
	 * Requests a triggered scan, coalesced with setImmediate (6.2). A request
	 * made in the input or evaluate phase is ignored: the write behind it is
	 * detected in this scan; a later one schedules the next scan.
	 */
	request_scan() {
		if (this.#phase === "input" || this.#phase === "evaluate") return;
		this.#schedule();
	}

	/** Schedules a triggered scan, coalescing with one already scheduled. */
	#schedule() {
		if (this.#immediate) return;
		this.#immediate = setImmediate(() => {
			this.#immediate = null;
			this.scan(false);
		});
	}

	#tick() {
		// a pending triggered scan is done by this periodic one
		if (this.#immediate) {
			clearImmediate(this.#immediate);
			this.#immediate = null;
		}
		this.scan(true);
	}

	#guarded(fn, source) {
		try {
			fn();
		} catch (error) {
			this.#on_error?.(error, source);
		}
	}

	/**
	 * Runs one scan (6.1): input, evaluate, publish, output.
	 * @param {boolean} tick - Whether it is a periodic tick, which advances the tickers and starts reads.
	 */
	scan(tick) {
		if (!this.#ordered) throw new Error("prepare() the scheduler before scanning");
		if (this.#phase !== "idle") {
			// called from inside a scan: run it after this one
			this.#schedule();
			return;
		}
		try {
			this.#phase = "input";
			for (const { binding, input_group } of this.#bindings) {
				if (input_group && binding.fresh) this.#guarded(() => binding.load(input_group), binding);
			}
			if (tick) for (const ticker of this.#running_tickers) ticker.count++;

			this.#phase = "evaluate";
			for (const { rule, ticker } of this.#ordered) {
				this.#current_rule = rule;
				this.#guarded(() => rule.run(ticker), rule);
			}
			this.#current_rule = null;

			this.#phase = "publish";
			for (const data of this.#data_blocks) this.#guarded(() => data.detect(), data);
			this.#take_snapshots();

			this.#phase = "output";
			const report = (source) => (error) => this.#on_error?.(error, source);
			for (const { binding, input_group } of this.#bindings) {
				binding.flush_writes().catch(report(binding));
				if (tick && input_group) binding.request_read().catch(report(binding));
			}
		} finally {
			this.#current_rule = null;
			this.#phase = "idle";
		}
	}

	#take_snapshots() {
		for (const data of this.#data_blocks) data.observer.take_scan_snapshot();
		for (const { binding } of this.#bindings) {
			const states = {};
			for (const name of PREVIOUS_BINDING_STATES) states[name] = binding[name];
			this.#binding_previous.set(binding, states);
		}
		for (const [owner, names] of this.#vars) {
			const values = new Map();
			for (const name of names) values.set(name, owner[name]);
			this.#var_previous.set(owner, values);
		}
	}

	/**
	 * The value of a key at the end of the last scan (doc/design-scan.md 5.3):
	 * a tag of a data block, a binding state or a registered variable.
	 * @throws {Error} For any other key.
	 */
	previous(owner, name) {
		if (owner instanceof TData) return owner.observer.previous(name);
		if (owner instanceof Binding) {
			if (!PREVIOUS_BINDING_STATES.includes(name)) throw new Error(`binding state ${name} has no previous value`);
			return this.#binding_previous.get(owner)?.[name] ?? owner[name];
		}
		const values = this.#var_previous.get(owner);
		if (!values?.has(name)) throw new Error(`${owner?.name ?? "object"}.${name}: not a registered variable`);
		return values.get(name);
	}

	rose(owner, name) { return !this.previous(owner, name) && Boolean(owner[name]); }
	fell(owner, name) { return Boolean(this.previous(owner, name)) && !owner[name]; }
	changed(owner, name) { return !same_value(this.previous(owner, name), owner[name]); }

	/**
	 * Test mode (doc/design-scan.md 7.6): records every tag accessed by a
	 * rule without being declared. Returns the list it fills, as
	 * "rule: data.tag read|write" lines.
	 */
	trace_dependencies() {
		// per rule and mode: the declared names of each owner
		const declared = new Map();
		const add = (map, owner, name) => {
			if (!map.has(owner)) map.set(owner, new Set());
			map.get(owner).add(name);
		};
		for (const rule of this.#rules) {
			const keys = { read: new Map(), write: new Map() };
			for (const [owner, name] of rule.writes) {
				add(keys.write, owner, name);
				add(keys.read, owner, name);
			}
			for (const [owner, name] of rule.reads) {
				add(keys.read, owner, name);
				// a combined word is read through its bits (doc/design-scan.md 7.1)
				if (owner instanceof TData) for (const bit of component_bits(owner.layout, name)) add(keys.read, owner, bit);
			}
			declared.set(rule, keys);
		}
		const undeclared = [];
		set_access_tracer((tdata, name, mode) => {
			const rule = this.#current_rule;
			if (!rule) return;
			const names = declared.get(rule)[mode].get(tdata);
			if (names?.has(name)) return;
			// a read of a combined word whose bits are all declared
			const bits = component_bits(tdata.layout, name);
			if (mode === "read" && bits.length > 0 && bits.every((bit) => names?.has(bit))) return;
			const line = `${rule.name}: ${tdata.name}.${name} ${mode}`;
			if (!undeclared.includes(line)) undeclared.push(line);
		});
		return undeclared;
	}

	/** Ends the test mode. */
	untrace_dependencies() {
		set_access_tracer(null);
	}
}
