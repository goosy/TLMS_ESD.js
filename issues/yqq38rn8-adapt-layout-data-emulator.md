---
id: yqq38rn8
opened: 2026-10-29T16:59:59.000Z
closed:
title: Adapt to layout-data 0.6.0, modbus-emulator 0.3.0 and es-modbus 0.3.0
status: accepted    # open | accepted | fixed | rejected | wontfix
labels: []
remote:
---

## Problem

The dependencies layout-data, modbus-emulator and es-modbus changed their interfaces one after another, and this project has to follow.

- layout-data 0.5.0 introduces layout scopes: layouts are registered in a scope, and there is no global registry; the layout description now lists the layout names under `layouts` and holds the item tables under `item_tables`; the byte map is provided by `Layout#io_index_table`; type generation becomes its development tool `layout-types`, which modbus-emulator does not forward.
- layout-data 0.6.0: `yaml_file` is renamed `desc_file`; the scope's `register_layout` is replaced by `scope.load(descriptions)`, which creates the Ldata of the data blocks in the description while registering the layouts, and block names must be unique within a layout.
- modbus-emulator 0.2.0: the constructor only accepts a scope name, `new Modbus_Emulator(scope)`; descriptions are loaded by `emulator.load(paths)`, which may be called several times, and each call either succeeds completely or changes nothing; `load` only accepts paths of description files and no longer accepts descriptions as objects; the `warnings` array of the constructor becomes the `warning` event; `stop()` gives the block names back to the layouts.
- modbus-emulator 0.3.0 (depends on es-modbus 0.3.0):
  - Blocks are placed by unit entries: the description gets the root key `units`, and block entries keep only `name` and `layout`, no longer taking `unit_id`, `start` and `offset` (an extra key is an error); a unit entry stands for a device and uses `blocks` to place blocks of its own description at `start` of the unit; every block of a description must be placed by some unit, and only once, and a unit id may be declared by one unit entry only.
  - Unit entries get the optional `endian` (`BE` by default), `unmapped_read` (`zero` by default) and `unmapped_write` (`ignore` by default), and placements get the optional `readonly` (`none` by default); with the defaults the behavior is the same as in 0.2.0.
  - `Unit_Map#attach_unit(unit_id, block, start, offset)` becomes `attach_unit(unit_id, block, { start, offset, readonly })`.
  - The `unmapped` event is emitted only for requests that succeed and carries `operation` (`read` or `write`); the events `request_refused` / `request_refused_limit` are added for refused requests.
  - A TCP port is from 1 to 65535; port 0 is rejected.
- es-modbus 0.3.0 (compared with 0.3.0-beta.4): `Modbus_Client` takes a single options object, in which exactly one of `tcp`, `rtu_over_tcp` and `serial` selects the transport, its value being the target, e.g. `new Modbus_Client({ tcp: "10.0.0.5:502" })`; the constructor parameter `address` and the options `port` and `rtu` are removed; an option that does not apply to the selected transport throws; an IPv6 host in `host:port` must be bracketed, and port 0 is not accepted.

This project used to have `create_upward` assemble a description as an object in memory and pass it to the emulator, relying on an unpublished entry point of the emulator (marked with `@ts-expect-error` in the code). With that entry point removed, the emulator cannot be constructed. After updating the dependencies to their latest versions, every test file fails while loading.

Adapting only to modbus-emulator 0.2.0 and es-modbus 0.3.0-beta.4, updating the dependencies further to their latest versions also gives these failures:

- The generated description writes `unit_id` and `start` in the block entries; modbus-emulator 0.3.0 reports an error when loading it, and the controller cannot start.
- `MTClient` constructs its client with `new Modbus_Client(host, { port, rtu, ... })`; the host string is not an options object, so es-modbus 0.3.0 throws at construction, and Modbus TCP actuators cannot be connected.
- The tests place the command block with `attach_unit(UNIT, block, 400)`; the third argument is not an options object, so the command block is placed at byte 0, overlapping the data block, which is an error.

## Proposal

Adapt directly to layout-data 0.6.0 and the new emulator interface, without a separate adaptation to layout-data 0.5.0: modbus-emulator will not publish a version adapted to 0.5.0, so a commit adapting only to 0.5.0 could not depend on published packages.

