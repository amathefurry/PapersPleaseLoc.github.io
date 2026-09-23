import { Jimp } from 'jimp';

/**
 * Minimal image surface used by the pixel-processing helpers.
 *
 * Keeping this structural type deliberately small avoids coupling the helpers
 * to Jimp's full generic instance type.
 *
 * @typedef {object} PixelImage
 * @property {{data: Buffer}} bitmap Raw RGBA pixel data.
 * @property {number} width Image width in pixels.
 * @property {number} height Image height in pixels.
 * @property {(x?: number, y?: number, w?: number, h?: number) => Iterable<{ x:
 *   number, y: number, idx: number, }>} scanIterator Iterates pixels in
 *   row-major order.
 * @property {(options: { x: number, y: number, w: number, h: number, }) =>
 *   unknown} crop Crops the image in place.
 */

/** @typedef {[number, number, number]} RGB */
/** @typedef {[number, number, number]} LAB */

/**
 * @typedef {object} Rect
 * @property {number} x Left coordinate in pixels.
 * @property {number} y Top coordinate in pixels.
 * @property {number} width Rectangle width in pixels.
 * @property {number} height Rectangle height in pixels.
 */

/**
 * Describes a region that must be mapped to a fixed RGB palette.
 *
 * @typedef {object} QuantizeRect
 * @property {Rect} rect Region to quantize, in logical image coordinates.
 * @property {RGB[]} colors Allowed RGB palette.
 */

const D65_X = 95.047;
const D65_Y = 100;
const D65_Z = 108.883;

const LAB_EPSILON = 216 / 24_389;
const LAB_KAPPA = 24_389 / 27;

/**
 * Converts one 8-bit sRGB channel to its linear-light representation.
 *
 * @param {number} channel Channel value in the range 0-255.
 * @returns {number}
 */
function linearizeSrgb(channel) {
    const normalized = channel / 255;

    return normalized <= 0.04045
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
}

/**
 * Applies the piecewise transform used when converting XYZ to CIE L*a*b*.
 *
 * @param {number} value XYZ component normalized to the reference white.
 * @returns {number}
 */
function labTransform(value) {
    return value > LAB_EPSILON
        ? Math.cbrt(value)
        : (LAB_KAPPA * value + 16) / 116;
}

/**
 * Converts an sRGB color to CIE L*a*b* using a D65 reference white.
 *
 * @param {RGB} rgb RGB components in the range 0-255.
 * @returns {LAB}
 */
function rgbToLab([red, green, blue]) {
    const r = linearizeSrgb(red) * 100;
    const g = linearizeSrgb(green) * 100;
    const b = linearizeSrgb(blue) * 100;

    const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / D65_X;
    const y = (r * 0.2126 + g * 0.7152 + b * 0.0722) / D65_Y;
    const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / D65_Z;

    const fx = labTransform(x);
    const fy = labTransform(y);
    const fz = labTransform(z);

    return [
        116 * fy - 16,
        500 * (fx - fy),
        200 * (fy - fz),
    ];
}

/**
 * Converts the game's chroma-key colors into their intended alpha values.
 * Magenta (0xff00ff) becomes transparent and dark magenta (0x7f007f) becomes a
 * 50% black shadow.
 *
 * @param {PixelImage} image Image to modify in place.
 * @returns {void}
 */
function fixImageAlpha(image) {
    const data = image.bitmap.data;

    for (const { idx } of image.scanIterator()) {
        const red = data[idx];
        const green = data[idx + 1];
        const blue = data[idx + 2];

        if (red === 255 && green === 0 && blue === 255) {
            data[idx + 3] = 0;
        } else if (red === 127 && green === 0 && blue === 127) {
            data[idx] = 0;
            data[idx + 1] = 0;
            data[idx + 2] = 0;
            data[idx + 3] = 127;
        }
    }
}

