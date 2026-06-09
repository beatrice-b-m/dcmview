<script lang="ts">
	import { onMount } from "svelte";
	import { annotationsExportUrl, fetchFiles, type FilesResponse, type WindowMode } from "./api";
	import FileNavigator from "./lib/FileNavigator.svelte";
	import FrameSlider from "./lib/FrameSlider.svelte";
	import ImageViewport from "./lib/ImageViewport.svelte";
	import OpenImageTabs from "./lib/OpenImageTabs.svelte";
	import StatusBar from "./lib/StatusBar.svelte";
	import TagPanel from "./lib/TagPanel.svelte";
	import ViewerToolbar from "./lib/ViewerToolbar.svelte";
	import { DEFAULT_ORIENTATION, WL_PRESETS, type ActiveTool, type ImageOrientation } from "./lib/viewerTools";

	const TAG_PANEL_DEFAULT_WIDTH_PX = 360;
	const TAG_PANEL_MIN_WIDTH_PX = 260;
	const TAG_PANEL_MAX_WIDTH_PX = 720;
	const TAG_PANEL_COLLAPSED_WIDTH_PX = 44;
	const FILE_NAV_WIDTH_PX = 300;
	const FILE_NAV_COLLAPSED_WIDTH_PX = 44;

	type SidebarResizeState = {
		pointerId: number;
		startX: number;
		startWidth: number;
	};

	type OpenTabState = {
		fileIndex: number;
		currentFrame: number;
		windowCenter: number | null;
		windowWidth: number | null;
		windowMode: WindowMode;
		selectedPresetId: string;
	};

	let filesResponse = $state<FilesResponse | null>(null);
	let loadError = $state<string | null>(null);

	let openTabs = $state<OpenTabState[]>([]);
	let activeFileIndex = $state<number | null>(null);
	let currentFrame = $state(0);
	let windowCenter = $state<number | null>(null);
	let windowWidth = $state<number | null>(null);
	let activeTool = $state<ActiveTool>('pan');
	let windowMode = $state<WindowMode>('default');
	let selectedPresetId = $state('default');
	let resetCount = $state(0);
	let orientationByFile = $state<Record<number, ImageOrientation>>({});
	let fileNavigatorCollapsed = $state(false);
	let tagPanelWidthPx = $state(clampTagPanelWidth(TAG_PANEL_DEFAULT_WIDTH_PX));
	let tagPanelCollapsed = $state(false);
	let sidebarResizeState = $state<SidebarResizeState | null>(null);

	const activeOrientation = $derived(activeFileIndex === null ? DEFAULT_ORIENTATION : orientationByFile[activeFileIndex] ?? DEFAULT_ORIENTATION);
	const openTabIndexes = $derived(openTabs.map((tab) => tab.fileIndex));
	const fileNavigatorWidthPx = $derived(fileNavigatorCollapsed ? FILE_NAV_COLLAPSED_WIDTH_PX : FILE_NAV_WIDTH_PX);
	const tagPanelWidth = $derived(tagPanelCollapsed ? TAG_PANEL_COLLAPSED_WIDTH_PX : tagPanelWidthPx);

	function clampTagPanelWidth(width: number): number {
		return Math.min(TAG_PANEL_MAX_WIDTH_PX, Math.max(TAG_PANEL_MIN_WIDTH_PX, width));
	}

	function defaultTabState(fileIndex: number): OpenTabState {
		return {
			fileIndex,
			currentFrame: 0,
			windowCenter: null,
			windowWidth: null,
			windowMode: 'default',
			selectedPresetId: 'default',
		};
	}

	function saveActiveTabState() {
		if (activeFileIndex === null) return;
		openTabs = openTabs.map((tab) => tab.fileIndex === activeFileIndex
			? {
				...tab,
				currentFrame,
				windowCenter,
				windowWidth,
				windowMode,
				selectedPresetId,
			}
			: tab);
	}

	function loadTabState(tab: OpenTabState | null) {
		if (!tab) {
			activeFileIndex = null;
			currentFrame = 0;
			windowCenter = null;
			windowWidth = null;
			windowMode = 'default';
			selectedPresetId = 'default';
			return;
		}

		activeFileIndex = tab.fileIndex;
		currentFrame = tab.currentFrame;
		windowCenter = tab.windowCenter;
		windowWidth = tab.windowWidth;
		windowMode = tab.windowMode;
		selectedPresetId = tab.selectedPresetId;
	}

	function activateOpenTab(fileIndex: number) {
		const target = openTabs.find((tab) => tab.fileIndex === fileIndex);
		if (!target) return;
		if (activeFileIndex !== fileIndex) {
			saveActiveTabState();
		}
		loadTabState(target);
	}

	function openOrActivateFile(fileIndex: number) {
		const existing = openTabs.find((tab) => tab.fileIndex === fileIndex);
		if (existing) {
			activateOpenTab(fileIndex);
			return;
		}

		saveActiveTabState();
		const next = defaultTabState(fileIndex);
		openTabs = [...openTabs, next];
		loadTabState(next);
	}

	function closeOpenTab(fileIndex: number) {
		const closingIndex = openTabs.findIndex((tab) => tab.fileIndex === fileIndex);
		if (closingIndex === -1) return;

		const wasActive = activeFileIndex === fileIndex;
		const remaining = openTabs.filter((tab) => tab.fileIndex !== fileIndex);
		openTabs = remaining;

		if (!wasActive) return;

		const replacement = remaining[Math.min(closingIndex, remaining.length - 1)] ?? null;
		loadTabState(replacement);
	}

	function resetViewport() {
		if (activeFileIndex === null) return;
		windowCenter = null;
		windowWidth = null;
		windowMode = 'default';
		selectedPresetId = 'default';
		resetCount += 1;
		if (orientationByFile[activeFileIndex]) {
			orientationByFile = { ...orientationByFile, [activeFileIndex]: DEFAULT_ORIENTATION };
		}
	}

	function getOrientation(index: number): ImageOrientation {
		return orientationByFile[index] ?? DEFAULT_ORIENTATION;
	}

	function applyFlipH() {
		if (activeFileIndex === null) return;
		const cur = getOrientation(activeFileIndex);
		orientationByFile = { ...orientationByFile, [activeFileIndex]: { ...cur, flipH: !cur.flipH } };
	}

	function applyFlipV() {
		if (activeFileIndex === null) return;
		const cur = getOrientation(activeFileIndex);
		orientationByFile = { ...orientationByFile, [activeFileIndex]: { ...cur, flipV: !cur.flipV } };
	}

	function applyRotateCW() {
		if (activeFileIndex === null) return;
		const cur = getOrientation(activeFileIndex);
		const r = ((cur.rotation + 90) % 360) as 0 | 90 | 180 | 270;
		orientationByFile = { ...orientationByFile, [activeFileIndex]: { ...cur, rotation: r } };
	}

	function applyRotateCCW() {
		if (activeFileIndex === null) return;
		const cur = getOrientation(activeFileIndex);
		const r = ((cur.rotation + 270) % 360) as 0 | 90 | 180 | 270;
		orientationByFile = { ...orientationByFile, [activeFileIndex]: { ...cur, rotation: r } };
	}

	function exportAnnotations() {
		const link = document.createElement('a');
		link.href = annotationsExportUrl();
		link.download = 'dcmview-annotations.csv';
		document.body.appendChild(link);
		link.click();
		link.remove();
	}

	function toggleTagPanel() {
		tagPanelCollapsed = !tagPanelCollapsed;
	}

	function startTagPanelResize(event: PointerEvent) {
		if (tagPanelCollapsed || event.button !== 0) {
			return;
		}

		const handle = event.currentTarget as HTMLElement;
		handle.setPointerCapture(event.pointerId);
		sidebarResizeState = {
			pointerId: event.pointerId,
			startX: event.clientX,
			startWidth: tagPanelWidthPx,
		};
		event.preventDefault();
	}

	function moveTagPanelResize(event: PointerEvent) {
		if (!sidebarResizeState || sidebarResizeState.pointerId !== event.pointerId) {
			return;
		}

		const delta = sidebarResizeState.startX - event.clientX;
		tagPanelWidthPx = clampTagPanelWidth(sidebarResizeState.startWidth + delta);
	}

	function endTagPanelResize(event: PointerEvent) {
		const handle = event.currentTarget as HTMLElement;
		if (handle.hasPointerCapture(event.pointerId)) {
			handle.releasePointerCapture(event.pointerId);
		}

		if (sidebarResizeState?.pointerId === event.pointerId) {
			sidebarResizeState = null;
		}
	}

	function cancelTagPanelResize() {
		sidebarResizeState = null;
	}

	$effect(() => {
		if (activeFileIndex === null) return;
		const preset = WL_PRESETS.find(p => p.id === selectedPresetId);
		if (!preset) return;
		if (preset.wc !== undefined && preset.ww !== undefined) {
			windowCenter = preset.wc;
			windowWidth = preset.ww;
			windowMode = 'default';
		} else {
			windowCenter = null;
			windowWidth = null;
			windowMode = preset.mode ?? 'default';
		}
	});

	$effect(() => {
		const handleKey = (event: KeyboardEvent) => {
			const target = event.target as HTMLElement | null;
			if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
			switch (event.key.toLowerCase()) {
				case 'w': activeTool = 'window_level'; break;
				case 'p': activeTool = 'pan'; break;
				case 'z': activeTool = 'zoom'; break;
				case 's': activeTool = 'scroll'; break;
				case 'r': activeTool = 'annotate_rect'; break;
			}
		};
		window.addEventListener('keydown', handleKey);
		return () => window.removeEventListener('keydown', handleKey);
	});

	onMount(async () => {
		try {
			const response = await fetchFiles();
			filesResponse = response;
			if (response.files.length > 0) {
				openOrActivateFile(response.files[0].index);
			}
		} catch (error) {
			loadError = error instanceof Error ? error.message : String(error);
		}
	});
