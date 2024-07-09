import { S7Endpoint, s7constants } from '@st-one-io/nodes7';
import { Base_Driver } from "./base.js";
import { logger } from '../util.js';

const area_map = {
    M: s7constants.proto.area.FLAGS,
    DB: s7constants.proto.area.DB,
};

export class S7Client extends S7Endpoint {
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
        config.autoReconnect = 0; // the time to wait before trying to connect to the PLC again, in ms.If set to 0, disables the functionality
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

        this.config = config;
        this.on('disconnect', () => {
            logger.warn(`${this.conn_str} connection closed.`);
        });

        Object.mixin(this, new Base_Driver());
    }

    get is_connected() { return super.isConnected; }
    async connect() {
        try {
            await super.connect();
            this.connrefused = false;
        } catch (e) {
            if (!this.connrefused) logger.warn(`can't connect to PLC ${this.conn_str}`);
            this.connrefused = true;
            this.emit("connrefused");
        }
    }
    disconnect() {
        super.disconnect();
    }

    /**
     * Reads the holding registers within the specified area asynchronously.
     *
     * @param {{start:number, length:number}} range - The area to read from, specified as an object with start and length properties with unit byte.
     * @return {Promise<Buffer>} A promise that resolves with the buffer containing the read data, or rejects with an error if the read operation fails.
     */
    async read(range, area, db_no) {
        const { start, length } = range;
        try {
            const buffer = await this.readArea(
                area_map[area],
                start, length,
                db_no
            );
            this.emit_data_ok();
            return buffer;
        } catch (error) {
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
    async write(buffer, range, area, db_no) {
        try {
            await this.writeArea(area_map[area], range.start, buffer, db_no);
            this.emit_data_ok();
        } catch (error) {
            this.emit_data_error();
        }
    }
}
