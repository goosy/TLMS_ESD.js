import Modbus, { ServerTCP } from "modbus-serial";
import { Base_Driver } from "./base.js";

export class MTClient extends Modbus {

    /** 
     * @param {string} host the ip of the TCP Port - required.
     * @param {number} port the Port number - default 502.
     */
    constructor(host, port = 502, options) {
        super();
        const unit_id = options?.unit_id ?? 1;
        this.conn_str = `modbus://${host}:${port} unit:${unit_id}`;
        this.setID(unit_id);
        this.host = host;
        this.port = port;
        const period_time = options?.period_time;
        if (period_time) this.period_time = period_time;
        const reconnect_time = options?.reconnect_time; // How many ticks to reconnect after
        if (reconnect_time) this.reconnect_time = reconnect_time;
        this.on("close", () => {
            this.emit("disconnect");
            console.log(`${this.conn_str} connection closed!`);
        });
        Object.mixin(this, new Base_Driver());
    }

    get is_connected() { return super.isOpen; }
    connrefused = false;
    async connect(host, option) {
        if (typeof host === "string") {
            this.host = host;
        }
        if (typeof option?.port === "number") {
            this.port = option.port;
        }
        const tcpoption = { port: this.port };
        try {
            await this.connectTCP(this.host, tcpoption);
            this.connrefused = false;
            this.emit("connect");
        } catch (err) {
            if (!this.connrefused) console.log(`can't connect to ${this.conn_str}: ${err}`);
            this.connrefused = true;
            this.emit("connrefused");
        }
    }
    disconnect() {
        super.close();
    }

    /**
     * Reads the holding registers within the specified area asynchronously.
     *
     * @param {{start:number, length:number}} range - The area to read from, specified as an object with start and length properties with unit byte.
     * @return {Promise<Buffer>} A promise that resolves with the buffer containing the read data, or rejects with an error if the read operation fails.
     */
    async read(range) {
        try {
            const ret = await this.readHoldingRegisters(range.start >> 1, range.length >> 1);
            this.emit_data_ok();
            return ret.buffer;
        } catch (err) {
            this.emit_data_error();
            return null;
        }
    }

    /**
     * Writes the given buffer to the specified area asynchronously.
     *
     * @param {Buffer} buffer - The buffer containing the data to be written.
     * @param {{start:number, length:number}} range - The area to write to, specified as an object with start and length properties with unit byte.
     * @return {Promise<void>} A promise that resolves when the write operation is complete, or rejects with an error if the write operation fails.
     */
    async write(buffer, range) {
        try {
            await this.writeRegisters(range.start >> 1, buffer);
            this.emit_data_ok();
        } catch (err) {
            this.emit_data_error();
        }
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
export function createMTServer(host = "0.0.0.0", port = 502, unit_map) {

    const vector = {
        getInputRegister: (addr, unit_id) => {
            const { tdata, offset } = get_register_info(addr, unit_map[unit_id]);
            if (tdata == null) {
                console.error(`Invalid InputRegister address(${addr}) when reading unit ${unit_id}`);
                return 0;
            }
            if (tdata.LE_list.includes(offset)) return tdata.buffer.readUInt16LE(offset);
            return tdata.buffer.readUInt16BE(offset);
        },
        getHoldingRegister: (addr, unit_id) => {
            const { tdata, offset } = get_register_info(addr, unit_map[unit_id]);
            if (tdata == null) {
                console.error(`Invalid HoldingRegister address(${addr}) when reading unit ${unit_id}`);
                return 0;
            }
            if (tdata.LE_list.includes(offset)) return tdata.buffer.readUInt16LE(offset);
            return tdata.buffer.readUInt16BE(offset);
        },
        setRegister: (addr, value, unit_id) => {
            const { tdata, offset } = get_register_info(addr, unit_map[unit_id]);
            if (tdata == null) {
                console.error(`Invalid regsiter address: ${addr} when writing to unit ${unit_id}`);
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
                console.error(`Invalid coil address: ${addr} for read in unit ${unit_id}`);
                return false;
            }
            return (tdata.buffer.readUInt8(offset) & bit_mask) > 0;
        },

        setCoil: (addr, value, unit_id) => {
            const { tdata, offset, bit_mask } = get_coil_info(addr, unit_map[unit_id]);
            if (tdata == null) {
                console.error(`Invalid coil address: ${addr} for write in unit ${unit_id}`);
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

    console.log(`ModbusTCP listening on modbus://${host}:${port}`);
    const server = new ServerTCP(vector, { host, port, debug: true, unitID: 0, });
    server.on("socketError", function (err) {
        // Handle socket error if needed, can be ignored
        console.error(err);
    });

    return server;
}

function new_blank_unit(unit_id) {
    const unit = [];
    unit.ID = unit_id;
    return unit;
}

/**
 * Attaches a unit to the unit map.
 *
 * @param {Object} unit_map - The map of units.
 * @param {number} unit_id - The ID of the unit.
 * @param {TData} tdata - The TData object that contains the data associated with the unit.
 * @param {number} [start=0] - The starting index of the unit's data.
 * @param {number} [offset=0] - The starting index of the TData object.
 * @return {void} This function does not return anything.
 */
export function attach_unit(unit_map, unit_id, tdata, start = 0, offset = 0) {
    unit_map[unit_id] ??= new_blank_unit(unit_id);
    unit_map[unit_id].push({
        tdata,
        start,
        offset,
        end: tdata.size - offset + start,
    });
}
