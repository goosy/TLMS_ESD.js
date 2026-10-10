// Codecs of the tag types on a big-endian buffer (doc/design.md 3.3).
// `byte` is the byte offset of the tag; `mask` is the bit mask of a Bool.
// Device byte order is handled at the IO boundary, not here.

const read_bool = (buffer, byte, mask) => (buffer[byte] & mask) !== 0;
const write_bool = (buffer, byte, mask, value) => {
	buffer[byte] = value ? buffer[byte] | mask : buffer[byte] & ~mask;
};

/**
 * Codec of each tag type (lower case): its size in bytes, `get(buffer, byte, mask)`
 * and `set(buffer, byte, mask, value)`. Out-of-range integers throw RangeError
 * before anything is written.
 */
export const CODECS = {
	bool: { size: 1, get: read_bool, set: write_bool },
	byte: { size: 1, get: (b, i) => b.readUInt8(i), set: (b, i, _m, v) => b.writeUInt8(v, i) },
	usint: { size: 1, get: (b, i) => b.readUInt8(i), set: (b, i, _m, v) => b.writeUInt8(v, i) },
	sint: { size: 1, get: (b, i) => b.readInt8(i), set: (b, i, _m, v) => b.writeInt8(v, i) },
	int: { size: 2, get: (b, i) => b.readInt16BE(i), set: (b, i, _m, v) => b.writeInt16BE(v, i) },
	uint: { size: 2, get: (b, i) => b.readUInt16BE(i), set: (b, i, _m, v) => b.writeUInt16BE(v, i) },
	word: { size: 2, get: (b, i) => b.readUInt16BE(i), set: (b, i, _m, v) => b.writeUInt16BE(v, i) },
	dint: { size: 4, get: (b, i) => b.readInt32BE(i), set: (b, i, _m, v) => b.writeInt32BE(v, i) },
	udint: { size: 4, get: (b, i) => b.readUInt32BE(i), set: (b, i, _m, v) => b.writeUInt32BE(v, i) },
	dword: { size: 4, get: (b, i) => b.readUInt32BE(i), set: (b, i, _m, v) => b.writeUInt32BE(v, i) },
	real: { size: 4, get: (b, i) => b.readFloatBE(i), set: (b, i, _m, v) => b.writeFloatBE(v, i) },
};
