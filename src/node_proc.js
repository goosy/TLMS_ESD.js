import { logger } from "./util.js";
import { node_commands, node_parameters } from "./layouts.js";
import { Binding } from "./drivers/binding.js";
import { act, derive, off_delay } from "./rules.js";

const parameters_tags = node_parameters.map((item) => item.name);
/** The names of the command bits, which are also the bits of response_code. */
const command_tags = node_commands.map((item) => item.name);
// the parameters are refreshed 2 s after the connection is made
const PARAMETERS_REFRESH_DELAY = 2000;
// unanswered commands are sent again after 3 periodic ticks
const RESEND_TICKS = 3;

export function node_init(actuator) {
	const {
		ID, name, data, command,
		has_pumps,
		data_driver, command_driver, driver_info,
	} = actuator;
	command.name = `${name}_CMD`;
	data.name = name;

	const endian = driver_info.endian;

	data_driver.on("io_error", (e) => {
		logger.debug(`actuator ${name} ${e}`);
	});
	data_driver.on("connfailed", (e) => {
		logger.error(`actuator ${name} connection failed: ${e}`);
	});
	const data_extras = [];
	const commands_extras = [];
	if (driver_info.protocol === "S7") {
		data_extras.push(driver_info.data.area, driver_info.data.db);
		commands_extras.push(driver_info.commands.area, driver_info.commands.db);
	} else if (driver_info.protocol === "modbusTCP") {
		data_extras.push(driver_info.data.unit_id);
		commands_extras.push(driver_info.commands.unit_id);
	}

	data.ID = ID;
	// new device data, a state change or a finished write requests a scan
	const on_update = () => actuator.scheduler?.request_scan();
	const data_binding = new Binding(data, data_driver, {
		remote_start: driver_info.data.start,
		start: 0, length: data.size,
		endian,
		on_update,
	}, ...data_extras);
	actuator.data_binding = data_binding;

	actuator.data_payload = data_binding.create_group(
		"ID",
		"work_OK", "pump_run", "pump_change_F", "pump_run_1", "pump_run_2", "pump_run_3", "pump_run_4",
		"pressure_enabled", "temperature_enabled", "pressure_SD_F", "pressure_AH_F", "pressure_WH_F",
		"temperature", "pressure", "flowmeter",
		"response_code",
		...parameters_tags,
	);
	actuator.data_parameters = data_binding.create_group(...parameters_tags);

	data.on("change", (tagname, old_value, new_value) => {
		logger.debug(`actuator_${name}_data: ${tagname} ${old_value} => ${new_value}`);
	});
	data.get("pressure_SD_F").on("change", (_, new_value) => {
		logger.info(`actuator ${name} ${new_value ? "allows" : "prohibits"} pressure interlock`);
	});
	data.get("comm_OK").on("change", (_, new_value) => {
		logger.info(`actuator ${name} communication is ${new_value ? "normal" : "lost"}`);
	});
	data.get("work_OK").on("change", (_, new_value) => {
		logger.info(`actuator ${name} ${new_value ? "resumes normal operation" : "is not working properly"}`);
	});
	if (has_pumps) {
		data.get("pump_run_1").on("change", (old_value, new_value) => {
			logger.info(`actuator ${name} pump 1 status changed: ${old_value} -> ${new_value}`);
		});
		data.get("pump_run_2").on("change", (old_value, new_value) => {
			logger.info(`actuator ${name} pump 2 status changed: ${old_value} -> ${new_value}`);
		});
		data.get("pump_run_3").on("change", (old_value, new_value) => {
			logger.info(`actuator ${name} pump 3 status changed: ${old_value} -> ${new_value}`);
		});
		data.get("pump_run_4").on("change", (old_value, new_value) => {
			logger.info(`actuator ${name} pump 4 status changed: ${old_value} -> ${new_value}`);
		});
	}
	data.get("pressure_WH_F").on("change", (old_value, new_value) => {
		logger.info(`actuator ${name} pressure warning status changed: ${old_value} -> ${new_value}`);
	});
	data.get("pressure_AH_F").on("change", (old_value, new_value) => {
		logger.info(`actuator ${name} pressure alarm status changed: ${old_value} -> ${new_value}`);
	});

	command.ID = ID;
	const command_binding = new Binding(command, command_driver, {
		remote_start: driver_info.commands.start,
		start: 16, length: command.size - 16,
		endian,
		on_update,
	}, ...commands_extras);
	actuator.command_binding = command_binding;

	actuator.commands_payload = command_binding.create_group(
		"ID",
		"commands",
		...parameters_tags,
	);

	command.on("change", (tagname, old_value, new_value) => {
		logger.debug(`actuator_${name}_command: ${tagname} ${old_value} => ${new_value}`);
	});

	// The start() function already handles duplicates automatically if the driver is the same.
	data_driver.start();
	command_driver.start();
}