/**
 * Quantizes a rectangular image region to the nearest color in a fixed palette.
 * Distances are compared in CIE L*a*b* space.
 *
 * @param {PixelImage} image Image to modify in place.
 * @param {Rect} rect Region to quantize.
 * @param {RGB[]} colors Allowed RGB palette.
 * @returns {void}
 */
function quantizeImage(image, rect, colors) {
    if (colors.length === 0) {
        throw new Error('Cannot quantize an image region with an empty palette');
    }

    if (rect.width <= 0 || rect.height <= 0) {
        return;
    }

    const paletteLab = colors.map(rgbToLab);
    const data = image.bitmap.data;

    // Repeated source colors are common in pixel art. Cache the final palette
    // choice, not just the RGB-to-Lab conversion, so repeated pixels avoid the
    // complete nearest-color search.
    /** @type {Map<number, number>} */
    const nearestColorCache = new Map();

    for (const { idx } of image.scanIterator(
        rect.x,
        rect.y,
        rect.width,
        rect.height,
    )) {
        const red = data[idx];
        const green = data[idx + 1];
        const blue = data[idx + 2];
        const rgbKey = (red << 16) | (green << 8) | blue;

        let nearestIndex = nearestColorCache.get(rgbKey);

        if (nearestIndex === undefined) {
            const pixelLab = rgbToLab([red, green, blue]);
            let nearestDistanceSquared = Infinity;
            nearestIndex = 0;

            for (let index = 0; index < paletteLab.length; index++) {
                const deltaL = paletteLab[index][0] - pixelLab[0];
                const deltaA = paletteLab[index][1] - pixelLab[1];
                const deltaB = paletteLab[index][2] - pixelLab[2];
                const distanceSquared = (
                    deltaL * deltaL
                    + deltaA * deltaA
                    + deltaB * deltaB
                );

                if (distanceSquared < nearestDistanceSquared) {
                    nearestDistanceSquared = distanceSquared;
                    nearestIndex = index;
                }
            }

            nearestColorCache.set(rgbKey, nearestIndex);
        }

        data[idx] = colors[nearestIndex][0];
        data[idx + 1] = colors[nearestIndex][1];
        data[idx + 2] = colors[nearestIndex][2];
    }
}

/**
 * Crops transparent borders while preserving every pixel whose alpha is greater
 * than 1. The image is modified in place.
 *
 * @param {PixelImage} image Image to crop.
 * @returns {void}
 */
function autocropImage(image) {
    const data = image.bitmap.data;

    let minX = image.width;
    let minY = image.height;
    let maxX = -1;
    let maxY = -1;

    for (const { x, y, idx } of image.scanIterator()) {
        if (data[idx + 3] <= 1) {
            continue;
        }

        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
    }

    // No visible pixels, or no border to remove.
    if (
        maxX < minX
        || maxY < minY
        || (
            minX === 0
            && minY === 0
            && maxX === image.width - 1
            && maxY === image.height - 1
        )
    ) {
        return;
    }

    image.crop({
        x: minX,
        y: minY,
        w: maxX - minX + 1,
        h: maxY - minY + 1,
    });
}

/**
 * Scales a logical rectangle into screenshot coordinates.
 *
 * @param {Rect} rect Rectangle to scale.
 * @param {number} scale Uniform integer scale factor.
 * @returns {Rect}
 */
function scaleRect(rect, scale) {
    return {
        x: rect.x * scale,
        y: rect.y * scale,
        width: rect.width * scale,
        height: rect.height * scale,
    };
}

/**
 * Downscales pixel art by selecting the most common RGBA color from each `step`
 * by `step` source block instead of interpolating between colors.
 *
 * @param {PixelImage} image Source image.
 * @param {number} step Number of source pixels represented by one output pixel
 * on each axis.
 * @returns Newly allocated downscaled Jimp image.
 */
