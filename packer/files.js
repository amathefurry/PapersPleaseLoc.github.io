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

/**
 * Resolves an output path while ensuring that it remains inside `root`.
 *
 * @param {string} root Root output directory.
 * @param {string} relativePath Path relative to the root.
 * @returns {string}
 */
export function resolveOutputPath(root, relativePath) {
	const resolvedRoot = path.resolve(root);
	const resolvedPath = path.resolve(resolvedRoot, relativePath);
	const relative = path.relative(resolvedRoot, resolvedPath);

	if (
		relative === '..'
		|| relative.startsWith(`..${path.sep}`)
		|| path.isAbsolute(relative)
	) {
		throw new Error(
			`Output path escapes destination directory: ${relativePath}`,
		);
	}

	return resolvedPath;
}
