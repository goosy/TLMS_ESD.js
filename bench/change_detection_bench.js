// Benchmark of reading a NODE data block (doc/design.md 3.5): loading
// every tag from a device-ordered IO buffer, then detecting and reporting the
// changes. Not part of `pnpm test`.
// Run: node bench/change_detection_bench.js
process.env.LOG_LEVEL = "off";
const { Buffer } = await import("node:buffer");
const { TData } = await import("../src/typed_data/TData.js");
const { load_entry } = await import("../src/typed_data/endian.js");
const { NODE } = await import("../src/layouts.js");

const ITER = 200_000;
const size = NODE.length >> 3;

function make_reader(endian) {
	const data = new TData(NODE, "bench");
	let events = 0;
	data.on("change", () => { events++; });
	const entries = [...data.layout.entries.values()];
	const read = (io) => {
		for (const entry of entries) load_entry(entry, io, data.buffer, endian);
		data.detect();
	};
	return { read, events: () => events };
}

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

function bench(reader, frames) {
	for (let i = 0; i < 20_000; i++) reader.read(frames[i & 1]); // warm-up
	const t0 = process.hrtime.bigint();
	for (let i = 0; i < ITER; i++) reader.read(frames[i & 1]);
	return Number(process.hrtime.bigint() - t0) / ITER;
}

const rows = [];
for (const endian of ["BE", "LEBS"]) {
	for (const kind of ["none", "3 reals", "status bits", "all"]) {
		const reader = make_reader(endian);
		const ns = bench(reader, make_frames(kind));
		rows.push({ "endian": endian, "scenario": kind, "ns/cycle": ns.toFixed(0) });
	}
}
console.log(`NODE: ${NODE.items.length} tags, ${size} bytes, ${ITER} cycles each`);
console.table(rows);
