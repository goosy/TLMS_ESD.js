import { createMTServer } from "./drivers/modbusTCP.js";
import { init } from "./init.js";

export async function run() {
    init();
    const server = createMTServer('0.0.0.0', 502);
    server.on("close", () => {
        console.log("connection closed!");
    });
}
