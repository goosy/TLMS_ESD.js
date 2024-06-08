import { MTClient, createMTServer, gen_mb_map } from "./drivers/modbusTCP.js";
import { TData } from "./data_type/TData.js";
import { NODE } from "./data_type/TNode.js";

const GD8 = new TData(NODE);
GD8.on("change", (tagname, old_value, new_value) => {
    console.log(`${tagname}: ${old_value} -> ${new_value}`);
});
GD8.replace_buffer(Buffer.from([0x8e, 0x1f, 0x17, 0x00, 0x00, 0x00]));
console.log(GD8.buffer);
console.log(GD8.size);
const GD_conn = new MTClient("192.168.89.189", 502);
GD8.setIO(
    GD_conn,
    { addr: 0, length: GD8.size >> 4 }
);

const mb_map = gen_mb_map({
    78: GD8,
});

const server = createMTServer('0.0.0.0', 502, mb_map);
server.on("close", () => {
    console.log("connection closed!");
});