import { prepare_controller } from "./init.js";
import { read_config } from "./config.js";
import { Action_Record } from "./action_record.js";
import { MTClient } from "./drivers/modbusTCP.js";
import { S7Client } from "./drivers/s7.js";
import { build_runtime } from "./runtime.js";
import { create_upward } from "./upward.js";
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
	// the data blocks are built up front by the upward emulator; the runtime
	// then makes every write to them request a scan (doc/design.md 3.5)
	let emulator;
	try {
		emulator = create_upward(controller);
	} catch (e) {
		for (const error of e.errors ?? [e.message]) logger.error(`invalid upward description: ${error}`);
		process.exit(1);
	}
	const action_record = new Action_Record("action_records", emulator.block(controller.record_block));
	action_record.records_size = controller.records_size ?? 10;
	action_record.init();

	let runtime;
	try {
		runtime = build_runtime(controller, { get_drivers, action_record, emulator });
	} catch (e) {
		// a configuration that cannot be built (e.g. an unaligned IO area): refuse to start
		logger.error(`cannot build controller ${controller.name}: ${e.message}`);
		process.exit(1);
	}

	// start the Modbus TCP server
	// without its upward server the controller is useless: exit and let pm2 restart it
	try {
		await emulator.start();
	} catch (e) {
		// an AggregateError names each server that failed
		for (const error of e.errors ?? [e]) logger.error(`cannot start the Modbus TCP server: ${error.message}`);
		process.exit(1);
	}

	runtime.start();
}

process.on("uncaughtException", (error) => {
	logger.error(`uncaughtException: ${error.message}`);
});

const controller_name = process.argv[2];
await read_config(process.cwd());
const controller = await prepare_controller(controller_name);
if (controller) await run_controller(controller); // run controller
else logger.error(`Controller ${controller_name} not found!`);
