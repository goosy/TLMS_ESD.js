import { Modbus_Client } from "es-modbus";
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