function downscale(image, step) {
    if (!Number.isInteger(step) || step < 1) {
        throw new RangeError(
            `Downscale factor must be a positive integer, got ${step}`,
        );
    }

    if (image.width % step !== 0 || image.height % step !== 0) {
        throw new RangeError(
            `Image size ${image.width}x${image.height} is not divisible `
            + `by downscale factor ${step}`,
        );
    }

    const output = new Jimp({
        width: image.width / step,
        height: image.height / step,
        color: 0x00_00_00_00,
    });

    const sourceData = image.bitmap.data;
    const outputData = output.bitmap.data;

    // Reuse one map for every output pixel rather than allocating a new map for
    // every source block.
    /** @type {Map<number, number>} */
    const colorCounts = new Map();

    for (let outputY = 0; outputY < output.height; outputY++) {
        for (let outputX = 0; outputX < output.width; outputX++) {
            colorCounts.clear();

            let bestColor = 0;
            let bestCount = 0;

            const sourceY0 = outputY * step;
            const sourceX0 = outputX * step;

            for (let sourceY = sourceY0; sourceY < sourceY0 + step; sourceY++) {
                for (let sourceX = sourceX0; sourceX < sourceX0 + step; sourceX++) {
                    const sourceIndex = (sourceY * image.width + sourceX) * 4;

                    // Force the packed RGBA value to unsigned 32-bit form so the
                    // high red bit cannot turn the map key into a negative number.
                    const color = (
                        (sourceData[sourceIndex] << 24)
                        | (sourceData[sourceIndex + 1] << 16)
                        | (sourceData[sourceIndex + 2] << 8)
                        | sourceData[sourceIndex + 3]
                    ) >>> 0;

                    const count = (colorCounts.get(color) ?? 0) + 1;
                    colorCounts.set(color, count);

                    if (count > bestCount) {
                        bestColor = color;
                        bestCount = count;
                    }
                }
            }

            const outputIndex = (
                (outputY * output.width + outputX) * 4
            );

            outputData[outputIndex] = bestColor >>> 24;
            outputData[outputIndex + 1] = (bestColor >>> 16) & 0xFF;
            outputData[outputIndex + 2] = (bestColor >>> 8) & 0xFF;
            outputData[outputIndex + 3] = bestColor & 0xFF;
        }
    }

    return output;
}

/**
 * Applies the complete post-processing pipeline to a captured image.
 *
 * Quantization is performed before cropping because quantization rectangles use
 * the original screenshot coordinate system. Chroma-key conversion remains
 * after cropping so the existing autocrop behavior is preserved.
 *
 * @param {string} filename Captured image path.
 * @param {number} width Intended logical width.
 * @param {number} height Intended logical height.
 * @param {QuantizeRect[]} quantizeRects Palette-constrained image regions.
 * @param {boolean} wantAutoCrop Whether transparent borders should be removed.
 * @returns {Promise<void>}
 */
export async function finalizeImage(
    filename,
    width,
    height,
    quantizeRects,
    wantAutoCrop,
) {
    if (width <= 0 || height <= 0) {
        throw new RangeError(
            `Invalid logical image size ${width}x${height} for ${filename}`,
        );
    }

    const image = await Jimp.read(filename);

    // Determine the screenshot scale before cropping can change the dimensions.
    const scaleX = image.width / width;
    const scaleY = image.height / height;

    if (
        scaleX !== scaleY
        || !Number.isInteger(scaleX)
        || scaleX < 1
    ) {
        throw new Error(
            `Unexpected capture size ${image.width}x${image.height} for `
            + `${width}x${height} logical image ${filename}`,
        );
    }

    const captureScale = scaleX;

    // Quantization rectangles are expressed relative to the uncropped image.
    for (const { rect, colors } of quantizeRects) {
        quantizeImage(
            image,
            scaleRect(rect, captureScale),
            colors,
        );
    }

    if (wantAutoCrop) {
        autocropImage(image);
    }

    // Convert 0xff00ff to transparent and 0x7f007f to a 50% black shadow.
    fixImageAlpha(image);

    if (captureScale > 1) {
        const output = downscale(image, captureScale);
        await output.write(
            /** @type {`${string}.${string}`} */(filename),
        );
        return;
    }

    await image.write(
        /** @type {`${string}.${string}`} */(filename),
    );
}
