export type WindowMode = 'default' | 'full_dynamic';

export interface WindowPreset {
	center: number;
	width: number;
}

export interface FileSummary {
	index: number;
	path: string;
	label: string;
	has_pixels: boolean;
	frame_count: number;
	rows: number;
	columns: number;
	transfer_syntax_uid: string;
	default_window: WindowPreset | null;
}

export interface FilesResponse {
	files: FileSummary[];
	tunnelled: boolean;
	tunnel_host: string | null;
	server_start_ms: number;
}

export interface FrameInfo {
	frame_count: number;
	rows: number;
	columns: number;
	transfer_syntax: string;
	has_pixels: boolean;
	default_window: WindowPreset | null;
}

export interface EmbedRoiAnnotations {
	num_roi: number;
	roi_coords: [number, number, number, number][];
	roi_frames: number[][];
}

export type TagValue =
	| { type: "string"; value: string }
	| { type: "number"; value: number }
	| { type: "numbers"; value: number[]; truncated?: boolean; total?: number }
	| { type: "binary"; length: number }
	| { type: "sequence"; items: TagNode[][]; truncated?: boolean; total?: number }
	| { type: "error"; message: string };

export interface TagNode {
	tag: string;
	vr: string;
	keyword: string;
	value: TagValue;
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
	const h = (name: string) => response.headers.get(name);
	const metadata: RawFrameMetadata = {
		rows: parseInt(h('X-Frame-Rows') ?? '0', 10),
		columns: parseInt(h('X-Frame-Columns') ?? '0', 10),
		bitsAllocated: parseInt(h('X-Frame-Bits-Allocated') ?? '8', 10),
		pixelRepresentation: parseInt(h('X-Frame-Pixel-Representation') ?? '0', 10),
		samplesPerPixel: parseInt(h('X-Frame-Samples-Per-Pixel') ?? '1', 10),
		photometricInterpretation: h('X-Frame-Photometric-Interpretation') ?? 'MONOCHROME2',
		rescaleSlope: parseFloat(h('X-Frame-Rescale-Slope') ?? '1'),
		rescaleIntercept: parseFloat(h('X-Frame-Rescale-Intercept') ?? '0'),
		defaultWc: h('X-Frame-Default-Wc') !== null ? parseFloat(h('X-Frame-Default-Wc')!) : null,
		defaultWw: h('X-Frame-Default-Ww') !== null ? parseFloat(h('X-Frame-Default-Ww')!) : null,
	};
	return { metadata, buffer };
}
