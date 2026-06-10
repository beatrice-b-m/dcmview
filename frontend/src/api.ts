import type { FilesResponse, FrameInfo, TagNode, WindowMode } from "./generated/api-types";
import { RAW_FRAME_HEADERS } from "./generated/api-types";

export type {
	ErrorResponse,
	FileSummary,
	FilesResponse,
	FrameInfo,
	TagNode,
	TagValue,
	WindowMode,
	WindowPreset,
} from "./generated/api-types";

export interface EmbedRoiAnnotations {
	num_roi: number;
	roi_coords: [number, number, number, number][];
	roi_frames: number[][];
}

async function readServerError(response: Response): Promise<string | null> {
	try {
		const body = (await response.json()) as { error?: unknown };
		return typeof body.error === "string" && body.error.length > 0 ? body.error : null;
	} catch {
		return null;
	}
}

async function responseError(response: Response, fallback: string): Promise<Error> {
	const serverMessage = await readServerError(response);
	return new Error(serverMessage ?? `HTTP ${response.status}: ${fallback}`);
}

async function requestJson<T>(path: string): Promise<T> {
	const response = await fetch(path);
	if (!response.ok) {
		throw await responseError(response, `request failed: ${path}`);
	}
	return (await response.json()) as T;
}

async function sendJson<T>(path: string, method: string, body: unknown): Promise<T> {
	const response = await fetch(path, {
		method,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		throw await responseError(response, `request failed: ${path}`);
	}
	return (await response.json()) as T;
}

export function fetchFiles(): Promise<FilesResponse> {
	return requestJson<FilesResponse>("/api/files");
}

export function fetchFrameInfo(fileIndex: number): Promise<FrameInfo> {
	return requestJson<FrameInfo>(`/api/file/${fileIndex}/info`);
}

export function fetchTags(fileIndex: number): Promise<TagNode[]> {
	return requestJson<TagNode[]>(`/api/file/${fileIndex}/tags`);
}

export function fetchAnnotations(fileIndex: number): Promise<EmbedRoiAnnotations> {
	return requestJson<EmbedRoiAnnotations>(`/api/file/${fileIndex}/annotations`);
}

export function updateAnnotations(
	fileIndex: number,
	annotations: EmbedRoiAnnotations,
): Promise<EmbedRoiAnnotations> {
	return sendJson<EmbedRoiAnnotations>(`/api/file/${fileIndex}/annotations`, "PUT", annotations);
}

export function annotationsExportUrl(): string {
	return "/api/annotations/export.csv";
}

export function frameUrl(fileIndex: number, frame: number, wc?: number | null, ww?: number | null, windowMode?: WindowMode | null): string {
	const url = new URL(`/api/file/${fileIndex}/frame/${frame}`, window.location.origin);
	if (wc !== undefined && wc !== null) {
		url.searchParams.set("wc", String(wc));
	}
	if (ww !== undefined && ww !== null) {
		url.searchParams.set("ww", String(ww));
	}
	if (windowMode === 'full_dynamic') {
		url.searchParams.set("mode", "full_dynamic");
	}
	return `${url.pathname}${url.search}`;
}

export interface DisplayFrameWindowOptions {
	wc?: number | null;
	ww?: number | null;
	windowMode?: WindowMode | null;
}

export function displayFrameCacheKey(
	fileIndex: number,
	frame: number,
	options: DisplayFrameWindowOptions = {},
): string {
	const wc = options.wc === null || options.wc === undefined ? 'none' : options.wc.toFixed(4);
	const ww = options.ww === null || options.ww === undefined ? 'none' : options.ww.toFixed(4);
	const mode = options.windowMode ?? 'default';
	return `${fileIndex}:${frame}:${mode}:${wc}:${ww}`;
}

export async function fetchDisplayFrameBlob(
	fileIndex: number,
	frame: number,
	options: DisplayFrameWindowOptions = {},
	signal?: AbortSignal,
): Promise<Blob> {
	const response = await fetch(
		frameUrl(fileIndex, frame, options.wc, options.ww, options.windowMode),
		{ signal },
	);
	if (!response.ok) {
		throw await responseError(response, "display frame fetch failed");
	}
	return response.blob();
}

export interface RawFrameMetadata {
	rows: number;
	columns: number;
	bitsAllocated: number;
	pixelRepresentation: number;
	samplesPerPixel: number;
	photometricInterpretation: string;
	rescaleSlope: number;
	rescaleIntercept: number;
	defaultWc: number | null;
	defaultWw: number | null;
}

export interface RawFrame {
	metadata: RawFrameMetadata;
	buffer: ArrayBuffer;
}

function requiredHeader(headers: Headers, name: string): string {
	const value = headers.get(name);
	if (value === null || value.trim() === "") {
		throw new Error(`raw frame response missing required header ${name}`);
	}
	return value;
}

function parseRequiredIntHeader(headers: Headers, name: string): number {
	const value = Number.parseInt(requiredHeader(headers, name), 10);
	if (!Number.isFinite(value)) {
		throw new Error(`raw frame response has invalid integer header ${name}`);
	}
	return value;
}

function parseRequiredFloatHeader(headers: Headers, name: string): number {
	const value = Number.parseFloat(requiredHeader(headers, name));
	if (!Number.isFinite(value)) {
		throw new Error(`raw frame response has invalid numeric header ${name}`);
	}
	return value;
}

function parseOptionalFloatHeader(headers: Headers, name: string): number | null {
	const raw = headers.get(name);
	if (raw === null || raw.trim() === "") {
		return null;
	}
	const value = Number.parseFloat(raw);
	if (!Number.isFinite(value)) {
		throw new Error(`raw frame response has invalid numeric header ${name}`);
	}
	return value;
}

export function parseRawFrameMetadata(headers: Headers): RawFrameMetadata {
	return {
		rows: parseRequiredIntHeader(headers, RAW_FRAME_HEADERS.rows),
		columns: parseRequiredIntHeader(headers, RAW_FRAME_HEADERS.columns),
		bitsAllocated: parseRequiredIntHeader(headers, RAW_FRAME_HEADERS.bitsAllocated),
		pixelRepresentation: parseRequiredIntHeader(headers, RAW_FRAME_HEADERS.pixelRepresentation),
		samplesPerPixel: parseRequiredIntHeader(headers, RAW_FRAME_HEADERS.samplesPerPixel),
		photometricInterpretation: requiredHeader(headers, RAW_FRAME_HEADERS.photometricInterpretation),
		rescaleSlope: parseRequiredFloatHeader(headers, RAW_FRAME_HEADERS.rescaleSlope),
		rescaleIntercept: parseRequiredFloatHeader(headers, RAW_FRAME_HEADERS.rescaleIntercept),
		defaultWc: parseOptionalFloatHeader(headers, RAW_FRAME_HEADERS.defaultWc),
		defaultWw: parseOptionalFloatHeader(headers, RAW_FRAME_HEADERS.defaultWw),
	};
}

export async function fetchRawFrame(
	fileIndex: number,
	frame: number,
	signal?: AbortSignal,
): Promise<RawFrame> {
	const response = await fetch(`/api/file/${fileIndex}/frame/${frame}/raw`, { signal });
	if (!response.ok) {
		throw await responseError(response, "raw frame fetch failed");
	}
	const buffer = await response.arrayBuffer();
	return { metadata: parseRawFrameMetadata(response.headers), buffer };
}
