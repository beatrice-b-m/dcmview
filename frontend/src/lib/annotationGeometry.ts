import type { EmbedRoiAnnotations } from "../api";

export type RoiCoord = [number, number, number, number];
export type RoiHandle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";
export type ImagePoint = { x: number; y: number };

export function emptyAnnotations(): EmbedRoiAnnotations {
	return { num_roi: 0, roi_coords: [], roi_frames: [] };
}

export function canonicalRect(start: ImagePoint, end: ImagePoint, rows: number, columns: number): RoiCoord | null {
	const y0 = clamp(Math.round(Math.min(start.y, end.y)), 0, rows);
	const y1 = clamp(Math.round(Math.max(start.y, end.y)), 0, rows);
	const x0 = clamp(Math.round(Math.min(start.x, end.x)), 0, columns);
	const x1 = clamp(Math.round(Math.max(start.x, end.x)), 0, columns);
	if (y1 - y0 < 2 || x1 - x0 < 2) return null;
	return [y0, x0, y1, x1];
}

export function normalizeAnnotationsForEdit(
	annotations: EmbedRoiAnnotations | null,
	frameCount: number,
): EmbedRoiAnnotations {
	const source = annotations ?? emptyAnnotations();
	const roiCoords = source.roi_coords.map((coord) => canonicalCoord(coord));
	let roiFrames = source.roi_frames.map((frames) => uniqueSortedFrames(frames, frameCount));
	if (roiFrames.length === 0 && roiCoords.length > 0) {
		roiFrames = roiCoords.map(() => allFrames(frameCount));
	}
	if (roiFrames.length !== roiCoords.length) {
		roiFrames = roiCoords.map((_, idx) => roiFrames[idx] ?? []);
	}
	return {
		num_roi: roiCoords.length,
		roi_coords: roiCoords,
		roi_frames: roiFrames,
	};
}

export function addRoi(
	annotations: EmbedRoiAnnotations | null,
	coord: RoiCoord,
	frame: number,
	frameCount: number,
): EmbedRoiAnnotations {
	const next = normalizeAnnotationsForEdit(annotations, frameCount);
	return {
		num_roi: next.num_roi + 1,
		roi_coords: [...next.roi_coords, coord],
		roi_frames: [...next.roi_frames, [frame]],
	};
}

export function updateRoiCoord(
	annotations: EmbedRoiAnnotations,
	roiIndex: number,
	coord: RoiCoord,
	frameCount: number,
): EmbedRoiAnnotations {
	const next = normalizeAnnotationsForEdit(annotations, frameCount);
	next.roi_coords = next.roi_coords.map((existing, idx) => (idx === roiIndex ? coord : existing));
	return { ...next, num_roi: next.roi_coords.length };
}

export function deleteRoi(
	annotations: EmbedRoiAnnotations,
	roiIndex: number,
	frameCount: number,
): EmbedRoiAnnotations {
	const next = normalizeAnnotationsForEdit(annotations, frameCount);
	const roiCoords = next.roi_coords.filter((_, idx) => idx !== roiIndex);
	const roiFrames = next.roi_frames.filter((_, idx) => idx !== roiIndex);
	return { num_roi: roiCoords.length, roi_coords: roiCoords, roi_frames: roiFrames };
}

export function setRoiFrameScope(
	annotations: EmbedRoiAnnotations,
	roiIndex: number,
	scope: "current" | "all",
	frame: number,
	frameCount: number,
): EmbedRoiAnnotations {
	const next = normalizeAnnotationsForEdit(annotations, frameCount);
	next.roi_frames = next.roi_frames.map((frames, idx) => {
		if (idx !== roiIndex) return frames;
		return scope === "all" ? allFrames(frameCount) : [frame];
	});
	return next;
}

export function moveCoord(coord: RoiCoord, delta: ImagePoint, rows: number, columns: number): RoiCoord {
	const [ymin, xmin, ymax, xmax] = coord;
	const height = ymax - ymin;
	const width = xmax - xmin;
	const nextY = clamp(Math.round(ymin + delta.y), 0, Math.max(0, rows - height));
	const nextX = clamp(Math.round(xmin + delta.x), 0, Math.max(0, columns - width));
	return [nextY, nextX, nextY + height, nextX + width];
}

export function resizeCoord(coord: RoiCoord, handle: RoiHandle, point: ImagePoint, rows: number, columns: number): RoiCoord | null {
	let [ymin, xmin, ymax, xmax] = coord;
	const x = clamp(Math.round(point.x), 0, columns);
	const y = clamp(Math.round(point.y), 0, rows);
	if (handle.includes("n")) ymin = y;
	if (handle.includes("s")) ymax = y;
	if (handle.includes("w")) xmin = x;
	if (handle.includes("e")) xmax = x;
	return canonicalRect({ x: xmin, y: ymin }, { x: xmax, y: ymax }, rows, columns);
}

export function allFrames(frameCount: number): number[] {
	return Array.from({ length: frameCount }, (_, idx) => idx);
}

export function isAllFrames(frames: number[] | null, frameCount: number): boolean {
	return frames === null || (frames.length === frameCount && frames.every((frame, idx) => frame === idx));
}

function canonicalCoord([ymin, xmin, ymax, xmax]: RoiCoord): RoiCoord {
	return [Math.min(ymin, ymax), Math.min(xmin, xmax), Math.max(ymin, ymax), Math.max(xmin, xmax)];
}

function uniqueSortedFrames(frames: number[], frameCount: number): number[] {
	return [...new Set(frames)]
		.filter((frame) => Number.isInteger(frame) && frame >= 0 && frame < frameCount)
		.sort((a, b) => a - b);
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}
