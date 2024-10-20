import { S7Endpoint, s7constants } from '@st-one-io/nodes7';
import { Base_Driver } from "./base.js";
import { logger } from '../util.js';

const area_map = {
    M: s7constants.proto.area.FLAGS,
    DB: s7constants.proto.area.DB,
};

export class S7Client extends S7Endpoint {
    connfailed = true;

    /**
     * Constructs a new S7Client object.
     *
     * @param {Object} config - The configuration object.
     * @param {string}  [config.host='localhost'] the hostname or IP Address to connect to
     * @param {number}  [config.port=102] the TCP port to connect to
     * @param {number}  [config.rack=0] the rack on the PLC configuration
     * @param {number}  [config.slot=2] the slot on the PLC configuration
     * @param {number}  [config.srcTSAP=0x0100] the source TSAP, when connecting using TSAP method
     * @param {number}  [config.dstTSAP=0x0102] the destination TSAP, when connecting using TSAP method
     * @throws {Error} Will throw an error if invalid options are passed
     * @return {void}
     */
    constructor(config, options) {
        config.autoReconnect = 5000; // the time to wait before trying to connect to the PLC again, in ms.If set to 0, disables the functionality
        config.host ??= 'localhost';
        config.port ??= 102;
        config.rack ??= 0;
        config.slot ??= 2;
        super(config);

        const period_time = options?.period_time;
        if (period_time) this.period_time = period_time;
        const reconnect_time = options?.reconnect_time;
        if (reconnect_time) this.reconnect_time = reconnect_time;
        this.conn_str = `s7://${config.host}:${config.port} rack${config.rack} slot${config.slot}`;
        this.on('error', this.on_error);
        this.on('disconnect', this.on_error);
        this.on("connect", () => {
            logger.info(`connected to ${this.conn_str}!`);
            this.connfailed = false;
        });
        this.config = config;

        // Due to the incompleteness of S7Endpoint.connect(),
        // its own reconnection mechanism is temporarily used instead.
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
        // If the S7Endpoint issue is resolved, remove this block of code
        // and set config.autoReconnect = 0;
        // temporary code end

        Object.mixin(this, new Base_Driver());
    }

    get is_connected() { return super.isConnected; }
    on_error(error) {
        if (!this.connfailed) {
            this.emit("connfailed", error ?? "unknown error");
        }
        this.connfailed = true;
    };

    // connect() inherited from superclass
    // disconnect() inherited from superclass

    /**
     * Asynchronously reads the holding registers within the specified area.
     * 
     * @param {{start:number, length:number}} range - The area to read from, specified as an object with start and length properties with unit byte.
     * @param {string} area - The area type to read from (e.g., 'DB', 'MB', etc.).
     * @param {number} db_no - The DB number to read from.
     * @return {Promise<Buffer|null>} A promise that resolves with the buffer containing the read data, or null if the read operation fails.
     */
    read(range, area, db_no) {
        const { start, length } = range;
        const resolve = this.emit_data_ok.bind(this);
        const reject = this.emit_data_error.bind(this);
        return this.readArea(
            area_map[area],
            start, length,
            db_no
        ).then(resolve, reject);
    }
    /**
     * Writes the given buffer to the specified area asynchronously.
     *
     * @param {Buffer} buffer - The buffer containing the data to be written.
     * @param {{start:number, length:number}} range - The area to write to, specified as an object with start and length properties with unit byte.
     * @param {string} area - The area type to read from (e.g., 'DB', 'MB', etc.).
     * @param {number} db_no - The DB number to read from.
     * @return {Promise<boolean>} A promise that resolves when the write operation is complete.
     */
    write(buffer, range, area, db_no) {
        const resolve = () => {
            this.emit_data_ok();
            return true;
        }
        const reject = (e) => {
            this.emit_data_error(e);
            return false;
        }
        return this.writeArea(
            area_map[area], range.start,
            buffer,
            db_no
        ).then(resolve, reject);
    }
}
