import { Modbus_Client, Modbus_Server } from "es-modbus";
import { Base_Driver } from "./base.js";
import { logger } from "../util.js";

// initial reconnect delay, doubled after each failed attempt up to RECONNECT_MAX
const RECONNECT_TIME = 5000;
const RECONNECT_MAX = 20000;

// Modbus function codes for holding registers
const FC_READ_HOLDING = 3;
const FC_WRITE_SINGLE = 6;
const FC_WRITE_MULTIPLE = 16;

/**
 * Converts a byte range to a structured PDU range of holding registers.
 *
 * @param {number} func_code - The Modbus function code.
 * @param {{start:number, length:number}} range - The byte range.
 * @return {number[]} The PDU range `[func_code, pdu_addr, length]`.
 */
function pdu_range(func_code, range) {
	return [func_code, range.start >> 1, range.length >> 1];
}

export class MTClient extends Modbus_Client {
	connfailed = false;
	// smallest writable unit in bytes: one holding register
	write_unit = 2;

	/**
	 * Constructs a new instance of the MTClient class.
	 *
	 * @param {Object} options - The options for the MTClient.
	 * @param {string} options.host - The IP address of the TCP Port. Defaults to '127.0.0.1'.
	 * @param {number} options.port - The port number. Defaults to 502.
	 * @param {number} options.unit_id - The unit ID. Defaults to 1.
	 * @param {number} [options.period_time] - The period time.
	 * @param {number} [options.reconnect_time] - The initial reconnect delay in ms.
	 * @param {number} [options.reconnect_max] - The longest reconnect delay in ms.
	 * @param {number} [options.connfailed_time] - How long an IO error lasts before `connfailed`, in ms.
	 */
	constructor(options) {
		const host = typeof options.host === "string" ? options.host : "127.0.0.1";
		const port = typeof options.port === "number" ? options.port : 502;
		const rtu = false;
		const reconnect_time = options?.reconnect_time ?? RECONNECT_TIME;
		const reconnect_max = options?.reconnect_max ?? RECONNECT_MAX;
		super(host, { port, rtu, reconnect_time, reconnect_max });
		this.conn_str = `modbus://${host}:${port}`;
		this.host = host;
		this.port = port;
		if (options?.period_time) this.period_time = options.period_time;
		if (options?.connfailed_time) this.connfailed_time = options.connfailed_time;
		// super own reconnection mechanism is used instead.
		this.start_tick = function () {
			if (this.started) {
				if (this.is_connected) {
					this.emit("tick");
					this.connfailed = false;
				}
			} else {
				clearInterval(this.loop);
			}
		};

		this.on("error", this.on_error);
		this.on("connect", () => {
			logger.info(`connected to ${this.conn_str}!`);
			this.connfailed = false;
		});
		this.on("disconnect", this.on_error);

		Object.mixin(this, new Base_Driver());
	}

	get is_connected() { return super.is_connected; }

	on_error(error) {
		if (!this.connfailed) {
			this.emit("connfailed", error?.message ?? error ?? "unknown error");
		}
		this.connfailed = true;
	}

	// connect() inherited from superclass
	// disconnect() inherited from superclass

	/**
	 * Reads the holding registers within the specified area asynchronously.
	 *
	 * @param {{start:number, length:number}} range - The area to read from, specified as an object with start and length properties with unit byte.
	 * @return {Promise<Buffer|null>} A promise that resolves with the buffer containing the read data, or null if the read operation fails.
	 */
	read(range, unit_id) {
		const resolve = this.emit_io_ok.bind(this);
		const reject = this.emit_io_error.bind(this);
		let request;
		try {
			request = super.read(pdu_range(FC_READ_HOLDING, range), unit_id);
		} catch (e) {
			// es-modbus throws synchronously on invalid arguments
			logger.error(`invalid read on ${this.conn_str} unit ${unit_id}: ${e.message}`);
			return reject(e);
		}
		return request.then(resolve, reject);
	}

	/**
	 * Writes the given buffer to the specified area asynchronously.
	 *
	 * @param {Buffer} buffer - The buffer containing the data to be written.
	 * @param {{start:number, length:number}} range - The area to write to, specified as an object with start and length properties with unit byte.
	 * @return {Promise<boolean>} A promise that resolves when the write operation is complete.
	 */
	write(buffer, range, unit_id) {
		const resolve = (echoed) => {
			if (!echoed) {
				// the response does not echo the request: the write is not confirmed
				logger.warn(`write on ${this.conn_str} unit ${unit_id} at byte ${range.start} not echoed`);
				this.emit_io_error(new Error("write not echoed"));
				return false;
			}
			this.emit_io_ok();
			return true;
		};
		const reject = (e) => {
			this.emit_io_error(e);
			return false;
		};
		let request;
		try {
			const length = range.length ?? buffer.length;
			const func_code = length === 2 ? FC_WRITE_SINGLE : FC_WRITE_MULTIPLE;
			request = super.write(pdu_range(func_code, { start: range.start, length }), buffer, unit_id);
		} catch (e) {
			// es-modbus throws synchronously on invalid arguments
			logger.error(`invalid write on ${this.conn_str} unit ${unit_id}: ${e.message}`);
			return Promise.resolve(reject(e));
		}
		return request.then(resolve, reject);
	}
}

