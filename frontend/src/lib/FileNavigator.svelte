<script lang="ts">
	import type { FileSummary } from "../api";

	type NavFile = {
		file: FileSummary;
		label: string;
		detail: string;
	};

	type NavSeries = {
		key: string;
		label: string;
		detail: string;
		files: NavFile[];
	};

	type NavStudy = {
		key: string;
		label: string;
		detail: string;
		series: NavSeries[];
	};

	type NavPatient = {
		key: string;
		label: string;
		detail: string;
		studies: NavStudy[];
	};

	let {
		files,
		activeFileIndex,
		collapsed = $bindable(),
		onopenfile,
	}: {
		files: FileSummary[];
		activeFileIndex: number | null;
		collapsed: boolean;
		onopenfile: (index: number) => void;
	} = $props();

	let collapsedNodes = $state<Record<string, boolean>>({});

	function clean(value: string | null | undefined): string {
		return (value ?? "").trim();
	}

	function basename(path: string): string {
		return path.split(/[\\/]/).pop() || path;
	}

	function formatPersonName(value: string): string {
		return value.replace(/\^/g, " ").replace(/\s+/g, " ").trim();
	}

	function formatDate(value: string): string {
		const trimmed = clean(value);
		if (!/^\d{8}$/.test(trimmed)) return trimmed;
		return `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6, 8)}`;
	}

	function shortUid(value: string): string {
		const trimmed = clean(value);
		if (trimmed.length <= 18) return trimmed;
		return `...${trimmed.slice(-15)}`;
	}

	function nodeKey(prefix: string, fallback: string, parts: string[]): string {
		const value = parts.map(clean).find(Boolean) ?? fallback;
		return `${prefix}:${value}`;
	}

	function isCollapsed(key: string): boolean {
		return collapsedNodes[key] ?? false;
	}

	function toggleNode(key: string) {
		collapsedNodes = { ...collapsedNodes, [key]: !isCollapsed(key) };
	}

	function patientLabel(file: FileSummary): string {
		return formatPersonName(clean(file.patient_name)) || clean(file.patient_id) || "Unknown Patient";
	}

	function patientDetail(file: FileSummary): string {
		const id = clean(file.patient_id);
		return id && id !== patientLabel(file) ? id : "";
	}

	function studyLabel(file: FileSummary): string {
		return clean(file.study_description)
			|| formatDate(file.study_date)
			|| shortUid(file.study_instance_uid)
			|| "Unknown Study";
	}

	function studyDetail(file: FileSummary): string {
		const date = formatDate(file.study_date);
		const uid = shortUid(file.study_instance_uid);
		return [date && date !== studyLabel(file) ? date : "", uid && uid !== studyLabel(file) ? uid : ""]
			.filter(Boolean)
			.join(" · ");
	}

	function seriesLabel(file: FileSummary): string {
		const description = clean(file.series_description);
		const number = clean(file.series_number);
		const modality = clean(file.modality);
		if (description && number) return `${number} · ${description}`;
		return description || [modality, number ? `Series ${number}` : ""].filter(Boolean).join(" · ")
			|| shortUid(file.series_instance_uid)
			|| "Unknown Series";
	}

	function seriesDetail(file: FileSummary): string {
		const uid = shortUid(file.series_instance_uid);
		return uid && uid !== seriesLabel(file) ? uid : "";
	}

	function fileLabel(file: FileSummary): string {
		const instance = clean(file.instance_number);
		const name = basename(file.path);
		return instance ? `#${instance} ${name}` : name;
	}

	function fileDetail(file: FileSummary): string {
		if (!file.has_pixels) return "no pixels";
		const dimensions = file.rows > 0 && file.columns > 0 ? `${file.columns}x${file.rows}` : "";
		const frames = file.frame_count > 1 ? `${file.frame_count} frames` : "1 frame";
		return [dimensions, frames].filter(Boolean).join(" · ");
	}

	const tree = $derived.by(() => {
		const patients = new Map<string, NavPatient>();

		for (const file of [...files].sort((left, right) => left.index - right.index)) {
			const patientKey = nodeKey("patient", `file-${file.index}`, [file.patient_id, file.patient_name]);
			let patient = patients.get(patientKey);
			if (!patient) {
				patient = {
					key: patientKey,
					label: patientLabel(file),
					detail: patientDetail(file),
					studies: [],
				};
				patients.set(patientKey, patient);
			}

			const studyKey = `${patientKey}/${nodeKey("study", `file-${file.index}`, [file.study_instance_uid, file.study_description, file.study_date])}`;
			let study = patient.studies.find((item) => item.key === studyKey);
			if (!study) {
				study = {
					key: studyKey,
					label: studyLabel(file),
					detail: studyDetail(file),
					series: [],
				};
				patient.studies.push(study);
			}

			const seriesKey = `${studyKey}/${nodeKey("series", `file-${file.index}`, [file.series_instance_uid, file.series_number, file.series_description])}`;
			let series = study.series.find((item) => item.key === seriesKey);
			if (!series) {
				series = {
					key: seriesKey,
					label: seriesLabel(file),
					detail: seriesDetail(file),
					files: [],
				};
				study.series.push(series);
			}

			series.files.push({
				file,
				label: fileLabel(file),
				detail: fileDetail(file),
			});
		}

		return Array.from(patients.values());
	});