</script>

{#if loadError}
	<main class="error">{loadError}</main>
{:else if !filesResponse}
	<main class="loading">Loading dcmview…</main>
{:else}
	<main
		class="layout"
		style={`--file-nav-width:${fileNavigatorWidthPx}px; --tag-panel-width:${tagPanelWidth}px;`}
	>
		<header class="topbar">
			<div class="title">dcmview</div>
			<OpenImageTabs
				files={filesResponse.files}
				openTabs={openTabIndexes}
				activeFileIndex={activeFileIndex}
				onactivate={activateOpenTab}
				onclose={closeOpenTab}
			/>
		</header>
		<ViewerToolbar
			bind:activeTool
			bind:selectedPresetId
			onreset={resetViewport}
			onflipH={applyFlipH}
			onflipV={applyFlipV}
			onrotateCW={applyRotateCW}
			onrotateCCW={applyRotateCCW}
			onexportAnnotations={exportAnnotations}
		/>
		<section class="workspace">
			<FileNavigator
				files={filesResponse.files}
				activeFileIndex={activeFileIndex}
				bind:collapsed={fileNavigatorCollapsed}
				onopenfile={openOrActivateFile}
			/>
			<section class="viewer-column">
				{#if activeFileIndex === null}
					<div class="empty-viewer">Open a file from the sidebar</div>
				{:else}
					<ImageViewport
						files={filesResponse.files}
						activeFileIndex={activeFileIndex}
						bind:currentFrame
						bind:windowCenter
						bind:windowWidth
						activeTool={activeTool}
						windowMode={windowMode}
						resetCount={resetCount}
						selectedPresetId={selectedPresetId}
						orientation={activeOrientation}
						onreset={resetViewport}
					/>
					<FrameSlider
						files={filesResponse.files}
						activeFileIndex={activeFileIndex}
						bind:currentFrame
					/>
				{/if}
			</section>
			<aside class="tag-panel-shell" class:collapsed={tagPanelCollapsed}>
				<div
					class="sidebar-handle"
					class:dragging={sidebarResizeState !== null}
					class:disabled={tagPanelCollapsed}
					role="separator"
					aria-label="Resize DICOM tag panel"
					aria-orientation="vertical"
					aria-valuemin={TAG_PANEL_MIN_WIDTH_PX}
					aria-valuemax={TAG_PANEL_MAX_WIDTH_PX}
					aria-valuenow={tagPanelWidthPx}
					onpointerdown={startTagPanelResize}
					onpointermove={moveTagPanelResize}
					onpointerup={endTagPanelResize}
					onpointercancel={cancelTagPanelResize}
				></div>
				<button
					type="button"
					class="panel-toggle"
					onclick={toggleTagPanel}
					aria-label={tagPanelCollapsed ? "Expand DICOM tag panel" : "Collapse DICOM tag panel"}
					aria-expanded={!tagPanelCollapsed}
				>
					{tagPanelCollapsed ? "◀" : "▶"}
				</button>
				{#if !tagPanelCollapsed}
					{#if activeFileIndex === null}
						<div class="tag-empty">No file selected</div>
					{:else}
						<TagPanel files={filesResponse.files} activeFileIndex={activeFileIndex} />
					{/if}
				{/if}
			</aside>
		</section>
		<StatusBar
			serverStartMs={filesResponse.server_start_ms}
			fileCount={filesResponse.files.length}
			tunnelled={filesResponse.tunnelled}
			tunnelHost={filesResponse.tunnel_host}
		/>
	</main>
{/if}

<style>
	:global(html),
	:global(body) {
		margin: 0;
		padding: 0;
		width: 100%;
		height: 100%;
		overflow: hidden;
		font-family: system-ui, sans-serif;
		background: #1a1a1a;
		color: #e0e0e0;
	}

	.layout {
		display: grid;
		grid-template-rows: auto auto 1fr auto;
		height: 100vh;
		width: 100%;
		overflow: hidden;
	}

	.topbar {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		align-items: end;
		gap: 1rem;
		min-height: 2.8rem;
		background: #242424;
		padding: 0 0.75rem;
		border-bottom: 1px solid #333;
	}

	.title {
		align-self: center;
		font-weight: 700;
		white-space: nowrap;
	}

	.workspace {
		display: grid;
		grid-template-columns: var(--file-nav-width) minmax(0, 1fr) var(--tag-panel-width);
		grid-template-rows: 1fr;
		min-height: 0;
	}

	.viewer-column {
		display: grid;
		grid-template-rows: minmax(0, 1fr) auto;
		min-width: 0;
		min-height: 0;
		background: #111;
	}

	.empty-viewer,
	.tag-empty {
		display: grid;
		place-content: center;
		color: #8f8f8f;
	}

	.empty-viewer {
		min-height: 0;
		background: #111;
	}

	.tag-empty {
		height: 100%;
		font-size: 0.85rem;
	}

	.tag-panel-shell {
		position: relative;
		background: #242424;
		min-width: 0;
		min-height: 0;
		overflow: hidden;
	}

	.tag-panel-shell.collapsed {
		background: #202020;
	}

	.sidebar-handle {
		position: absolute;
		left: 0;
		top: 0;
		bottom: 0;
		width: 10px;
		transform: translateX(-50%);
		cursor: col-resize;
		touch-action: none;
		z-index: 5;
	}

	.sidebar-handle::after {
		content: "";
		position: absolute;
		left: 50%;
		top: 0;
		bottom: 0;
		width: 1px;
		background: #3a3a3a;
		transform: translateX(-50%);
	}

	.sidebar-handle.dragging::after {
		background: #4a9eff;
	}

	.sidebar-handle.disabled {
		cursor: default;
		pointer-events: none;
	}

	.panel-toggle {
		position: absolute;
		top: 0.6rem;
		right: 0.45rem;
		display: grid;
		place-items: center;
		width: 1.5rem;
		height: 1.5rem;
		border: 1px solid #3b3b3b;
		border-radius: 4px;
		background: #1b1b1b;
		color: #e0e0e0;
		cursor: pointer;
		z-index: 6;
	}

	.panel-toggle:hover {
		border-color: #4a9eff;
		color: #4a9eff;
	}

	.loading,
	.error {
		display: grid;
		place-content: center;
		height: 100vh;
	}

	@media (max-width: 980px) {
		.workspace {
			grid-template-columns: var(--file-nav-width) minmax(0, 1fr);
		}

		.tag-panel-shell {
			display: none;
		}
	}

	@media (max-width: 520px) {
		.topbar {
			grid-template-columns: minmax(0, 1fr);
			gap: 0.25rem;
			padding-top: 0.35rem;
		}

		.title {
			display: none;
		}

		.workspace {
			grid-template-columns: minmax(0, 1fr);
		}

		.workspace :global(.navigator) {
			display: none;
		}
	}
</style>