/** Copies the parameter tags from one tdata to another. */
function copy_parameters(from, to) {
	for (const tag of parameters_tags) to[tag] = from[tag];
}

/**
 * Declares the rules of an actuator (doc/design.md 7.3): its
 * connection states and commands. Called once the whole object graph is
 * built.
 *
 * @param {Object} actuator
 * @param {import("./scan.js").Scheduler} scheduler
 */
export function node_rules(actuator, scheduler) {
	const { name, data, command, data_binding, command_binding, has_pumps } = actuator;
	const add = (make, spec) => scheduler.add_rule(make({ ...spec, name: `node ${name} ${spec.name}` }));
	const keys = (owner, tags) => tags.map((tag) => [owner, tag]);
	// write_paras copies the command parameters into the node data, and the
	// rules below copy them back or read them: they read the node parameters
	// as at the end of the last scan, which breaks the cycle (doc/design.md 6.4)
	const previous_parameters = keys(data, parameters_tags);
	const copy_previous_parameters = () => {
		for (const tag of parameters_tags) command[tag] = scheduler.previous(data, tag);
	};
	const delay_protect_time = () => scheduler.previous(data, "delay_protect_time");

	// connection states (doc/design.md 7.3): comm_OK holds for
	// delay_protect_time after the connection is lost
	add(derive, {
		name: "comm_OK",
		reads: [[data_binding, "connected"]],
		reads_previous: [[data, "delay_protect_time"]],
		writes: [[data, "comm_OK"]],
		run: (ticker) => {
			data.comm_OK = off_delay(ticker, data_binding.connected, delay_protect_time());
		},
	});
	// cleared once reads have failed for delay_protect_time; a successful
	// read loads the value reported by the actuator again
	add(act, {
		name: "work_OK",
		reads: [[data_binding, "read_ok"], [data, "work_OK"]],
		reads_previous: [[data, "delay_protect_time"]],
		writes: [[data, "work_OK"]],
		run: (ticker) => {
			if (!off_delay(ticker, data_binding.read_ok, delay_protect_time()) && data.work_OK) data.work_OK = false;
		},
	});
	// by edge: the parameters are refreshed 2 s after the connection is made
	add(act, {
		name: "parameters refresh",
		reads: [[data_binding, "connected"]],
		reads_previous: previous_parameters,
		writes: keys(command, parameters_tags),
		run: (ticker) => {
			if (scheduler.rose(data_binding, "connected")) ticker.restart();
			if (!data_binding.connected) ticker.stop();
			if (ticker.running && ticker.elapsed >= PARAMETERS_REFRESH_DELAY) {
				ticker.stop();
				copy_previous_parameters();
			}
		},
	});

	// commands
	if (has_pumps) add(act, {
		name: "stop_pumps withdraw",
		reads: [[data, "pump_run"]],
		writes: [[command, "stop_pumps"]],
		run: () => {
			if (scheduler.fell(data, "pump_run")) command.stop_pumps = false;
		},
	});
	// Command handshake: each bit set in response_code acknowledges the
	// command bit of the same name (doc/spec.md 5.1), which is cleared.
	add(act, {
		name: "response",
		reads: [[data, "response_code"]],
		writes: keys(command, command_tags),
		run: () => {
			if (!scheduler.changed(data, "response_code") || data.response_code === 0) return;
			for (const tag of command_tags) if (data[tag]) command[tag] = false;
			command.executing = false;
		},
	});
	add(act, {
		name: "pressure_SD_F",
		reads: [[data, "pressure_SD_F"]],
		writes: [[command, "enable_pressure_SD"], [command, "disable_pressure_SD"]],
		run: () => {
			if (!scheduler.changed(data, "pressure_SD_F")) return;
			if (data.pressure_SD_F) command.enable_pressure_SD = false;
			else command.disable_pressure_SD = false;
		},
	});
	add(act, {
		name: "read_paras",
		reads: [[command, "read_paras"]],
		reads_previous: previous_parameters,
		writes: [[command, "read_paras"], ...keys(command, parameters_tags)],
		run: () => {
			if (!scheduler.rose(command, "read_paras")) return;
			copy_previous_parameters();
			command.read_paras = false;
		},
	});
	// the parameters are written to the data block of the actuator; the
	// command bit is reset once that write is done
	let parameters_write = null;
	add(act, {
		name: "write_paras",
		reads: [[command, "write_paras"], ...keys(command, parameters_tags), [data_binding, "write_done"]],
		writes: [[command, "write_paras"], ...keys(data, parameters_tags)],
		run: () => {
			const done = data_binding.write_done(actuator.data_parameters)?.seq ?? 0;
			if (scheduler.rose(command, "write_paras")) {
				copy_parameters(command, data);
				data_binding.request_write(actuator.data_parameters);
				parameters_write = done + 1;
			}
			if (parameters_write !== null && done >= parameters_write) {
				parameters_write = null;
				command.write_paras = false;
			}
		},
	});
	add(derive, {
		name: "has_commands",
		reads: [[command, "commands"]],
		writes: [[command, "has_commands"]],
		run: () => { command.has_commands = command.commands > 0; },
	});
	// the commands are sent when they change, and again on a response so
	// that the actuator sees the acknowledged bits cleared
	add(act, {
		name: "send",
		reads: [[command, "commands"], [data, "response_code"]],
		run: () => {
			const responded = scheduler.changed(data, "response_code") && data.response_code !== 0;
			if (scheduler.changed(command, "commands") || responded) {
				command_binding.request_write(actuator.commands_payload);
			}
		},
	});
	// unanswered commands are sent again on every tick after RESEND_TICKS ticks
	let last_resend = 0;
	add(act, {
		name: "resend",
		reads: [[command, "has_commands"]],
		run: (ticker) => {
			if (!command.has_commands) {
				ticker.stop();
				last_resend = 0;
				return;
			}
			ticker.start();
			if (ticker.count > RESEND_TICKS && ticker.count !== last_resend) {
				last_resend = ticker.count;
				command_binding.request_write(actuator.commands_payload);
			}
		},
	});
}

/**
 * Declares the command mask of an actuator (doc/design.md 14.1): the
 * unsupported command bits are reset on every scan, before the commands are
 * sent. Declared after all other rules, so that it runs after every other
 * writer of the command bits.
 */
export function node_mask_rule(actuator, scheduler) {
	const { name, command, command_mask } = actuator;
	const unsupported = node_commands
		.filter(({ offset }) => {
			const k = offset >= 8 ? offset - 8 : offset + 8;
			// reserve and executing are no commands
			return k < 14 && !(command_mask & (1 << k));
		})
		.map(({ name: tag }) => tag);
	const keys = unsupported.map((tag) => [command, tag]);
	scheduler.add_rule(act({
		name: `node ${name} command mask`,
		reads: keys,
		writes: keys,
		run: () => {
			for (const tag of unsupported) if (command[tag]) command[tag] = false;
		},
	}));
}