</script>

<aside class="navigator" class:collapsed>
	<div class="navigator-header">
		{#if !collapsed}
			<span>Files</span>
		{/if}
		<button
			type="button"
			class="collapse-button"
			onclick={() => collapsed = !collapsed}
			aria-label={collapsed ? "Expand file navigator" : "Collapse file navigator"}
			aria-expanded={!collapsed}
		>
			{collapsed ? "▶" : "◀"}
		</button>
	</div>

	{#if !collapsed}
		<div class="tree" role="tree" aria-label="DICOM file hierarchy">
			{#each tree as patient}
				<section class="tree-group">
					<button type="button" class="tree-header depth-0" onclick={() => toggleNode(patient.key)}>
						<span class="twisty">{isCollapsed(patient.key) ? "▶" : "▼"}</span>
						<span class="node-text">
							<span class="node-label">{patient.label}</span>
							{#if patient.detail}<span class="node-detail">{patient.detail}</span>{/if}
						</span>
					</button>
					{#if !isCollapsed(patient.key)}
						{#each patient.studies as study}
							<button type="button" class="tree-header depth-1" onclick={() => toggleNode(study.key)}>
								<span class="twisty">{isCollapsed(study.key) ? "▶" : "▼"}</span>
								<span class="node-text">
									<span class="node-label">{study.label}</span>
									{#if study.detail}<span class="node-detail">{study.detail}</span>{/if}
								</span>
							</button>
							{#if !isCollapsed(study.key)}
								{#each study.series as series}
									<button type="button" class="tree-header depth-2" onclick={() => toggleNode(series.key)}>
										<span class="twisty">{isCollapsed(series.key) ? "▶" : "▼"}</span>
										<span class="node-text">
											<span class="node-label">{series.label}</span>
											{#if series.detail}<span class="node-detail">{series.detail}</span>{/if}
										</span>
									</button>
									{#if !isCollapsed(series.key)}
										{#each series.files as item}
											<button
												type="button"
												class="file-row depth-3"
												class:active={item.file.index === activeFileIndex}
												onclick={() => onopenfile(item.file.index)}
												title={item.file.path}
											>
												<span class="file-label">{item.label}</span>
												<span class="file-detail">{item.detail}</span>
											</button>
										{/each}
									{/if}
								{/each}
							{/if}
						{/each}
					{/if}
				</section>
			{/each}
		</div>
	{/if}
</aside>

<style>
	.navigator {
		display: grid;
		grid-template-rows: auto 1fr;
		min-width: 0;
		min-height: 0;
		background: #202020;
		border-right: 1px solid #333;
		overflow: hidden;
	}

	.navigator.collapsed {
		background: #242424;
	}

	.navigator-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		min-height: 2.5rem;
		padding: 0.55rem 0.65rem;
		border-bottom: 1px solid #333;
		font-weight: 700;
	}

	.collapse-button {
		display: grid;
		place-items: center;
		width: 1.6rem;
		height: 1.6rem;
		border: 1px solid #3a3a3a;
		border-radius: 4px;
		background: #1b1b1b;
		color: #e0e0e0;
		cursor: pointer;
	}

	.collapse-button:hover {
		border-color: #4a9eff;
		color: #4a9eff;
	}

	.collapse-button:focus-visible,
	.tree-header:focus-visible,
	.file-row:focus-visible {
		outline: 2px solid #4a9eff;
		outline-offset: -2px;
	}

	.tree {
		overflow: auto;
		padding: 0.35rem 0;
	}

	.tree-group,
	.tree-header,
	.file-row {
		min-width: 0;
	}

	.tree-header,
	.file-row {
		width: 100%;
		border: 0;
		background: transparent;
		color: #d7d7d7;
		text-align: left;
		cursor: pointer;
	}

	.tree-header {
		display: grid;
		grid-template-columns: 1.1rem minmax(0, 1fr);
		align-items: center;
		gap: 0.25rem;
		padding-top: 0.36rem;
		padding-bottom: 0.36rem;
		font-size: 0.82rem;
	}

	.file-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 0.1rem;
		padding-top: 0.34rem;
		padding-bottom: 0.34rem;
		font-size: 0.8rem;
	}

	.tree-header:hover,
	.file-row:hover {
		background: #2a2a2a;
	}

	.file-row.active {
		background: rgba(74, 158, 255, 0.14);
		color: #fff;
		box-shadow: inset 3px 0 0 #4a9eff;
	}

	.depth-0 { padding-left: 0.55rem; }
	.depth-1 { padding-left: 1.25rem; }
	.depth-2 { padding-left: 1.95rem; }
	.depth-3 { padding-left: 3.55rem; padding-right: 0.65rem; }

	.twisty {
		color: #a8a8a8;
		font-size: 0.72rem;
	}

	.node-text,
	.file-label,
	.file-detail {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.node-text {
		display: grid;
		gap: 0.08rem;
	}

	.node-label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.node-detail,
	.file-detail {
		color: #9a9a9a;
		font-size: 0.72rem;
	}
</style>
