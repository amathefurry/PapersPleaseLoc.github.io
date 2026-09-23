import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Ensures that a directory exists, including any missing parent directories.
 *
 * @param {string} directory Directory to create.
 * @returns {Promise<void>}
 */
export async function ensureDirectory(directory) {
	await mkdir(directory, { recursive: true });
}

/**
 * Writes UTF-8 text to a file, creating its parent directory if necessary.
 *
 * @param {string} filename Destination filename.
 * @param {string} contents Text to write.
 * @returns {Promise<void>}
 */
export async function writeTextFile(filename, contents) {
	await ensureDirectory(path.dirname(filename));
	await writeFile(filename, contents, 'utf8');
}

/**
 * Writes binary data to a file, creating its parent directory if necessary.
 *
 * @param {string} filename Destination filename.
 * @param {Buffer} contents Binary data to write.
 * @returns {Promise<void>}
 */
export async function writeBinaryFile(filename, contents) {
	await ensureDirectory(path.dirname(filename));
	await writeFile(filename, contents);
}