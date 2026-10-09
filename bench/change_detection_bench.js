// Benchmark of change detection on the NODE layout (doc/plan-scan.md step 0):
// the current per-tag check (TGroup.read body) against a snapshot byte diff
// (doc/design-scan.md 5.1). Not part of `pnpm test`.
// Run: node bench/change_detection_bench.js
process.env.LOG_LEVEL = "off";
const { Buffer } = await import("node:buffer");
const { EventEmitter } = await import("node:events");
const { TData } = await import("../src/typed_data/TData.js");
const { NODE } = await import("../src/structs/node.js");

const ITER = 200_000;
const payload_names = NODE.items.map((i) => i.name);

// ---------- A: current implementation (TGroup.read body) ----------
function make_current(endian) {
	const data = new TData(NODE, "A");
	let events = 0;
	data.on("change", () => { events++; });
	const tags = payload_names.map((n) => data.get(n));
	const read = (io) => {
		for (const tag of tags) {
			tag.read_from(io, endian);
			data.check_coupling(tag.name);
		}
	};
	return { read, events: () => events };
}

// ---------- B: snapshot diff ----------
const DECODE = {
	bool: (b, t) => (b[t.byte] & t.mask) !== 0,
	byte: (b, t) => b.readUInt8(t.byte), usint: (b, t) => b.readUInt8(t.byte), sint: (b, t) => b.readInt8(t.byte),
	int: (b, t) => b.readInt16BE(t.byte), uint: (b, t) => b.readUInt16BE(t.byte), word: (b, t) => b.readUInt16BE(t.byte),
	dint: (b, t) => b.readInt32BE(t.byte), udint: (b, t) => b.readUInt32BE(t.byte), dword: (b, t) => b.readUInt32BE(t.byte),
	real: (b, t) => b.readFloatBE(t.byte),
};
const SIZE = { bool: 1, byte: 1, usint: 1, sint: 1, int: 2, uint: 2, word: 2, dint: 4, udint: 4, dword: 4, real: 4 };

function make_diff(endian) {
	const size = NODE.length >> 3;
	const buffer = Buffer.alloc(size);
	const snapshot = Buffer.alloc(size);
	const tags = NODE.items.map((i) => {
		const type = i.type.toLowerCase();
		return { name: i.name, type, byte: i.offset >> 3, mask: 1 << (i.offset % 8), size: SIZE[type], decode: DECODE[type] };
	});
	// layout table: byte index -> tags covering that byte
	const tags_at_byte = Array.from({ length: size }, () => []);
	for (const t of tags) for (let k = 0; k < t.size; k++) tags_at_byte[t.byte + k].push(t);
	// registers (2-byte) are the unit of device byte order
	const words = tags.filter((t) => t.size >= 2);

	const emitter = new EventEmitter();
	let events = 0;
	emitter.on("change", () => { events++; });
	const seen = new Set();

	const read = (io) => {
		// 1. IO -> image (endian conversion only, no checks)
		if (endian === "BE") io.copy(buffer, 0, 0, size);
		else { // LEBS: swap 16-bit halves of 4-byte values, registers otherwise as is
			io.copy(buffer, 0, 0, size);
			for (const t of words) if (t.size === 4) {
				const i = t.byte;
				buffer[i] = io[i + 2]; buffer[i + 1] = io[i + 3];
				buffer[i + 2] = io[i]; buffer[i + 3] = io[i + 1];
			}
		}
		// 2. diff with snapshot
		seen.clear();
		for (let i = 0; i < size; i++) {
			if (buffer[i] === snapshot[i]) continue;
			for (const t of tags_at_byte[i]) {
				if (seen.has(t)) continue;
				seen.add(t);
				const old_value = t.decode(snapshot, t);
				const new_value = t.decode(buffer, t);
				if (old_value !== new_value && !(Number.isNaN(old_value) && Number.isNaN(new_value))) {
					emitter.emit("change", t.name, old_value, new_value);
				}
			}
		}
		buffer.copy(snapshot);
	};
	return { read, events: () => events };
}

// ---------- scenarios ----------
const size = NODE.length >> 3;
function make_frames(kind) {
	// two alternating frames so "changing" tags really change every cycle
	const f0 = Buffer.alloc(size), f1 = Buffer.alloc(size);
	for (let i = 0; i < size; i++) f0[i] = f1[i] = (i * 37) & 0xff;
	if (kind === "3 reals") {
		for (const off of [4, 8, 12]) {
			f1.writeFloatBE(1.5 + off, off);
			f0.writeFloatBE(2.5 + off, off);
		}
	} else if (kind === "status bits") {
		f0[2] = 0x55;
		f1[2] = 0xaa;
		f0[3] = 0x0f;
		f1[3] = 0xf0;
	} else if (kind === "all") {
		for (let i = 0; i < size; i++) f1[i] = ~f0[i] & 0xff;
	}
	return [f0, f1];
}

function bench(label, impl, frames) {
	for (let i = 0; i < 20_000; i++) impl.read(frames[i & 1]); // warm-up
	const t0 = process.hrtime.bigint();
	for (let i = 0; i < ITER; i++) impl.read(frames[i & 1]);
	const ns = Number(process.hrtime.bigint() - t0) / ITER;
	return { label, ns };
}

const rows = [];
for (const endian of ["BE", "LEBS"]) {
	for (const kind of ["none", "3 reals", "status bits", "all"]) {
		const frames = make_frames(kind);
		const a = bench("current", make_current(endian), frames);
		const b = bench("diff", make_diff(endian), frames);
		rows.push({
			"endian": endian,
			"scenario": kind,
			"current ns/cycle": a.ns.toFixed(0),
			"diff ns/cycle": b.ns.toFixed(0),
			"speedup": `${(a.ns / b.ns).toFixed(1)}x`,
		});
	}
}
console.log(`NODE: ${NODE.items.length} tags, ${size} bytes, ${ITER} cycles each`);
console.table(rows);

// sanity: both report the same number of change events
for (const endian of ["BE", "LEBS"]) for (const kind of ["3 reals", "status bits", "all"]) {
	const frames = make_frames(kind);
	const a = make_current(endian), b = make_diff(endian);
	for (let i = 0; i < 10; i++) {
		a.read(frames[i & 1]);
		b.read(frames[i & 1]);
	}
	console.log(`events ${endian}/${kind}: current=${a.events()} diff=${b.events()}`);
}
