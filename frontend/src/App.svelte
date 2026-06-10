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
	let lastAppliedPresetId = 'default';
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
		};
	}

	function saveActiveTabState() {
		if (activeFileIndex === null) return;
		openTabs = openTabs.map((tab) => tab.fileIndex === activeFileIndex
			? {
				...tab,
				currentFrame,
			}
			: tab);
	}

	function loadTabState(tab: OpenTabState | null) {
		if (!tab) {
			activeFileIndex = null;
			currentFrame = 0;
			return;
		}

		activeFileIndex = tab.fileIndex;
		currentFrame = tab.currentFrame;
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

	function applyWindowPreset(presetId: string) {
		const preset = WL_PRESETS.find(p => p.id === presetId);
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
	}

	$effect(() => {
		const presetId = selectedPresetId;
		if (presetId === lastAppliedPresetId) return;
		lastAppliedPresetId = presetId;
		applyWindowPreset(presetId);
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
	:global(:root) {
		--font-ui: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
		--font-mono: "SF Mono", "JetBrains Mono", ui-monospace, monospace;
		--surface-root: #151516;
		--surface-viewport: #080809;
		--surface-chrome: #202124;
		--surface-panel: #252629;
		--surface-panel-alt: #2b2c30;
		--surface-control: #303136;
		--surface-control-hover: #393a40;
		--surface-control-active: #e7e7ea;
		--border-subtle: rgba(255, 255, 255, 0.08);
		--border-strong: rgba(255, 255, 255, 0.14);
		--text-primary: #f2f2f3;
		--text-secondary: #c7c7cc;
		--text-muted: #8e8e93;
		--text-inverse: #1d1d1f;
		--accent: #0a84ff;
		--accent-soft: rgba(10, 132, 255, 0.16);
		--danger: #ff6961;
		--radius-control: 7px;
		--radius-panel: 8px;
		--control-height: 1.75rem;
		--shadow-hud: 0 12px 30px rgba(0, 0, 0, 0.28);
		--focus-ring: 0 0 0 2px rgba(10, 132, 255, 0.48);
		color-scheme: dark;
	}

	:global(*) {
		box-sizing: border-box;
	}

	:global(html),
	:global(body) {
		margin: 0;
		padding: 0;
		width: 100%;
		height: 100%;
		overflow: hidden;
		font-family: var(--font-ui);
		background: var(--surface-root);
		color: var(--text-primary);
		-webkit-font-smoothing: antialiased;
		text-rendering: optimizeLegibility;
	}

	.layout {
		display: grid;
		grid-template-rows: auto auto 1fr auto;
		height: 100vh;
		width: 100%;
		overflow: hidden;
		background: var(--surface-root);
	}

	.topbar {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		align-items: end;
		gap: 0.8rem;
		min-height: 2.6rem;
		background: var(--surface-chrome);
		padding: 0 0.7rem;
		border-bottom: 1px solid var(--border-subtle);
	}

	.title {
		align-self: center;
		color: var(--text-secondary);
		font-size: 0.82rem;
		font-weight: 650;
		letter-spacing: 0.01em;
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
		background: var(--surface-viewport);
	}

	.empty-viewer,
	.tag-empty {
		display: grid;
		place-content: center;
		color: var(--text-muted);
	}

	.empty-viewer {
		min-height: 0;
		background: var(--surface-viewport);
	}

	.tag-empty {
		height: 100%;
		font-size: 0.85rem;
	}

	.tag-panel-shell {
		position: relative;
		background: var(--surface-panel);
		border-left: 1px solid var(--border-subtle);
		min-width: 0;
		min-height: 0;
		overflow: hidden;
	}

	.tag-panel-shell.collapsed {
		background: var(--surface-chrome);
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
		background: var(--border-subtle);
		transform: translateX(-50%);
	}

	.sidebar-handle.dragging::after {
		background: var(--accent);
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
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
		background: var(--surface-control);
		color: var(--text-secondary);
		cursor: pointer;
		z-index: 6;
	}

	.panel-toggle:hover {
		background: var(--surface-control-hover);
		color: var(--text-primary);
	}

	.panel-toggle:focus-visible {
		outline: none;
		box-shadow: var(--focus-ring);
	}

	.loading,
	.error {
		display: grid;
		place-content: center;
		height: 100vh;
		background: var(--surface-root);
		color: var(--text-secondary);
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
