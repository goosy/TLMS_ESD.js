import Modbus, { ServerTCP } from "modbus-serial";

export class MTClient extends Modbus {

    #started = false;
    get started() { return this.#started; }

    #reconnecting = false;
    get reconnecting() { return this.#reconnecting; }

    #disconnect_time = 0;
    get disconnect_time() { return this.#disconnect_time; }

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
        this.period_time = options?.period_time ?? 1000;
        this.reconnect_time = options?.reconnect_time ?? 5; // How many ticks to reconnect after
        this.on("close", () => {
            console.log(`${this.conn_str} connection closed!`);
        });
    }

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
            if (!this.connrefused) console.log(`can't connect: ${this.conn_str}: ${err}`);
            this.connrefused = true;
            this.emit("connrefused");
        }
    }

    async tick() {
        if (this.isOpen) {
            this.emit("tick");
            this.#disconnect_time = 0;
            this.#reconnecting = false;
        } else {
            this.#disconnect_time++;
            if (!this.reconnecting && this.#disconnect_time > this.reconnect_time) {
                this.#reconnecting = true;
                await this.connect();
                this.#reconnecting = false;
            }
        }
    }

    async start() {
        this.#started = true;
        const iv = setInterval(() => {
            if (this.started) {
                this.tick()
            } else {
                if (iv) clearInterval(iv);
            }
        }, this.period_time);
    }

    stop() {
        this.#started = false;
        this.close();
    }

    #data_error = false;
    get data_error() { return this.#data_error; }
    emit_data_ok() {
        if (this.data_error) {
            this.#data_error = false;
            this.emit("data_ok");
        }
    }
    emit_data_error() {
        if (!this.data_error) {
            this.#data_error = true;
            this.emit("data_error");
        }
    }

    /**
     * Reads the holding registers within the specified area asynchronously.
     *
     * @param {{start:number, length:number}} area - The area to read from, specified as an object with start and length properties with unit byte.
     * @return {Promise<Buffer>} A promise that resolves with the buffer containing the read data, or rejects with an error if the read operation fails.
     */
    async read(area) {
        try {
            const ret = await this.readHoldingRegisters(area.start >> 1, area.length >> 1);
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
     * @param {{start:number, length:number}} area - The area to write to, specified as an object with start and length properties with unit byte.
     * @return {Promise<void>} A promise that resolves when the write operation is complete, or rejects with an error if the write operation fails.
     */
    async write(buffer, area) {
        try {
            await this.writeRegisters(area.start >> 1, buffer);
            this.emit_data_ok();
        } catch (err) {
            this.emit_data_error();
        }
    }
}

const get_register_info = (addr, unit) => {
    const byte_offset = addr * 2;
    for (const { tdata, start, end } of unit) {
        if (tdata.buffer && byte_offset >= start && byte_offset < end) {
            return { tdata, offset: byte_offset - start };
        }
    }
    return { tdata: null, offset: -1 };
};

const get_coil_info = (addr, unit) => {
    const byte_offset = addr >> 4 << 1; // Byte index value with word units as delimiters
    const bit_offset = addr % 16;
    const bit = 1 << bit_offset;
    for (const { tdata, start, end } of unit) {
        if (tdata.buffer && byte_offset >= start && byte_offset < end) {
            return { tdata, offset: byte_offset - start, bit };
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
            if (tdata) {
                return tdata.buffer.readUInt16BE(offset);
            }
            console.error(`Invalid InputRegister address(${addr}) when reading unit ${unit_id}`);
        },
        getHoldingRegister: (addr, unit_id) => {
            const { tdata, offset } = get_register_info(addr, unit_map[unit_id]);
            if (tdata) {
                return tdata.buffer.readUInt16BE(offset);
            }
            console.error(`Invalid HoldingRegister address(${addr}) when reading unit ${unit_id}`);
        },
        setRegister: (addr, value, unit_id) => {
            const { tdata, offset } = get_register_info(addr, unit_map[unit_id]);
            if (!tdata) {
                console.error(`Invalid regsiter address: ${addr} when writing to unit ${unit_id}`);
            } else {
                tdata.buffer.writeUInt16BE(value, offset);
                tdata.check_all_tags();
            }
        },

        getCoil: (addr, unit_id) => {
            const { tdata, offset, bit } = get_coil_info(addr, unit_map[unit_id]);
            if (tdata) {
                return (tdata.buffer.readUInt16BE(offset) & bit) > 0;
            }
            console.error(`Invalid coil address: ${addr} for read in unit ${unit_id}`);
        },

        setCoil: (addr, value, unit_id) => {
            const { tdata, offset, bit } = get_coil_info(addr, unit_map[unit_id]);
            if (tdata) {
                let byte = tdata.buffer.readUInt16BE(offset);
                if (value) byte = byte | bit;
                else byte = byte & ~bit;
                tdata.buffer.writeUInt16BE(byte, offset);
                tdata.check_all_tags();
            } else {
                console.error(`Invalid coil address: ${addr} for write in unit ${unit_id}`);
            }
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

export function attach_unit(unit_map, unit_id, tdata, start = 0) {
    unit_map[unit_id] ??= new_blank_unit(unit_id);
    unit_map[unit_id].push({
        tdata,
        start,
        end: tdata.size + start,
    });
}
