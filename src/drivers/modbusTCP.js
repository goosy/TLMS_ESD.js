import { Modbus_Client, Modbus_Server } from "es-modbus";
import { Base_Driver } from "./base.js";
import { logger } from '../util.js';

export class MTClient extends Modbus_Client {
    connfailed = false;

    /**
     * Constructs a new instance of the MTClient class.
     *
     * @param {Object} options - The options for the MTClient.
     * @param {string} options.host - The IP address of the TCP Port. Defaults to '127.0.0.1'.
     * @param {number} options.port - The port number. Defaults to 502.
     * @param {number} options.unit_id - The unit ID. Defaults to 1.
     * @param {number} [options.period_time] - The period time.
     * @param {number} [options.reconnect_time] - The reconnect time.
     */
    constructor(options) {
        const host = typeof options.host === "string" ? options.host : '127.0.0.1';
        const port = typeof options.port === "number" ? options.port : 502;
        const rtu = false;
        const period_time = options?.period_time;
        const reconnect_time = options?.reconnect_time;
        super(host, { port, rtu });
        this.conn_str = `modbus://${host}:${port}`;
        this.host = host;
        this.port = port;
        if (period_time) this.period_time = period_time;
        if (reconnect_time) this.reconnect_time = reconnect_time;
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
        }

        this.on('error', this.on_error);
        this.on("connect", () => {
            logger.info(`connected to ${this.conn_str}!`);
            this.connfailed = false;
        });
        this.on('disconnect', this.on_error);

        Object.mixin(this, new Base_Driver());
    }

    get is_connected() { return super.is_connected; }

    on_error(error) {
        if (!this.connfailed) {
            this.emit("connfailed", error ?? "unknown error");
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
        const register_address = 40000 + (range.start >> 1) + 1;
        const length = range.length >> 1;
        const resolve = this.emit_data_ok.bind(this);
        const reject = this.emit_data_error.bind(this);
        return super.read(
            `${register_address},${length}`,
            unit_id,
        ).then(resolve, reject);
    }

    /**
     * Writes the given buffer to the specified area asynchronously.
     *
     * @param {Buffer} buffer - The buffer containing the data to be written.
     * @param {{start:number, length:number}} range - The area to write to, specified as an object with start and length properties with unit byte.
     * @return {Promise<boolean>} A promise that resolves when the write operation is complete.
     */
    write(buffer, range, unit_id) {
        const resolve = () => {
            this.emit_data_ok();
            return true;
        }
        const reject = (e) => {
            this.emit_data_error(e);
            return false;
        }
        const register_address = 40000 + (range.start >> 1) + 1;
        const length_str = range.length ? (`,${range.length >> 1}`) : '';
        return super.write(
            `${register_address}${length_str}`,
            buffer, unit_id
        ).then(resolve, reject);
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
 * @param {string} host the ip of the TCP Port - required.
 * @param {number} port the Port number - default 502.
 */
export function createMTServer(host = "0.0.0.0", port = 502, unit_map = {}) {

    const vector = {
        getInputRegister: (addr, unit_id) => {
            const { tdata, offset } = get_register_info(addr, unit_map[unit_id]);
            if (tdata == null) {
                logger.error(`Invalid InputRegister address(${addr}) when reading unit ${unit_id}`);
                return 0;
            }
            if (tdata.LE_list.includes(offset)) return tdata.buffer.readUInt16LE(offset);
            return tdata.buffer.readUInt16BE(offset);
        },
        getHoldingRegister: (addr, unit_id) => {
            const { tdata, offset } = get_register_info(addr, unit_map[unit_id]);
            if (tdata == null) {
                logger.error(`Invalid HoldingRegister address(${addr}) when reading unit ${unit_id}`);
                return 0;
            }
            if (tdata.LE_list.includes(offset)) return tdata.buffer.readUInt16LE(offset);
            return tdata.buffer.readUInt16BE(offset);
        },
        setRegister: (addr, value, unit_id) => {
            const { tdata, offset } = get_register_info(addr, unit_map[unit_id]);
            if (tdata == null) {
                logger.error(`Invalid regsiter address: ${addr} when writing to unit ${unit_id}`);
                return 0;
            }
            if (tdata.LE_list.includes(offset)) tdata.buffer.writeUInt16LE(value, offset);
            else tdata.buffer.writeUInt16BE(value, offset);
            tdata.check_all_tags();
            return;
        },

        getCoil: (addr, unit_id) => {
            const { tdata, offset, bit_mask } = get_coil_info(addr, unit_map[unit_id]);
            if (tdata == null) {
                logger.error(`Invalid coil address: ${addr} for read in unit ${unit_id}`);
                return false;
            }
            return (tdata.buffer.readUInt8(offset) & bit_mask) > 0;
        },

        setCoil: (addr, value, unit_id) => {
            const { tdata, offset, bit_mask } = get_coil_info(addr, unit_map[unit_id]);
            if (tdata == null) {
                logger.error(`Invalid coil address: ${addr} for write in unit ${unit_id}`);
                return;
            }
            let byte = tdata.buffer.readUInt8(offset);
            if (value) byte = byte | bit_mask;
            else byte = byte & ~bit_mask;
            tdata.buffer.writeUInt8(byte, offset);
            tdata.check_all_tags();
            return;
        },
    }

    const server = new Modbus_Server(vector, { host, port, unit_id: unit_map.unit_ids });
    server.on("start", () => {
        logger.info(`ModbusTCP server listening on modbus://${host}:${port}`);
    })
    server.on("socket_error", (err) => {
        logger.error(`client error: ${err}`);
    });
    server.on('socket_connect', (socket) => {
        logger.info(`client connected: ${socket.remoteAddress}:${socket.remotePort}`);
    });
    server.on('socket_disconnect', (socket) => {
        logger.error(`client disconnected: ${socket.remoteAddress}:${socket.remotePort}`);
    });
    server.on('error', (err) => {
        logger.error(`server error: ${err}`);
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
