import { EventEmitter } from 'node:events';
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
        this.setID(1);
        this.host = host;
        this.port = port;
        this.periodTime = options?.periodTime ?? 1000;
        this.reconnect_time = options?.reconnect_time ?? 5; // How many ticks to reconnect after
    }

    async connect(host, option) {
        if (typeof host === "string") {
            this.host = host;
        }
        const tcpoption = { port: this.port, ...option };
        try {
            await this.connectTCP(this.host, tcpoption);
            this.emit("connect");
            this.on("close", () => {
                console.log("connection closed!");
            });
            console.log("connected!");
        } catch (err) {
            console.log("can't connect: " + err);
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

    async read(area) {
        try {
            const ret = await this.readHoldingRegisters(area.addr, area.length)
            return ret.buffer;
        } catch (err) {
            console.log(err);
        }
    }
}

/** 
 * @param {string} host the ip of the TCP Port - required.
 * @param {number} port the Port number - default 502.
 */
export function createMTServer(host = "0.0.0.0", port = 502, mb_map) {
    const read_word = (addr, unitID) => {
        const { buffer, start, end } = mb_map[unitID] ?? {};
        const byte_offset = addr * 2;
        if (buffer && addr >= start && (addr << 4) < end) {
            return buffer.readUInt16BE(byte_offset);
        } else {
            console.error(`Invalid input or holdingaddress: ${addr}`);
        }
    };
    const vector = {
        getCoil: (addr, unitID) => {
            const { buffer, start, end } = mb_map[unitID] ?? {};
            const byte_offset = addr >> 3;
            const bit_offset = addr % 8;
            const bit_number = 1 << bit_offset;
            if (buffer && addr >= start && addr < end) {
                return (buffer.readUInt8(byte_offset) & bit_number) > 0;
            } else {
                console.error(`Invalid coil address: ${addr}`);
            }
        },
        getInputRegister: read_word,
        getHoldingRegister: read_word,

        setCoil: (addr, value, unitID) => {
            const { buffer, start, end } = mb_map[unitID] ?? {};
            const byte_offset = addr >> 3;
            const bit_offset = addr % 8;
            const bit_number = 1 << bit_offset;
            if (buffer && addr >= start && addr < end) {
                let byte = buffer.readUInt8(byte_offset);
                if (value) byte = byte | bit_number;
                else byte = byte & ~bit_number;
                buffer.writeUInt8(byte, byte_offset);
            }
        },
        setRegister: (addr, value, unitID) => {
            const { buffer, start, end } = mb_map[unitID] ?? {};
            const byte_offset = addr * 2;
            if (buffer && addr >= start && (addr << 4) < end) {
                buffer.writeUInt16BE(value, byte_offset);
            } else {
                console.error(`Invalid coil address: ${addr}`);
            }
        }
    }

    console.log(`ModbusTCP listening on modbus://${host}:${port}`);
    const server = new ServerTCP(vector, { host, port, debug: true, unitID: 0, });
    server.on("socketError", function (err) {
        // Handle socket error if needed, can be ignored
        console.error(err);
    });
    return server;
}

export function gen_mb_map(device_map) {
    const map = {};
    for (const [unitID, tdata] of Object.entries(device_map)) {
        map[unitID] = {
            buffer: tdata.buffer,
            start: 0,
            end: tdata.size,
        };
    }
    return map;
}
