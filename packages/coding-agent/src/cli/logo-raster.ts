/** Shared dependency-free renderer for launch, inline, and fullscreen logo frames. */
export type Rgb = readonly [number, number, number];
const DOT_BITS = [0x01, 0x08, 0x02, 0x10, 0x04, 0x20, 0x40, 0x80];
const LOGO_COLOR_STEP = 5;
const HALO_RADIUS_X = 6;
const HALO_RADIUS_Y = 3;
const HALO_LEVELS = 32;
const LIGHT = normalize([-0.45, -0.6, 0.75]);
const HALF_VECTOR = normalize([LIGHT[0], LIGHT[1], LIGHT[2] + 1]);

export interface Box {
	min: readonly [number, number, number];
	max: readonly [number, number, number];
	color: Rgb;
}

export interface Pose {
	centerX: number;
	centerY: number;
	/** Braille dots per model pixel at depth 0. */
	scale: number;
	yaw: number;
	pitch: number;
	roll: number;
}

function normalize(v: readonly [number, number, number]): [number, number, number] {
	const length = Math.hypot(v[0], v[1], v[2]);
	return [v[0] / length, v[1] / length, v[2] / length];
}

export function clamp01(value: number): number {
	return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Whether a background is light, by relative luminance. */
export function isLight([r, g, b]: Rgb): boolean {
	return 0.2126 * r + 0.7152 * g + 0.0722 * b > 128;
}

/** Row-major 3x3 rotation matrix for yaw (y), then pitch (x), then roll (z). */
function rotation(yaw: number, pitch: number, roll: number): number[] {
	const [sy, cy, sx, cx, sz, cz] = [
		Math.sin(yaw),
		Math.cos(yaw),
		Math.sin(pitch),
		Math.cos(pitch),
		Math.sin(roll),
		Math.cos(roll),
	];
	// Rz * Rx * Ry
	const ry = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
	const rx = [1, 0, 0, 0, cx, -sx, 0, sx, cx];
	const rz = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
	return multiply(rz, multiply(rx, ry));
}

function multiply(a: number[], b: number[]): number[] {
	const result = new Array<number>(9);
	for (let row = 0; row < 3; row++) {
		for (let column = 0; column < 3; column++) {
			result[row * 3 + column] =
				a[row * 3]! * b[column]! + a[row * 3 + 1]! * b[3 + column]! + a[row * 3 + 2]! * b[6 + column]!;
		}
	}
	return result;
}

interface Face {
	axis: number;
	/** Plane coordinate on `axis` in object space. */
	plane: number;
	uMin: number;
	uMax: number;
	vMin: number;
	vMax: number;
	/** Projected bounds in braille dots, inclusive. */
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
	red: number;
	green: number;
	blue: number;
}

/**
 * Renders the model's blocks into braille cells. Only faces that point at the camera and are not covered by a
 * touching block are drawn. Each face is rasterized over its projected bounds by intersecting each dot's ray
 * with the face's plane, with a depth buffer resolving overlaps. Buffers are reused between frames.
 */
export class BlockRaster {
	/** Braille dot bits per cell. */
	bits = new Uint8Array(0);
	/** Lit dots per cell. */
	counts = new Uint8Array(0);
	/** Summed RGB of the lit dots per cell. */
	rgb = new Float32Array(0);
	/** Halo tint strength per cell, from 0 to 1. Only set when a halo was requested. */
	haloAmount = new Float32Array(0);
	/** Halo color per cell. */
	haloRgb = new Float32Array(0);
	private width = 0;
	private height = 0;
	/** Ray parameter of the nearest hit per dot; smaller is nearer. */
	private depth = new Float32Array(0);
	/** Face index + 1 of the nearest hit per dot, 0 for none. */
	private faceIds = new Uint16Array(0);
	/** Cells written by the previous frame, cleared before the next one. */
	private dirty: { minX: number; minY: number; maxX: number; maxY: number } | undefined;
	/** Cells with a halo from the previous frame, cleared before the next one. */
	private haloDirty: { minX: number; minY: number; maxX: number; maxY: number } | undefined;
	private readonly cameraDistance: number;

	constructor(cameraDistance: number) {
		this.cameraDistance = cameraDistance;
	}

	render(
		width: number,
		height: number,
		pose: Pose,
		boxes: readonly Box[],
		background: Rgb,
		haloStrength: number,
	): void {
		const dotWidth = width * 2;
		const dotHeight = height * 4;
		if (width !== this.width || height !== this.height) {
			this.width = width;
			this.height = height;
			this.bits = new Uint8Array(width * height);
			this.counts = new Uint8Array(width * height);
			this.rgb = new Float32Array(width * height * 3);
			this.haloAmount = new Float32Array(width * height);
			this.haloRgb = new Float32Array(width * height * 3);
			this.haloDirty = undefined;
			this.depth = new Float32Array(dotWidth * dotHeight).fill(Infinity);
			this.faceIds = new Uint16Array(dotWidth * dotHeight);
			this.dirty = undefined;
		} else if (this.dirty) {
			const { minX, minY, maxX, maxY } = this.dirty;
			for (let row = minY; row <= maxY; row++) {
				this.bits.fill(0, row * width + minX, row * width + maxX + 1);
				this.counts.fill(0, row * width + minX, row * width + maxX + 1);
				this.rgb.fill(0, (row * width + minX) * 3, (row * width + maxX + 1) * 3);
			}
			this.dirty = undefined;
		}
		if (this.haloDirty) {
			const { minX, minY, maxX, maxY } = this.haloDirty;
			for (let row = minY; row <= maxY; row++) {
				this.haloAmount.fill(0, row * width + minX, row * width + maxX + 1);
				this.haloRgb.fill(0, (row * width + minX) * 3, (row * width + maxX + 1) * 3);
			}
			this.haloDirty = undefined;
		}

		const m = rotation(pose.yaw, pose.pitch, pose.roll);
		const { centerX, centerY, scale } = pose;
		const cameraDistance = this.cameraDistance;
		// The camera sits at (0, 0, cameraDistance) in camera space; object space is the transpose rotation.
		const origin = [m[6]! * cameraDistance, m[7]! * cameraDistance, m[8]! * cameraDistance];
		const light = isLight(background);
		const faces = this.visibleFaces(m, origin, pose, boxes, dotWidth, dotHeight, light);
		if (faces.length === 0) return;
		let minX = dotWidth;
		let minY = dotHeight;
		let maxX = -1;
		let maxY = -1;
		for (const face of faces) {
			minX = Math.min(minX, face.minX);
			minY = Math.min(minY, face.minY);
			maxX = Math.max(maxX, face.maxX);
			maxY = Math.max(maxY, face.maxY);
		}
		if (maxX < minX || maxY < minY) return;

		const depth = this.depth;
		const faceIds = this.faceIds;
		for (let faceIndex = 0; faceIndex < faces.length; faceIndex++) {
			const face = faces[faceIndex]!;
			const a = face.axis;
			const u = (a + 1) % 3;
			const v = (a + 2) % 3;
			const originA = origin[a]!;
			const originU = origin[u]!;
			const originV = origin[v]!;
			// The ray direction in object space is linear in the dot position, so it is stepped per dot.
			const stepA = m[a]! / scale;
			const stepU = m[u]! / scale;
			const stepV = m[v]! / scale;
			const sx = (face.minX + 0.5 - centerX) / scale;
			for (let dotY = face.minY; dotY <= face.maxY; dotY++) {
				const sy = (dotY + 0.5 - centerY) / scale;
				let directionA = m[a]! * sx + m[3 + a]! * sy - m[6 + a]! * cameraDistance;
				let directionU = m[u]! * sx + m[3 + u]! * sy - m[6 + u]! * cameraDistance;
				let directionV = m[v]! * sx + m[3 + v]! * sy - m[6 + v]! * cameraDistance;
				let index = dotY * dotWidth + face.minX;
				for (let dotX = face.minX; dotX <= face.maxX; dotX++, index++) {
					const t = (face.plane - originA) / directionA;
					if (t > 0 && t < depth[index]!) {
						const hitU = originU + t * directionU;
						const hitV = originV + t * directionV;
						if (hitU >= face.uMin && hitU <= face.uMax && hitV >= face.vMin && hitV <= face.vMax) {
							depth[index] = t;
							faceIds[index] = faceIndex + 1;
						}
					}
					directionA += stepA;
					directionU += stepU;
					directionV += stepV;
				}
			}
		}

		// Shade the hit dots, pack them into braille cells, and reset the dot buffers for the next frame.
		const bits = this.bits;
		const counts = this.counts;
		const rgb = this.rgb;
		let cellMinX = width;
		let cellMinY = height;
		let cellMaxX = -1;
		let cellMaxY = -1;
		for (let dotY = minY; dotY <= maxY; dotY++) {
			let index = dotY * dotWidth + minX;
			for (let dotX = minX; dotX <= maxX; dotX++, index++) {
				const id = faceIds[index]!;
				if (id === 0) continue;
				const face = faces[id - 1]!;
				// Points farther from the camera fade slightly toward the background for depth.
				const fog = clamp01(0.15 - cameraDistance * (1 - depth[index]!) * 0.12) * (light ? 0.5 : 1);
				faceIds[index] = 0;
				depth[index] = Infinity;
				const cellX = dotX >> 1;
				const cellY = dotY >> 2;
				const cell = cellY * width + cellX;
				bits[cell]! |= DOT_BITS[(dotY & 3) * 2 + (dotX & 1)];
				counts[cell]!++;
				rgb[cell * 3] += face.red + (background[0] - face.red) * fog;
				rgb[cell * 3 + 1] += face.green + (background[1] - face.green) * fog;
				rgb[cell * 3 + 2] += face.blue + (background[2] - face.blue) * fog;
				if (cellX < cellMinX) cellMinX = cellX;
				if (cellX > cellMaxX) cellMaxX = cellX;
				if (cellY < cellMinY) cellMinY = cellY;
				if (cellY > cellMaxY) cellMaxY = cellY;
			}
		}
		if (cellMaxX >= 0) this.dirty = { minX: cellMinX, minY: cellMinY, maxX: cellMaxX, maxY: cellMaxY };
		if (haloStrength > 0) this.renderHalo(haloStrength);
	}

	/**
	 * Blur the logo's coverage and color over neighboring cells with a separable tent filter, so the tint falls
	 * off smoothly past the logo's edges.
	 */
	private renderHalo(strength: number): void {
		const cells = this.dirty;
		if (!cells) return;
		const { width, height, counts, rgb } = this;
		const minX = Math.max(0, cells.minX - HALO_RADIUS_X);
		const maxX = Math.min(width - 1, cells.maxX + HALO_RADIUS_X);
		const minY = Math.max(0, cells.minY - HALO_RADIUS_Y);
		const maxY = Math.min(height - 1, cells.maxY + HALO_RADIUS_Y);
		const regionWidth = maxX - minX + 1;
		const tent = (radius: number) => {
			const weights = Array.from({ length: radius * 2 + 1 }, (_, i) => radius + 1 - Math.abs(i - radius));
			const total = weights.reduce((sum, weight) => sum + weight, 0);
			return weights.map((weight) => weight / total);
		};
		const weightsX = tent(HALO_RADIUS_X);
		const weightsY = tent(HALO_RADIUS_Y);

		// Horizontal pass over the rows that contain the logo: coverage and premultiplied color per cell.
		const rows = cells.maxY - cells.minY + 1;
		const horizontal = new Float32Array(rows * regionWidth * 4);
		for (let y = cells.minY; y <= cells.maxY; y++) {
			for (let x = minX; x <= maxX; x++) {
				let coverage = 0;
				let red = 0;
				let green = 0;
				let blue = 0;
				for (let dx = -HALO_RADIUS_X; dx <= HALO_RADIUS_X; dx++) {
					const sourceX = x + dx;
					if (sourceX < cells.minX || sourceX > cells.maxX) continue;
					const source = y * width + sourceX;
					const count = counts[source]!;
					if (count === 0) continue;
					const weight = weightsX[dx + HALO_RADIUS_X]! / 8;
					coverage += count * weight;
					red += rgb[source * 3]! * weight;
					green += rgb[source * 3 + 1]! * weight;
					blue += rgb[source * 3 + 2]! * weight;
				}
				const target = ((y - cells.minY) * regionWidth + (x - minX)) * 4;
				horizontal[target] = coverage;
				horizontal[target + 1] = red;
				horizontal[target + 2] = green;
				horizontal[target + 3] = blue;
			}
		}

		// Vertical pass into the halo buffers.
		for (let y = minY; y <= maxY; y++) {
			for (let x = minX; x <= maxX; x++) {
				let coverage = 0;
				let red = 0;
				let green = 0;
				let blue = 0;
				for (let dy = -HALO_RADIUS_Y; dy <= HALO_RADIUS_Y; dy++) {
					const sourceY = y + dy;
					if (sourceY < cells.minY || sourceY > cells.maxY) continue;
					const weight = weightsY[dy + HALO_RADIUS_Y]!;
					const source = ((sourceY - cells.minY) * regionWidth + (x - minX)) * 4;
					coverage += horizontal[source]! * weight;
					red += horizontal[source + 1]! * weight;
					green += horizontal[source + 2]! * weight;
					blue += horizontal[source + 3]! * weight;
				}
				const target = y * width + x;
				// Cells under the logo keep at least their own coverage, so faces stay solidly tinted.
				const count = counts[target]!;
				if (count > 0 && count / 8 > coverage) {
					coverage = count / 8;
					red = (rgb[target * 3]! / count) * coverage;
					green = (rgb[target * 3 + 1]! / count) * coverage;
					blue = (rgb[target * 3 + 2]! / count) * coverage;
				}
				if (coverage <= 0) continue;
				// Quantized so neighboring cells usually share a background and its escape sequence.
				const amount = Math.round(strength * Math.min(1, coverage) ** 0.7 * HALO_LEVELS) / HALO_LEVELS;
				if (amount <= 0) continue;
				this.haloAmount[target] = amount;
				this.haloRgb[target * 3] = Math.round(red / coverage / LOGO_COLOR_STEP) * LOGO_COLOR_STEP;
				this.haloRgb[target * 3 + 1] = Math.round(green / coverage / LOGO_COLOR_STEP) * LOGO_COLOR_STEP;
				this.haloRgb[target * 3 + 2] = Math.round(blue / coverage / LOGO_COLOR_STEP) * LOGO_COLOR_STEP;
			}
		}
		this.haloDirty = { minX, minY, maxX, maxY };
	}

	private visibleFaces(
		m: number[],
		origin: number[],
		pose: Pose,
		boxes: readonly Box[],
		dotWidth: number,
		dotHeight: number,
		lightBackground: boolean,
	): Face[] {
		const faces: Face[] = [];
		const cameraDistance = this.cameraDistance;
		for (const box of boxes) {
			for (let a = 0; a < 3; a++) {
				const u = (a + 1) % 3;
				const v = (a + 2) % 3;
				for (const side of [-1, 1]) {
					const plane = side > 0 ? box.max[a]! : box.min[a]!;
					// Back faces point away from the camera.
					if ((origin[a]! - plane) * side <= 0) continue;
					// Faces pressed against a neighboring block are hidden. Positions are exact while blocks rest.
					const covered = boxes.some(
						(other) =>
							other !== box &&
							(side > 0 ? other.min[a] : other.max[a]) === plane &&
							other.min[u]! <= box.min[u]! &&
							other.max[u]! >= box.max[u]! &&
							other.min[v]! <= box.min[v]! &&
							other.max[v]! >= box.max[v]!,
					);
					if (covered) continue;

					let minX = Infinity;
					let minY = Infinity;
					let maxX = -Infinity;
					let maxY = -Infinity;
					const corner = [0, 0, 0];
					for (const cornerU of [box.min[u]!, box.max[u]!]) {
						for (const cornerV of [box.min[v]!, box.max[v]!]) {
							corner[a] = plane;
							corner[u] = cornerU;
							corner[v] = cornerV;
							const x = m[0]! * corner[0]! + m[1]! * corner[1]! + m[2]! * corner[2]!;
							const y = m[3]! * corner[0]! + m[4]! * corner[1]! + m[5]! * corner[2]!;
							const z = m[6]! * corner[0]! + m[7]! * corner[1]! + m[8]! * corner[2]!;
							const perspective = (pose.scale * cameraDistance) / (cameraDistance - z);
							const screenX = pose.centerX + x * perspective;
							const screenY = pose.centerY + y * perspective;
							minX = Math.min(minX, screenX);
							minY = Math.min(minY, screenY);
							maxX = Math.max(maxX, screenX);
							maxY = Math.max(maxY, screenY);
						}
					}
					const face = {
						minX: Math.max(0, Math.floor(minX)),
						minY: Math.max(0, Math.floor(minY)),
						maxX: Math.min(dotWidth - 1, Math.ceil(maxX)),
						maxY: Math.min(dotHeight - 1, Math.ceil(maxY)),
					};
					if (face.maxX < face.minX || face.maxY < face.minY) continue;

					// Faces are flat, so lighting is computed once per face. The normal in camera space is a
					// column of the rotation matrix.
					const nx = m[a]! * side;
					const ny = m[3 + a]! * side;
					const nz = m[6 + a]! * side;
					const diffuse = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
					const rim = Math.max(0, nx * 0.8 - nz * 0.3);
					// On light backgrounds, highlights toward white would vanish, so faces only get darker than
					// the brand colors there.
					const specular = lightBackground
						? 0
						: Math.max(0, nx * HALF_VECTOR[0] + ny * HALF_VECTOR[1] + nz * HALF_VECTOR[2]) ** 24 * 0.6 * 255;
					const light = lightBackground
						? Math.min(1, 0.55 + diffuse * 0.45 + rim * 0.1)
						: 0.45 + diffuse * 0.78 + rim * 0.25;
					faces.push({
						axis: a,
						plane,
						uMin: box.min[u]!,
						uMax: box.max[u]!,
						vMin: box.min[v]!,
						vMax: box.max[v]!,
						...face,
						red: Math.min(255, box.color[0] * light + specular),
						green: Math.min(255, box.color[1] * light + specular),
						blue: Math.min(255, box.color[2] * light + specular),
					});
				}
			}
		}
		return faces;
	}
}
