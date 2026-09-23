import {
    createReadStream,
    createWriteStream,
} from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import JSZip from 'jszip';

/** @typedef {InstanceType<typeof JSZip>} JSZipArchive */

/**
 * Recursively adds all regular files beneath `directory` to a ZIP archive.
 *
 * Archive paths always use forward slashes, regardless of the host platform.
 *
 * @param {JSZipArchive} zip Archive being populated.
 * @param {string} root Root directory used to derive archive-relative paths.
 * @param {string} directory Directory currently being traversed.
 * @returns {Promise<void>}
 */
async function addDirectory(zip, root, directory) {
    const entries = await readdir(directory, {
        withFileTypes: true,
    });

    // Keep archive entry ordering deterministic across filesystems.
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
        const filename = path.join(directory, entry.name);

        if (entry.isDirectory()) {
            await addDirectory(zip, root, filename);
            continue;
        }

        // Ignore unusual filesystem entries such as sockets or device files.
        if (!entry.isFile()) {
            continue;
        }

        const archivePath = path
            .relative(root, filename)
            .split(path.sep)
            .join('/');

        // Stream source files into JSZip instead of reading every file into
        // memory before archive generation.
        zip.file(
            archivePath,
            createReadStream(filename),
        );
    }
}

/**
 * Creates a compressed ZIP archive from a directory.
 *
 * Both the source files and resulting archive are streamed, avoiding the need
 * to hold the complete language pack or ZIP output in memory at once.
 *
 * @param {string} directory Directory to archive.
 * @param {string} outputFilename Destination ZIP filename.
 * @returns {Promise<void>}
 */
export async function makeZip(directory, outputFilename) {
    const zip = new JSZip();

    await addDirectory(
        zip,
        directory,
        directory,
    );

    const archive = zip.generateNodeStream({
        streamFiles: true,
        compression: 'DEFLATE',
        compressionOptions: {
            level: 6,
        },
    });

    await pipeline(
        archive,
        createWriteStream(outputFilename),
    );
}
