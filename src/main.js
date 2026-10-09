import { prepare_controller } from "./init.js";
import { read_config } from "./config.js";
import { LINE } from "./structs/line.js";
import { SECTION } from "./structs/section.js";
import { NODE } from "./structs/node.js";
import { COMMAND } from "./structs/command.js";
import { RECORD } from "./structs/record.js";
import { validate_structure } from "./structs/share.js";
import { Action_Record } from "./action_record.js";
import { MTClient, createMTServer } from "./drivers/modbusTCP.js";
import { S7Client } from "./drivers/s7.js";
import { build_runtime } from "./runtime.js";
import { logger } from "./util.js";

const modbusTCP_clients = {};
const S7_clients = {};

function get_modbusTCP_client(host, port) {
	const key = `${host}:${port}`;
	if (key in modbusTCP_clients) return modbusTCP_clients[key];
	const driver = new MTClient({ host, port });
	driver.setMaxListeners(20);
	modbusTCP_clients[key] = driver;
	return driver;
}
function get_s7_client(host, port, rack, slot) {
	const key = `${host}:${port} ${rack} ${slot}`;
	if (key in S7_clients) return S7_clients[key];
	const driver = new S7Client({ host, port, rack, slot });
	driver.setMaxListeners(20);
	S7_clients[key] = driver;
	return driver;
}

/**
 * Returns the actuator-side drivers of a node, shared by connection.
 *
 * @param {Object} driver_info - The driver information of the node.
 * @return {{data_driver: Object, command_driver: Object}}
 */
function get_drivers(driver_info) {
	if (driver_info.protocol === "modbusTCP") {
		return {
			data_driver: get_modbusTCP_client(driver_info.IP, driver_info.data.port),
			command_driver: get_modbusTCP_client(driver_info.IP, driver_info.commands.port),
		};
	}
	if (driver_info.protocol === "S7") {
		const { port, host, rack, slot } = driver_info;
		const driver = get_s7_client(host, port, rack, slot);
		return { data_driver: driver, command_driver: driver };
	}
	return { data_driver: null, command_driver: null };
}

async function run_controller(controller) {
	const action_record = new Action_Record("action_records");
	action_record.records_size = controller.records_size ?? 10;
	action_record.init();

	const runtime = build_runtime(controller, { get_drivers, action_record });

	// start modbus TCP server
	// without its upward server the controller is useless: exit and let pm2 restart it
	const server = createMTServer("0.0.0.0", controller.modbus_server.port, runtime.unit_map);
	try {
		await server.start();
	} catch (e) {
		logger.error(`cannot start the Modbus TCP server: ${e.message}`);
		process.exit(1);
	}

	runtime.start();
}

process.on("uncaughtException", (error) => {
	logger.error(`uncaughtException: ${error.message}`);
});

// validate all data block layouts before any TData is created
const layout_errors = [LINE, SECTION, NODE, COMMAND, RECORD].flatMap(validate_structure);
if (layout_errors.length > 0) {
	for (const error of layout_errors) logger.error(`invalid layout: ${error}`);
	process.exit(1);
}

const controller_name = process.argv[2];
await read_config(process.cwd());
const controller = await prepare_controller(controller_name);
if (controller) await run_controller(controller); // run controller
else logger.error(`Controller ${controller_name} not found!`);