Layouts and scope:

- The controller layouts are registered in the scope `tlms` (`LAYOUT_SCOPE`); layouts are taken from the scope, and the Ldata of the data blocks are created when the scope loads the description.
- `layouts.yaml` uses the new description format; the names, types, offsets and initial values of all layout items stay the same, and the register map is unchanged.
- The byte map of the IO bindings is taken from the layout (`Layout#io_index_table`).
- `layout-data` is a development dependency at the version modbus-emulator depends on; `gen:types` uses `layout-types`.

Dependency versions: modbus-emulator `^0.3.0`; es-modbus `^0.3.0`, matching the 0.3.0 that modbus-emulator depends on, so the process and the bundle hold one copy; layout-data stays at 0.6.0.

Emulator description: the controller generates the emulator description as a file, and the emulator then loads that file.

- The files of the emulator are kept in a subdirectory of the configuration directory named after the controller, and the description file is `emulator.yaml` in it (`<controller name>/emulator.yaml`), regenerated at every start; reading the configuration reads only the top level of the configuration directory, not its subdirectories, so the description file needs no exclusion by name. Future emulator implementations of the actuators produce their description files the same way: in a subdirectory named after the actuator. The file inlines the layouts of `layouts.yaml` and, together with `blocks`, `units` and `servers`, is a complete description: an operator who opens it sees every data block and server of the emulator.
- Following the format of modbus-emulator 0.3.0, the description is split into blocks and units: block entries give only `name` and `layout`; the unit ids are taken from `controller.modbus_server.unit_id`, with one unit entry per unit id that places the blocks of that unit: the blocks of the action records, the lines and the sections at byte 0, and the data of an actuator at byte 0 and its command at byte 400. The `endian`, `unmapped_read` and `unmapped_write` of the units and the `readonly` of the placements keep their defaults, so the upward register map and response behavior are unchanged.
- The description has no root key `scope`: the scope is chosen in code (`new Modbus_Emulator(LAYOUT_SCOPE)`) and the emulator does not read the key, so writing it in the file would mislead the operator into thinking the description chooses the scope.
- Block names are determined when the object graph is built and stored on the objects: the block name of a line, section or node is the object's `name`, and the command block name and the record block name are stored in dedicated fields. Block names are kept apart from the Ldata instances; a name is never stored first and then overwritten with the instance.
- Generating the description is a pure function of the read-only object graph. A main orchestration function builds the object graph, generates and writes the description file, constructs the emulator and loads the description, and mounts the Ldata instances on the object graph (`data`, `command` and the record block), in that order; `main.js` and the tests share it. `build_runtime` uses the mounted instances directly and no longer receives the emulator.
- The tests write the description file to a temporary directory; the tests' own layouts are registered with `desc_file` and `scope.load`.
- The `unmapped` event of the emulator is logged with its `operation`.
- Tests that place blocks with `Unit_Map` directly use the options object, `attach_unit(unit_id, block, { start })`.

Modbus TCP client: `MTClient` constructs the es-modbus client with `{ tcp: "<host>:<port>", reconnect_time, reconnect_max }` and no longer passes `rtu`; an IPv6 host is bracketed. The meaning and defaults of `host` and `port` in the configuration are unchanged.

The descriptions of the upward server (§4.4) and of MTClient (§4.2) in `doc/design.md` are updated accordingly.

Rejected approaches:

- Keep passing the description as an in-memory object: it relies on an internal entry point of the emulator, which has been removed.
- Generate the description text at run time with `yaml(JSON.stringify(...))` without writing a file: it works, but the operator cannot see what the emulator actually loaded.
- Make modbus-emulator's `load` also accept objects: the description file is useful to the operator in itself, and there is no need to widen the emulator's interface for this project.
- Use this adaptation to set a unit byte order, read-only points or the refusal of unmapped addresses on the upward server: it would change the protocol behavior the HMI sees, which is not part of an adaptation; open a separate issue when needed.

## Decision

Accepted. The new versions of the dependencies no longer support the old way of construction, so the adaptation is required; the generated description file also lets the operator see the emulator's data blocks and servers. Implement as proposed.
