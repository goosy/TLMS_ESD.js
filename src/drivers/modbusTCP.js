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
