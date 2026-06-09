<script lang="ts">
	import type { FileSummary } from "../api";

	let {
		files,
		openTabs,
		activeFileIndex,
		onactivate,
		onclose,
	}: {
		files: FileSummary[];
		openTabs: number[];
		activeFileIndex: number | null;
		onactivate: (index: number) => void;
		onclose: (index: number) => void;
	} = $props();

	function fileFor(index: number): FileSummary | undefined {
		return files.find((file) => file.index === index);
	}

	function basename(path: string): string {
		return path.split(/[\\/]/).pop() || path;
	}

	function tabLabel(file: FileSummary): string {
		const instance = file.instance_number.trim();
		const base = basename(file.path);
		return instance ? `#${instance} ${base}` : base;
	}

	function closeTab(event: MouseEvent, index: number) {
		event.stopPropagation();
		onclose(index);
	}
</script>

<nav class="open-tabs" aria-label="Open images">
	{#if openTabs.length === 0}
		<div class="empty-tabs">No open images</div>
	{:else}
		{#each openTabs as fileIndex}
			{@const file = fileFor(fileIndex)}
			{#if file}
				<div
					class="tab"
					class:active={file.index === activeFileIndex}
					title={file.path}
				>
					<button
						type="button"
						class="tab-main"
						onclick={() => onactivate(file.index)}
					>
						<span class="tab-label">{tabLabel(file)}</span>
						<span class="tab-detail">{file.has_pixels ? `${file.frame_count}f` : "tags"}</span>
					</button>
					<button
						type="button"
						class="close"
						onclick={(event) => closeTab(event, file.index)}
						aria-label={`Close ${tabLabel(file)}`}
					>
						x
					</button>
				</div>
			{/if}
		{/each}
	{/if}
</nav>

<style>
	.open-tabs {
		display: flex;
		align-items: end;
		gap: 0.15rem;
		min-width: 0;
		overflow-x: auto;
		padding-top: 0.3rem;
	}

	.empty-tabs {
		color: #909090;
		font-size: 0.84rem;
		padding: 0.35rem 0.25rem;
		white-space: nowrap;
	}

	.tab {
		display: grid;
		grid-template-columns: minmax(5rem, 1fr) auto;
		align-items: center;
		min-width: 9rem;
		max-width: 16rem;
		height: 2rem;
		border: 1px solid #333;
		border-bottom-color: #242424;
		border-radius: 6px 6px 0 0;
		background: #1d1d1d;
		color: #cfcfcf;
		overflow: hidden;
	}

	.tab:hover {
		background: #2a2a2a;
		color: #fff;
	}

	.tab.active {
		background: #242424;
		border-color: #4a9eff;
		border-bottom-color: #242424;
		color: #fff;
	}

	.tab-main {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 0.4rem;
		min-width: 0;
		height: 100%;
		border: 0;
		background: transparent;
		color: inherit;
		cursor: pointer;
		padding: 0 0.35rem 0 0.65rem;
	}

	.tab-label {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-align: left;
		font-size: 0.82rem;
	}

	.tab-detail {
		color: #9a9a9a;
		font-size: 0.72rem;
	}

	.close {
		display: grid;
		place-items: center;
		width: 1.25rem;
		height: 1.25rem;
		border: 0;
		border-radius: 4px;
		background: transparent;
		color: #aaa;
		cursor: pointer;
	}

	.close:hover {
		background: #3a3a3a;
		color: #fff;
	}

	.tab-main:focus-visible,
	.close:focus-visible {
		outline: 2px solid #4a9eff;
		outline-offset: -2px;
	}
</style>
