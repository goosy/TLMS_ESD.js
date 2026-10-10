import { Modbus_Emulator } from "modbus-emulator";
import { layouts_file } from "./layouts.js";
import { logger } from "./util.js";

// byte offset of the node commands in the unit of an actuator (doc/spec-modbus.md)
const COMMAND_START = 400;
const RECORD_BLOCK = "action_records";

/**
 * Describes the data blocks of a controller and the Modbus server that
 * publishes them upward, and lets modbus-emulator build them (doc/design.md 4.4).
 *
 * The block names are stored in the object graph, for the users to get their
 * data blocks from the emulator: `controller.record_block`, `line.block`,
 * `section.block`, `node.block` and `node.command_block`.
 *
 * @param {Object} controller - The controller returned by prepare_controller.
 * @param {Object} [options]
 * @param {boolean} [options.registered] - The layouts are already registered in the process (tests only,
 *     because register_layout succeeds once): the emulator does not register them.
 * @return {Modbus_Emulator} The emulator, not started.
 * @throws {Error} With `errors`, every violation found, when the description is not valid.
 */
export function create_upward(controller, { registered = false } = {}) {
	const unit_ids = controller.modbus_server.unit_id;
	const blocks = [];
	const add = (name, layout, unit_id, start = 0) => {
		blocks.push({ name, unit_id, layout, start });
		return name;
	};

	controller.record_block = add(RECORD_BLOCK, "RECORD", unit_ids.action_records);
	for (const line of controller.lines) {
		line.block = add(line.name, "LINE", unit_ids[line.name]);
		for (const section of line.sections) {
			section.block = add(section.name, "SECTION", unit_ids[section.name]);
			for (const node of [...section.begin_nodes, ...section.end_nodes]) {
				node.block = add(node.name, "NODE", unit_ids[node.name]);
				node.command_block = add(`${node.name} command`, "COMMAND", unit_ids[node.name], COMMAND_START);
			}
		}
	}

	// @ts-expect-error an object description is an internal entry of modbus-emulator, not in its public types
	const emulator = new Modbus_Emulator({
		...(registered ? {} : { layouts_file }),
		blocks,
		servers: [{ protocol: "tcp", host: "0.0.0.0", port: controller.modbus_server.port }],
	});
	log_emulator(emulator);
	return emulator;
}

/** Writes the diagnostics and the server events of the emulator to the log. */
function log_emulator(emulator) {
	for (const warning of emulator.warnings) logger.warn(warning);
	const peer = (socket) => `${socket.remoteAddress}:${socket.remotePort}`;
	emulator.on("server_start", ({ server }) => logger.info(`Modbus server listening on ${server.name}`));
	emulator.on("server_stop", ({ server }) => logger.info(`Modbus server ${server.name} stopped`));
	emulator.on("server_socket_connect", ({ socket }) => logger.info(`client connected: ${peer(socket)}`));
	emulator.on("server_socket_disconnect", ({ socket }) => logger.info(`client disconnected: ${peer(socket)}`));
	emulator.on("server_socket_error", ({ error }) => logger.error(`client error: ${error.message}`));
	emulator.on("server_error", ({ error }) => logger.error(`server error: ${error.message}`));
	emulator.on("server_handler_error", ({ error }) => logger.error(`server request failed: ${error.message}`));
	emulator.on("unmapped", ({ kind, unit_id, addr }) => {
		logger.warn(`unmapped ${kind} address ${addr} in unit ${unit_id}`);
	});
	emulator.on("unmapped_limit", ({ limit }) => {
		logger.warn(`${limit} unmapped addresses reported, further ones are not reported`);
	});
	emulator.on("listener_error", ({ block, error }) => {
		logger.error(`a listener of block ${block.name} failed: ${error instanceof Error ? error.message : error}`);
	});
}
