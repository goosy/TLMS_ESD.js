import "./share.js"; // must be first: sets LOG_LEVEL
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { once } from "node:events";
import net from "node:net";
import test, { describe } from "node:test";
import { Modbus_Client } from "es-modbus";
import { S7Endpoint } from "@st-one-io/nodes7";
import { MTClient, createMTServer } from "../src/drivers/modbusTCP.js";
import { Unit_Map } from "../src/typed_data/server.js";
import { S7Client } from "../src/drivers/s7.js";

const HOST = "127.0.0.1";
const UNIT = 5;
const OTHER_UNIT = 9; // never attached: the server answers exception 0x0B
const EVENT_TIMEOUT = 3000;
// short times so that reconnects and escalations happen quickly
const RECONNECT_TIME = 200;
const CONNFAILED_TIME = 200;

/** Returns a TCP port that is free right now. */
async function free_port() {
	const probe = net.createServer();
	await new Promise((resolve) => probe.listen(0, HOST, resolve));
	const { port } = probe.address();
	await new Promise((resolve) => probe.close(resolve));
	return port;
}

/** Waits for one event, failing after EVENT_TIMEOUT ms. */
function next_event(emitter, name) {
	return once(emitter, name, { signal: AbortSignal.timeout(EVENT_TIMEOUT) });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A minimal TData stand-in: the server reads buffer and size, and writes
 * through write_register and write_bit; check_count counts the writes.
 */
function fake_tdata(size) {
	const buffer = Buffer.alloc(size);
	for (let i = 0; i < size; i++) buffer[i] = i & 0xff;
	return {
		buffer,
		size,
		check_count: 0,
		write_register(offset, value) {
			buffer.writeUInt16BE(value, offset);
			this.check_count++;
		},
		write_bit(offset, mask, value) {
			buffer[offset] = value ? buffer[offset] | mask : buffer[offset] & ~mask;
			this.check_count++;
		},
	};
}

/**
 * Starts a controller-side server with one unit: `data` at byte 0 and
 * `command` at byte 400, as run_controller attaches an actuator.
 */
async function start_server(t) {
	const data = fake_tdata(32);
	const command = fake_tdata(16);
	const unit_map = new Unit_Map();
	unit_map.attach_unit(UNIT, data, 0);
	unit_map.attach_unit(UNIT, command, 400);
	const port = await free_port();
	const server = createMTServer(HOST, port, unit_map);
	await server.start();
	t.after(() => server.stop());
	return { server, port, data, command };
}

/** Creates an MTClient and waits until it is connected. */
async function connect_client(t, port, options = {}) {
	const client = new MTClient({
		host: HOST, port, reconnect_time: RECONNECT_TIME, connfailed_time: CONNFAILED_TIME, ...options,
	});
	t.after(() => client.stop());
	await next_event(client, "connect");
	return client;
}

/** Records every frame the client writes. */
function record_frames(client) {
	const frames = [];
	client.on("send", (frame) => frames.push(Buffer.from(frame)));
	return frames;
}

// Modbus TCP frame: 7-byte MBAP header, then function code and PDU data.
const fc_of = (frame) => frame[7];
const addr_of = (frame) => frame.readUInt16BE(8);
const quantity_of = (frame) => frame.readUInt16BE(10);

/** Fails the test on any unhandled rejection while it runs. */
function track_unhandled(t) {
	const rejections = [];
	const listener = (reason) => rejections.push(reason);
	process.on("unhandledRejection", listener);
	t.after(() => process.off("unhandledRejection", listener));
	return rejections;
}

/** Counts how often each named event is emitted. */
function count_events(emitter, ...names) {
	const counts = Object.fromEntries(names.map((name) => [name, 0]));
	for (const name of names) emitter.on(name, () => counts[name]++);
	return counts;
}

describe("MTClient read/write", () => {
	test("reads holding registers with FC 03 at PDU address start >> 1", async (t) => {
		const { port, data } = await start_server(t);
		const client = await connect_client(t, port);
		const frames = record_frames(client);

		const buffer = await client.read({ start: 4, length: 6 }, UNIT);

		assert.deepEqual(buffer, data.buffer.subarray(4, 10));
		assert.equal(frames.length, 1);
		assert.equal(fc_of(frames[0]), 3);
		assert.equal(addr_of(frames[0]), 2);
		assert.equal(quantity_of(frames[0]), 3);
	});

	test("writes one register with FC 06", async (t) => {
		const { port, data } = await start_server(t);
		const client = await connect_client(t, port);
		const frames = record_frames(client);

		const ok = await client.write(Buffer.from([0xab, 0xcd]), { start: 6, length: 2 }, UNIT);

		assert.equal(ok, true);
		assert.equal(fc_of(frames[0]), 6);
		assert.equal(addr_of(frames[0]), 3);
		assert.deepEqual(data.buffer.subarray(6, 8), Buffer.from([0xab, 0xcd]));
	});

	test("writes several registers with FC 16", async (t) => {
		const { port, data } = await start_server(t);
		const client = await connect_client(t, port);
		const frames = record_frames(client);

		const ok = await client.write(Buffer.from([1, 2, 3, 4]), { start: 8, length: 4 }, UNIT);

		assert.equal(ok, true);
		assert.equal(fc_of(frames[0]), 16);
		assert.equal(addr_of(frames[0]), 4);
		assert.equal(quantity_of(frames[0]), 2);
		assert.deepEqual(data.buffer.subarray(8, 12), Buffer.from([1, 2, 3, 4]));
	});

	test("addresses registers beyond 9999", async (t) => {
		const far = fake_tdata(8);
		const unit_map = new Unit_Map();
		unit_map.attach_unit(UNIT, far, 20000); // register 10000
		const port = await free_port();
		const server = createMTServer(HOST, port, unit_map);
		await server.start();
		t.after(() => server.stop());
		const client = await connect_client(t, port);
		const frames = record_frames(client);

		assert.equal(await client.write(Buffer.from([9, 8, 7, 6]), { start: 20000, length: 4 }, UNIT), true);
		assert.deepEqual(await client.read({ start: 20000, length: 4 }, UNIT), Buffer.from([9, 8, 7, 6]));
		assert.deepEqual(frames.map(addr_of), [10000, 10000]);
	});

	test("invalid arguments fail the request instead of throwing", async (t) => {
		const { port } = await start_server(t);
		const client = await connect_client(t, port);
		const rejections = track_unhandled(t);
		const counts = count_events(client, "io_error");

		// unit_id out of 0..255, and 126 registers (above the FC 03 limit of 125)
		assert.equal(await client.read({ start: 0, length: 4 }, 300), null);
		assert.equal(await client.write(Buffer.alloc(2), { start: 0, length: 2 }, 300), false);
		assert.equal(await client.read({ start: 0, length: 252 }, UNIT), null);
		await sleep(20);

		assert.equal(counts.io_error, 1);
		assert.deepEqual(rejections, []);
	});

	test("a write whose response does not echo the request fails", async (t) => {
		// a peer that answers FC 16 with a quantity one more than requested
		const sockets = new Set();
		const peer = net.createServer((socket) => {
			sockets.add(socket);
			socket.on("data", (request) => {
				const response = Buffer.from(request.subarray(0, 12));
				response.writeUInt16BE(6, 4); // MBAP length: unit + FC + address + quantity
				response.writeUInt16BE(request.readUInt16BE(10) + 1, 10);
				socket.write(response);
			});
		});
		const port = await free_port();
		await new Promise((resolve) => peer.listen(port, HOST, resolve));
		t.after(() => new Promise((resolve) => {
			for (const socket of sockets) socket.destroy();
			peer.close(resolve);
		}));
		const client = await connect_client(t, port);
		const counts = count_events(client, "io_error");

		const ok = await client.write(Buffer.from([1, 2, 3, 4]), { start: 0, length: 4 }, UNIT);

		assert.equal(ok, false);
		assert.equal(counts.io_error, 1);
		assert.equal(client.io_error, true);
	});
});

describe("Base_Driver IO state", () => {
	test("io_error and io_ok are emitted only on state changes", async (t) => {
		const { port } = await start_server(t);
		const client = await connect_client(t, port, { connfailed_time: 60000 });
		const counts = count_events(client, "io_error", "io_ok", "data_error");

		for (let i = 0; i < 3; i++) {
			assert.equal(await client.read({ start: 0, length: 2 }, OTHER_UNIT), null);
		}
		assert.equal(client.io_error, true);
		assert.ok(await client.read({ start: 0, length: 2 }, UNIT));
		await client.read({ start: 0, length: 2 }, UNIT);

		assert.equal(client.io_error, false);
		// the library's own per-transaction event stays separate
		assert.deepEqual(counts, { io_error: 1, io_ok: 1, data_error: 3 });
	});

	test("a lasting IO error escalates to connfailed", async (t) => {
		const { port } = await start_server(t);
		const client = await connect_client(t, port);

		const connfailed = next_event(client, "connfailed");
		await client.read({ start: 0, length: 2 }, OTHER_UNIT);
		const [reason] = await connfailed;

		assert.equal(reason, "unable to retrieve data");
		assert.equal(client.is_connected, true);
	});

	test("a recovered IO error does not escalate", async (t) => {
		const { port } = await start_server(t);
		const client = await connect_client(t, port);
		const counts = count_events(client, "connfailed");

		await client.read({ start: 0, length: 2 }, OTHER_UNIT);
		await client.read({ start: 0, length: 2 }, UNIT);
		await sleep(CONNFAILED_TIME * 2);

		assert.equal(counts.connfailed, 0);
	});

	test("a closed peer emits connfailed and the client reconnects", async (t) => {
		const { server, port } = await start_server(t);
		const client = await connect_client(t, port);
		const counts = count_events(client, "connfailed");

		const connfailed = next_event(client, "connfailed");
		await server.stop();
		await connfailed;
		assert.equal(client.is_connected, false);

		const reconnected = next_event(client, "connect");
		await server.start();
		await reconnected;

		assert.ok(await client.read({ start: 0, length: 2 }, UNIT));
		assert.equal(client.connfailed, false);
		assert.equal(counts.connfailed, 1);
	});

	test("stop() disconnects and start() connects again", async (t) => {
		const { port } = await start_server(t);
		const client = await connect_client(t, port);
		client.start();

		client.stop();
		await next_event(client, "disconnect");
		await sleep(RECONNECT_TIME * 2);
		assert.equal(client.is_connected, false);
		assert.equal(client.enable_reconnect, false);

		const reconnected = next_event(client, "connect");
		client.start();
		await reconnected;
		assert.ok(await client.read({ start: 0, length: 2 }, UNIT));
	});

	test("connect and disconnect are not shadowed by Base_Driver", (t) => {
		const client = new MTClient({ host: HOST, port: 1 });
		t.after(() => client.stop());
		assert.equal(client.connect, Modbus_Client.prototype.connect);
		assert.equal(client.disconnect, Modbus_Client.prototype.disconnect);

		// no connection attempt: a disconnect() during an S7 connect leaves
		// a nodes7 timer running for about 5 s
		t.mock.method(S7Endpoint.prototype, "_connect", () => { });
		const s7 = new S7Client({ host: HOST, port: 1 });
		t.after(() => s7.disconnect());
		assert.equal(s7.connect, S7Endpoint.prototype.connect);
		assert.equal(s7.disconnect, S7Endpoint.prototype.disconnect);
	});
});

describe("createMTServer", () => {
	/** Starts a server and an es-modbus client in the HMI role. */
	async function setup(t) {
		const ctx = await start_server(t);
		const hmi = new Modbus_Client(HOST, { port: ctx.port, reconnect_time: 0 });
		hmi.on("error", () => { });
		t.after(() => hmi.disconnect());
		return { ...ctx, hmi };
	}

	test("serves holding and input registers big-endian", async (t) => {
		const { hmi, data } = await setup(t);

		assert.deepEqual(await hmi.read([3, 1, 2], UNIT), data.buffer.subarray(2, 6));
		assert.deepEqual(await hmi.read([4, 1, 2], UNIT), data.buffer.subarray(2, 6));
	});

	test("routes addresses to the TData attached at them", async (t) => {
		const { hmi, data, command } = await setup(t);

		// register 200 is byte 400, the start of command
		assert.deepEqual(await hmi.read([3, 200, 2], UNIT), command.buffer.subarray(0, 4));
		assert.equal(await hmi.write([16, 201, 1], Buffer.from([0x12, 0x34]), UNIT), true);

		assert.deepEqual(command.buffer.subarray(2, 4), Buffer.from([0x12, 0x34]));
		assert.equal(command.check_count, 1);
		assert.equal(data.check_count, 0);
	});

	test("register writes update the buffer and check the tags", async (t) => {
		const { hmi, data } = await setup(t);

		assert.equal(await hmi.write([6, 3, 1], 0xbeef, UNIT), true);
		assert.equal(await hmi.write([16, 4, 2], Buffer.from([1, 2, 3, 4]), UNIT), true);

		assert.equal(data.buffer.readUInt16BE(6), 0xbeef);
		assert.deepEqual(data.buffer.subarray(8, 12), Buffer.from([1, 2, 3, 4]));
		assert.equal(data.check_count, 3); // one per register written
	});

	// The scan request of a write is coalesced with setImmediate
	// (doc/design.md 3.4): it relies on es-modbus calling the vector for
	// every register of an FC 16 request within one synchronous call.
	test("an FC 16 request writes all its registers in one synchronous call", async (t) => {
		const { hmi, data } = await setup(t);
		let turn_ended = false;
		const turns = [];
		const write_register = data.write_register;
		data.write_register = function (offset, value) {
			if (turns.length === 0) setImmediate(() => { turn_ended = true; });
			turns.push(turn_ended);
			write_register.call(this, offset, value);
		};

		assert.equal(await hmi.write([16, 2, 3], Buffer.from([1, 2, 3, 4, 5, 6]), UNIT), true);

		assert.deepEqual(turns, [false, false, false]);
	});

	test("coil addr maps to bit addr % 8 of byte addr >> 3", async (t) => {
		const { hmi, data } = await setup(t);
		data.buffer[1] = 0b0000_0010; // coil 9 set, coils 8 and 10..15 clear

		assert.deepEqual(await hmi.read([1, 8, 8], UNIT), Buffer.from([0b0000_0010]));
		assert.deepEqual(await hmi.read([2, 9, 1], UNIT), Buffer.from([1]));

		assert.equal(await hmi.write([5, 12, 1], true, UNIT), true);
		assert.equal(await hmi.write([5, 9, 1], false, UNIT), true);
		assert.equal(data.buffer[1], 0b0001_0000);
		assert.equal(data.check_count, 2);
	});

	test("a unit that is not attached is answered with exception 0x0B", async (t) => {
		const { hmi } = await setup(t);

		await assert.rejects(hmi.read([3, 0, 1], OTHER_UNIT), { message: "response error: 11" });
	});

	test("an unmapped address reads as 0 and ignores writes", async (t) => {
		const { hmi, data, command } = await setup(t);
		const data_before = Buffer.from(data.buffer);
		const command_before = Buffer.from(command.buffer);

		// registers 16..199 lie between data (bytes 0..31) and command (from byte 400)
		assert.deepEqual(await hmi.read([3, 14, 4], UNIT), Buffer.concat([data.buffer.subarray(28, 32), Buffer.alloc(4)]));
		assert.equal(await hmi.write([16, 100, 2], Buffer.from([1, 2, 3, 4]), UNIT), true);
		assert.equal(await hmi.write([5, 1000, 1], true, UNIT), true);
		assert.deepEqual(await hmi.read([1, 1000, 1], UNIT), Buffer.from([0]));

		assert.deepEqual(data.buffer, data_before);
		assert.deepEqual(command.buffer, command_before);
		assert.equal(data.check_count + command.check_count, 0);
	});
});
