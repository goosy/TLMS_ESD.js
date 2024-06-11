import { init } from "./init.js";

export async function run(controller_name) {
    init(controller_name ?? 0);
}
