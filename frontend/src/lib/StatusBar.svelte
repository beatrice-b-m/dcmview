<script lang="ts">
	let {
		serverStartMs,
		fileCount,
		tunnelled,
		tunnelHost,
	}: {
		serverStartMs: number;
		fileCount: number;
		tunnelled: boolean;
		tunnelHost: string | null;
	} = $props();

	let nowMs = $state(Date.now());
	$effect(() => {
		const timer = setInterval(() => {
			nowMs = Date.now();
		}, 1000);
		return () => clearInterval(timer);
	});

	const uptime = $derived.by(() => {
		const elapsedSeconds = Math.max(0, Math.floor((nowMs - serverStartMs) / 1000));
		const hours = String(Math.floor(elapsedSeconds / 3600)).padStart(2, "0");
		const minutes = String(Math.floor((elapsedSeconds % 3600) / 60)).padStart(2, "0");
		const seconds = String(elapsedSeconds % 60).padStart(2, "0");
		return `${hours}:${minutes}:${seconds}`;
	});
</script>

<footer class="status">
	<span>{window.location.origin}</span>
	<span>{fileCount} files loaded</span>
	<span>
		uptime {uptime}
		{#if tunnelled}
			· tunnelled{#if tunnelHost} from {tunnelHost}{/if}
		{/if}
	</span>
</footer>

<style>
	.status {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		font-size: 0.78rem;
		padding: 0.38rem 0.85rem;
		background: var(--surface-chrome);
		border-top: 1px solid var(--border-subtle);
		color: var(--text-muted);
		min-width: 0;
	}

	.status span {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
