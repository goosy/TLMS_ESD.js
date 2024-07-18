import { EventEmitter } from 'node:events';
import Modbus, { ServerTCP } from "modbus-serial";

const mb_server_map = {};

export class MTClient extends Modbus {

    #started = false;
    get started() { return this.#started; }

    #reconnecting = false;
    get reconnecting() { return this.#reconnecting; }

    #disconnect_time = 0;
    get disconnect_time() { return this.#disconnect_time; }

    get conn_str() { return `modbus://${this.host}:${this.port}`; }

    /** 
     * @param {string} host the ip of the TCP Port - required.
     * @param {number} port the Port number - default 502.
     */
    constructor(host, port = 502, options) {
        super();
        this.setID(1);
        this.host = host;
        this.port = port;
        this.periodTime = options?.periodTime ?? 1000;
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
            console.log(`ModbusTCP connected to ${this.conn_str}!`);
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
        }, this.periodTime);
    }

    stop() {
        this.#started = false;
        this.close();
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
            return ret.buffer;
        } catch (err) {
            console.log(err);
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
        } catch (err) {
            console.log(err);
        }
    }
}

const get_register_info = (addr, unitID) => {
    const tdata_list = mb_server_map[unitID] ?? [];
    const byte_offset = addr * 2;
    for (const { tdata, start, end } of tdata_list) {
        if (tdata.buffer && byte_offset >= start && byte_offset < end) {
            return { tdata, offset: byte_offset - start };
        }
    }
    return { tdata: null, offset: -1 };
};

const get_coil_info = (addr, unitID) => {
    const tdata_list = mb_server_map[unitID] ?? [];
    const byte_offset = addr >> 4 << 1; // Byte index value with word units as delimiters
    const bit_offset = addr % 16;
    const bit = 1 << bit_offset;
    for (const { tdata, start, end } of tdata_list) {
        if (tdata.buffer && byte_offset >= start && byte_offset < end) {
            return { tdata, offset: byte_offset - start, bit };
        }
    }
    console.error(`Invalid coil address: ${addr} for read in unit ${unitID}`);
};

/** 
 * @param {string} host the ip of the TCP Port - required.
 * @param {number} port the Port number - default 502.
 */
export function createMTServer(host = "0.0.0.0", port = 502) {

    const vector = {
        getInputRegister: (addr, unitID) => {
            const { tdata, offset } = get_register_info(addr, unitID);
            if (tdata) {
                return tdata.buffer.readUInt16BE(offset);
            }
            console.error(`Invalid InputRegister address(${addr}) when reading unit ${unitID}`);
        },
        getHoldingRegister: (addr, unitID) => {
            const { tdata, offset } = get_register_info(addr, unitID);
            if (tdata) {
                return tdata.buffer.readUInt16BE(offset);
            }
            console.error(`Invalid HoldingRegister address(${addr}) when reading unit ${unitID}`);
        },
        setRegister: (addr, value, unitID) => {
            const { tdata, offset } = get_register_info(addr, unitID);
            if (!tdata) {
                console.error(`Invalid regsiter address: ${addr} when writing to unit ${unitID}`);
            } else {
                tdata.buffer.writeUInt16BE(value, offset);
                tdata.refresh_value();
            }
        },

        getCoil: (addr, unitID) => {
            const { tdata, offset, bit } = get_coil_info(addr, unitID);
            if (tdata) {
                return (tdata.buffer.readUInt16BE(offset) & bit) > 0;
            }
            console.error(`Invalid coil address: ${addr} for read in unit ${unitID}`);
        },

        setCoil: (addr, value, unitID) => {
            const { tdata, offset, bit } = get_coil_info(addr, unitID);
            if (tdata) {
                let byte = tdata.buffer.readUInt16BE(offset);
                if (value) byte = byte | bit;
                else byte = byte & ~bit;
                tdata.buffer.writeUInt16BE(byte, offset);
                tdata.refresh_value();
            } else {
                console.error(`Invalid coil address: ${addr} for write in unit ${unitID}`);
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

export function attach_to_server(unitID, tdata, start = 0) {
    mb_server_map[unitID] ??= [];
    mb_server_map[unitID].push({
        tdata,
        start,
        end: tdata.size + start,
    });
}
