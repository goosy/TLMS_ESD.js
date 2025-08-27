import "../util.js";  // the side effects need to be executed

export class Base_Driver {
    period_time = 1000;
    reconnect_time = 5000;

    constructor() {
        // private fields
        let started = false;
        let connecting = false;
        let disconnect_time = 10000; // Ensure that the connection is made initially
        let data_error = false;
        Object.defineProperty(this, 'started', {
            get: function () {
                return started;
            },
            configurable: false,
            enumerable: true,
        });
        Object.defineProperty(this, 'connecting', {
            get: function () {
                return connecting;
            },
            configurable: false,
            enumerable: true,
        });
        Object.defineProperty(this, 'disconnect_time', {
            get: function () {
                return disconnect_time;
            },
            configurable: false,
            enumerable: true,
        });
        Object.defineProperty(this, 'data_error', {
            get: function () {
                return data_error;
            },
            configurable: false,
            enumerable: true,
        });

        this.start_tick = function () {
            if (started) {
                if (this.is_connected) {
                    this.emit("tick");
                    disconnect_time = 0;
                    connecting = false;
                } else if (this.reconnect_time > 0) {
                    disconnect_time += this.period_time;
                    // must be use `this.connectiong` to take advantage of
                    // the connection state management of the implementation class itself
                    if (!connecting && disconnect_time > this.reconnect_time) {
                        connecting = true;
                        this.connect().then(
                            () => connecting = false,
                            () => connecting = false,
                        );
                    }
                }
            } else {
                clearInterval(this.loop);
            }
        }

        this.start = function () {
            started = true;
            if (this.loop) clearInterval(this.loop);
            this.loop = setInterval(this.start_tick.bind(this), this.period_time);
        }
        this.stop = function () {
            started = false;
            this.disconnect();
        }

        let timeout_id;
        /**
         * Emits a 'data_ok' event if there was a previous data error and resets the error flag.
         *
         * @param {Buffer} data - The value returned by the resolved promise.
         * @return {Promise<Buffer>} A promise that resolves with the input data.
         */
        this.emit_data_ok = async function (data) {
            clearTimeout(timeout_id);
            if (data_error) {
                data_error = false;
                this.emit("data_ok");
            }
            return data;
        }
        this.emit_data_error = async function (e) {
            if (!data_error) {
                data_error = true;
                timeout_id = setTimeout(()=>{
                    this.on_error("unable to retrieve data");
                }, this.reconnect_time);
                this.emit('data_error',`unable to retrieve data - ${e}`);
            }
            return null;
        }
    }

    get is_connected() { return false; } // abstract
    async connect() { } // abstract
    disconnect() { } // abstract

    /**
     * Reads the holding registers within the specified area asynchronously.
     *
     * @param {{start:number, length:number}} area - The area to read from, specified as an object with start and length properties with unit byte.
     * @return {Promise<Buffer>} A promise that resolves with the buffer containing the read data, or rejects with an error if the read operation fails.
     */
    async read(area) { } // abstract
    /**
     * Writes the given buffer to the specified area asynchronously.
     *
     * @param {Buffer} buffer - The buffer containing the data to be written.
     * @param {{start:number, length:number}} area - The area to write to, specified as an object with start and length properties with unit byte.
     * @return {Promise<void>} A promise that resolves when the write operation is complete, or rejects with an error if the write operation fails.
     */
    async write(buffer, area) { } // abstract
}