const get_register_info = (addr, units) => {
	const byte_offset = addr * 2;
	for (const { tdata, start, offset, end } of units) {
		if (tdata.buffer && byte_offset >= start && byte_offset < end) {
			// return.offset: the index in the buffer
			return { tdata, offset: byte_offset + offset - start };
		}
	}
	return { tdata: null, offset: -1 };
};

const get_coil_info = (addr, units) => {
	const byte_offset = addr >> 3;
	const bit_offset = addr % 8;
	const bit_mask = 1 << bit_offset;
	for (const { tdata, start, offset, end } of units) {
		if (tdata.buffer && byte_offset >= start && byte_offset < end) {
			// return.offset: the index in the buffer
			return { tdata, offset: byte_offset + offset - start, bit_mask };
		}
	}
	return { tdata: null, offset: -1 };
};

/**
 * Creates the es-modbus server vector that serves the data blocks of a unit map.
 *
 * @param {Unit_Map} unit_map - The data blocks attached per unit id.
 * @return {Object} The vector: get_input_register, get_holding_register, set_register, get_coil, set_coil.
 */
export function create_vector(unit_map) {
	// An unmapped address (e.g. the gap between the node data and command
	// blocks) reads as 0 and ignores writes, so that a block read by the HMI
	// spanning the gap still succeeds. Each one is logged once.
	const reported = new Set();
	const report_unmapped = (kind, addr, unit_id) => {
		const key = `${kind}:${unit_id}:${addr}`;
		if (reported.has(key)) return;
		reported.add(key);
		logger.warn(`unmapped ${kind} address ${addr} in unit ${unit_id}`);
	};

	const read_register = (kind) => (addr, unit_id) => {
		const { tdata, offset } = get_register_info(addr, unit_map[unit_id]);
		if (tdata == null) {
			report_unmapped(kind, addr, unit_id);
			return 0;
		}
		return tdata.buffer.readUInt16BE(offset);
	};

	const vector = {
		get_input_register: read_register("input register"),
		get_holding_register: read_register("holding register"),
		set_register: (addr, value, unit_id) => {
			const { tdata, offset } = get_register_info(addr, unit_map[unit_id]);
			if (tdata == null) {
				report_unmapped("holding register", addr, unit_id);
				return;
			}
			tdata.buffer.writeUInt16BE(value, offset);
			tdata.detect();
		},

		get_coil: (addr, unit_id) => {
			const { tdata, offset, bit_mask } = get_coil_info(addr, unit_map[unit_id]);
			if (tdata == null) {
				report_unmapped("coil", addr, unit_id);
				return false;
			}
			return (tdata.buffer.readUInt8(offset) & bit_mask) > 0;
		},

		set_coil: (addr, value, unit_id) => {
			const { tdata, offset, bit_mask } = get_coil_info(addr, unit_map[unit_id]);
			if (tdata == null) {
				report_unmapped("coil", addr, unit_id);
				return;
			}
			let byte = tdata.buffer.readUInt8(offset);
			if (value) byte = byte | bit_mask;
			else byte = byte & ~bit_mask;
			tdata.buffer.writeUInt8(byte, offset);
			tdata.detect();
		},
	};
	return vector;
}

/**
 * @param {string} host the ip of the TCP Port - required.
 * @param {number} port the Port number - default 502.
 * @param {Unit_Map} unit_map - The data blocks served per unit id.
 */
export function createMTServer(host = "0.0.0.0", port = 502, unit_map = {}) {
	const vector = create_vector(unit_map);
	const server = new Modbus_Server(vector, { host, port, unit_id: unit_map.unit_ids });
	server.on("start", () => {
		logger.info(`ModbusTCP server listening on modbus://${host}:${port}`);
	});
	server.on("socket_error", (err) => {
		logger.error(`client error: ${err.message}`);
	});
	server.on("socket_connect", (socket) => {
		logger.info(`client connected: ${socket.remoteAddress}:${socket.remotePort}`);
	});
	server.on("socket_disconnect", (socket) => {
		logger.error(`client disconnected: ${socket.remoteAddress}:${socket.remotePort}`);
	});
	server.on("error", (err) => {
		logger.error(`server error: ${err.message}`);
	});
	server.on("vector_error", (err) => {
		logger.error(`server request failed: ${err.message}`);
	});
	server.on("stop", () => {
		logger.error(`ModbusTCP server modbus://${host}:${port} stoped!`);
	});

	return server;
}

export class Unit_Map {
	unit_ids = [];

	/**
	 * Attaches a unit to the unit map.
	 *
	 * @param {number} unit_id - The ID of the unit.
	 * @param {import('../typed_data/TData.js').TData} tdata - The TData object that contains the data associated with the unit.
	 * @param {number} [start=0] - The starting index of the unit's data.
	 * @param {number} [offset=0] - The starting index of the TData object.
	 * @return {void} This function does not return anything.
	 */
	attach_unit(unit_id, tdata, start = 0, offset = 0) {
		if (this[unit_id] == null) {
			this.unit_ids.push(unit_id);
			this[unit_id] = [];
		}
		this[unit_id].push({
			tdata,
			start,
			offset,
			end: tdata.size - offset + start,
		});
	}
}
