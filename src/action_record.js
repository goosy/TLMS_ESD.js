import { access, writeFile, appendFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import csv_parser from "csv-parser";
import { logger } from "./util.js";

const boolean_fields = ["press_action", "flow_action", "node1_pump_run", "node2_pump_run", "node3_pump_run", "node4_pump_run"];

/** The fields of a record: the tags of its layout, except the time words and the index. */
function headers_of(data) {
	return data.layout.items
		.filter((field) => field.type.toLowerCase() !== "word" && field.name !== "index")
		.map((field) => field.name);
}

function convertTypes(row, headers) {
	for (const field of headers) {
		if (boolean_fields.includes(field)) {
			row[field] = row[field] === "true";
		} else {
			const value = row[field];
			row[field] = value !== "" && value !== undefined ? Number.parseFloat(value) : null;
		}
	}
}

function set_current_time(block) {
	const d = new Date();
	block.year = d.getFullYear();
	block.month = d.getMonth() + 1;
	block.day = d.getDate();
	block.hour = d.getHours();
	block.minute = d.getMinutes();
	block.second = d.getSeconds();
}

export class Action_Record {
	records = [];
	records_size = 10;
	data;
	headers;
	name;
	file;
	/**
	 * @param {string} name - The name of the record, and of its CSV file.
	 * @param {import("modbus-emulator").Ldata} data - The data block of the record, from the upward emulator.
	 */
	constructor(name, data) {
		this.name = name;
		this.file = `${name}.csv`;
		this.data = data;
		this.headers = headers_of(data);
	}

	get(index) {
		const record = this.records[index];
		if (!record) return false;
		for (const key of this.headers) {
			this.data[key] = record[key];
		}
		return true;
	}

	async init(filename) {
		this.file = filename ?? this.file;
		try {
			await access(this.file);
			logger.info(`action record file is set to ${this.file}.`);
		} catch {
			await writeFile(this.file, `${this.headers.join(",")}\n`);
			logger.info(`Empty action record file ${this.file} is created and used.`);
		}
		await this.read_records_from_csv();
		this.data.on("change", (tagname, old_value, new_value) => {
			logger.debug(`${this.name}: ${tagname} ${old_value} => ${new_value}`);
		});
		// Initial index value
		if (this.records.length) {
			this.data.index = 0;
		} else {
			this.data.index = -1;
		}
	}

	read_records_from_csv() {
		return new Promise((resolve, reject) => {
			const records = this.records;
			records.length = 0;
			createReadStream(this.file)
				.pipe(csv_parser())
				.on("error", (error) => reject(error))
				.on("data", (row) => {
					// add record to records and ensure records' length does not exceed records_size
					if (records.unshift(row) > this.records_size) records.pop();
				})
				.on("end", () => {
					records.forEach((row) => convertTypes(row, this.headers));
					resolve(true);
				});
		});
	}

	/**
	 * Sets the fields of a new record and adds it.
	 *
	 * @param {Object<string, number|boolean>} fields - The record fields by tag name.
	 */
	async update_record(fields) {
		for (const [key, value] of Object.entries(fields)) {
			this.data[key] = value;
		}
		await this.add_record();
	}

	async add_record() {
		set_current_time(this.data);
		const record = {};
		for (const key of this.headers) {
			record[key] = this.data[key];
		}
		// add record to records and ensure records' length does not exceed records_size
		if (this.records.unshift(record) > this.records_size) this.records.pop();
		this.data.index = 0;
		// append record to csv
		const row = this.headers.map((key) => this.data[key]).join(",");
		await appendFile(this.file, `${row}\n`, { flags: "a" });
	}
}
