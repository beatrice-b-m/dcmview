<script lang="ts">
	import type { FileSummary } from "../api";

	type NavKind = "patient" | "study" | "series" | "image";

	type NavFile = {
		kind: "image";
		file: FileSummary;
		label: string;
		detail: string;
	};

	type NavSeries = {
		kind: "series";
		key: string;
		label: string;
		detail: string;
		files: NavFile[];
	};

	type NavStudy = {
		kind: "study";
		key: string;
		label: string;
		detail: string;
		series: NavSeries[];
	};

	type NavPatient = {
		kind: "patient";
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

	const LARGE_TREE_COLLAPSE_THRESHOLD = 500;
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

	function numericValue(value: string): number | null {
		const parsed = Number.parseFloat(clean(value));
		return Number.isFinite(parsed) ? parsed : null;
	}

	function defaultCollapsed(key: string): boolean {
		if (files.length <= LARGE_TREE_COLLAPSE_THRESHOLD || tree.length <= 1) {
			return false;
		}
		return key.startsWith("patient:") || key.includes("/study:");
	}

	function isCollapsed(key: string): boolean {
		return collapsedNodes[key] ?? defaultCollapsed(key);
	}

	function toggleNode(key: string) {
		collapsedNodes = { ...collapsedNodes, [key]: !isCollapsed(key) };
	}

	function plural(count: number, singular: string): string {
		const pluralForms: Record<string, string> = {
			image: "images",
			series: "series",
			study: "studies",
		};
		const label = count === 1 ? singular : (pluralForms[singular] ?? `${singular}s`);
		return `${count} ${label}`;
	}

	function tierLabel(kind: NavKind): string {
		switch (kind) {
			case "patient":
				return "Patient";
			case "study":
				return "Study";
			case "series":
				return "Series";
			case "image":
				return "Image";
		}
	}

	function countStudyFiles(study: NavStudy): number {
		return study.series.reduce((total, series) => total + series.files.length, 0);
	}

	function countPatientSeries(patient: NavPatient): number {
		return patient.studies.reduce((total, study) => total + study.series.length, 0);
	}

	function countPatientFiles(patient: NavPatient): number {
		return patient.studies.reduce((total, study) => total + countStudyFiles(study), 0);
	}

	function patientLabel(file: FileSummary): string {
		return formatPersonName(clean(file.patient_name)) || clean(file.patient_id) || "Unknown Patient";
	}

	function patientDetail(file: FileSummary): string {
		const id = clean(file.patient_id);
		return id && id !== patientLabel(file) ? `ID ${id}` : "";
	}

	function studyLabel(file: FileSummary): string {
		return clean(file.study_description) || "Study";
	}

	function studyDetail(file: FileSummary): string {
		const date = formatDate(file.study_date);
		const uid = shortUid(file.study_instance_uid);
		return [date, uid && uid !== studyLabel(file) ? uid : ""]
			.filter(Boolean)
			.join(" · ");
	}

	function seriesLabel(file: FileSummary): string {
		const description = clean(file.series_description);
		const number = clean(file.series_number);
		return description || (number ? `Series ${number}` : "")
			|| shortUid(file.series_instance_uid)
			|| "Unknown Series";
	}

	function seriesDetail(file: FileSummary): string {
		const modality = clean(file.modality);
		const number = clean(file.series_number);
		const uid = shortUid(file.series_instance_uid);
		return [modality, number ? `Series ${number}` : "", uid && uid !== seriesLabel(file) ? uid : ""]
			.filter(Boolean)
			.join(" · ");
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

	function withCounts(detail: string, counts: string[]): string {
		return [detail, ...counts].filter(Boolean).join(" · ");
	}

	function patientDetailWithCounts(patient: NavPatient): string {
		return withCounts(patient.detail, [
			plural(patient.studies.length, "study"),
			plural(countPatientSeries(patient), "series"),
			plural(countPatientFiles(patient), "image"),
		]);
	}

	function studyDetailWithCounts(study: NavStudy): string {
		return withCounts(study.detail, [
			plural(study.series.length, "series"),
			plural(countStudyFiles(study), "image"),
		]);
	}

	function seriesDetailWithCounts(series: NavSeries): string {
		return withCounts(series.detail, [
			plural(series.files.length, "image"),
		]);
	}

	function nodeAriaLabel(kind: Exclude<NavKind, "image">, label: string, detail: string, collapsedState: boolean): string {
		const state = collapsedState ? "collapsed" : "expanded";
		const kindLabel = tierLabel(kind);
		const primary = label === kindLabel ? kindLabel : `${kindLabel} ${label}`;
		return `${primary}${detail ? `, ${detail}` : ""}, ${state}`;
	}

	function fileAriaLabel(item: NavFile): string {
		return `${tierLabel(item.kind)} ${item.label}${item.detail ? `, ${item.detail}` : ""}`;
	}

	const tree = $derived.by(() => {
		const patients = new Map<string, NavPatient>();
		const studies = new Map<string, NavStudy>();
		const seriesByKey = new Map<string, NavSeries>();

		for (const file of files) {
			const patientKey = nodeKey("patient", `file-${file.index}`, [file.patient_id, file.patient_name]);
			let patient = patients.get(patientKey);
			if (!patient) {
				patient = {
					kind: "patient",
					key: patientKey,
					label: patientLabel(file),
					detail: patientDetail(file),
					studies: [],
				};
				patients.set(patientKey, patient);
			}

			const studyKey = `${patientKey}/${nodeKey("study", `file-${file.index}`, [file.study_instance_uid, file.study_description, file.study_date])}`;
			let study = studies.get(studyKey);
			if (!study) {
				study = {
					kind: "study",
					key: studyKey,
					label: studyLabel(file),
					detail: studyDetail(file),
					series: [],
				};
				patient.studies.push(study);
				studies.set(studyKey, study);
			}

			const seriesKey = `${studyKey}/${nodeKey("series", `file-${file.index}`, [file.series_instance_uid, file.series_number, file.series_description])}`;
			let series = seriesByKey.get(seriesKey);
			if (!series) {
				series = {
					kind: "series",
					key: seriesKey,
					label: seriesLabel(file),
					detail: seriesDetail(file),
					files: [],
				};
				study.series.push(series);
				seriesByKey.set(seriesKey, series);
			}

			series.files.push({
				kind: "image",
				file,
				label: fileLabel(file),
				detail: fileDetail(file),
			});
		}

		for (const series of seriesByKey.values()) {
			series.files.sort((left, right) => {
				const leftInstance = numericValue(left.file.instance_number);
				const rightInstance = numericValue(right.file.instance_number);
				if (leftInstance !== null && rightInstance !== null && leftInstance !== rightInstance) {
					return leftInstance - rightInstance;
				}
				if (leftInstance !== null && rightInstance === null) return -1;
				if (leftInstance === null && rightInstance !== null) return 1;
				return left.file.index - right.file.index;
			});
		}

		return Array.from(patients.values());
	});
</script>

{#snippet nodeContent(kind: NavKind, label: string, detail: string)}
	<span class="kind-badge">{tierLabel(kind)}</span>
	<span class="node-text">
		<span class="node-label">{label}</span>
		{#if detail}<span class="node-detail">{detail}</span>{/if}
	</span>
{/snippet}

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
				{@const patientDetail = patientDetailWithCounts(patient)}
				<section class="tree-group">
					<button
						type="button"
						class="tree-header depth-0"
						aria-label={nodeAriaLabel(patient.kind, patient.label, patientDetail, isCollapsed(patient.key))}
						aria-expanded={!isCollapsed(patient.key)}
						onclick={() => toggleNode(patient.key)}
					>
						<span class="twisty">{isCollapsed(patient.key) ? "▶" : "▼"}</span>
						{@render nodeContent(patient.kind, patient.label, patientDetail)}
					</button>
					{#if !isCollapsed(patient.key)}
						{#each patient.studies as study}
							{@const studyDetail = studyDetailWithCounts(study)}
							<button
								type="button"
								class="tree-header depth-1"
								aria-label={nodeAriaLabel(study.kind, study.label, studyDetail, isCollapsed(study.key))}
								aria-expanded={!isCollapsed(study.key)}
								onclick={() => toggleNode(study.key)}
							>
								<span class="twisty">{isCollapsed(study.key) ? "▶" : "▼"}</span>
								{@render nodeContent(study.kind, study.label, studyDetail)}
							</button>
							{#if !isCollapsed(study.key)}
								{#each study.series as series}
									{@const seriesDetail = seriesDetailWithCounts(series)}
									<button
										type="button"
										class="tree-header depth-2"
										aria-label={nodeAriaLabel(series.kind, series.label, seriesDetail, isCollapsed(series.key))}
										aria-expanded={!isCollapsed(series.key)}
										onclick={() => toggleNode(series.key)}
									>
										<span class="twisty">{isCollapsed(series.key) ? "▶" : "▼"}</span>
										{@render nodeContent(series.kind, series.label, seriesDetail)}
									</button>
									{#if !isCollapsed(series.key)}
										{#each series.files as item}
											<button
												type="button"
												class="file-row depth-3"
												class:active={item.file.index === activeFileIndex}
												onclick={() => onopenfile(item.file.index)}
												title={item.file.path}
												aria-label={fileAriaLabel(item)}
											>
												{@render nodeContent(item.kind, item.label, item.detail)}
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
		background: var(--surface-panel);
		border-right: 1px solid var(--border-subtle);
		overflow: hidden;
	}

	.navigator.collapsed {
		background: var(--surface-chrome);
	}

	.navigator-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		min-height: 2.5rem;
		padding: 0.55rem 0.65rem;
		border-bottom: 1px solid var(--border-subtle);
		color: var(--text-secondary);
		font-size: 0.82rem;
		font-weight: 650;
	}

	.collapse-button {
		display: grid;
		place-items: center;
		width: 1.6rem;
		height: 1.6rem;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
		background: var(--surface-control);
		color: var(--text-secondary);
		cursor: pointer;
	}

	.collapse-button:hover {
		background: var(--surface-control-hover);
		color: var(--text-primary);
	}

	.collapse-button:focus-visible,
	.tree-header:focus-visible,
	.file-row:focus-visible {
		outline: none;
		box-shadow: inset var(--focus-ring);
	}

	.tree {
		overflow: auto;
		padding: 0.4rem 0;
		scrollbar-width: thin;
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
		color: var(--text-secondary);
		text-align: left;
		cursor: pointer;
	}

	.tree-header {
		display: grid;
		grid-template-columns: 1.1rem 3.35rem minmax(0, 1fr);
		align-items: start;
		gap: 0.35rem;
		padding-top: 0.28rem;
		padding-bottom: 0.28rem;
		font-size: 0.81rem;
	}

	.file-row {
		display: grid;
		grid-template-columns: 3.35rem minmax(0, 1fr);
		align-items: start;
		gap: 0.35rem;
		padding-top: 0.26rem;
		padding-bottom: 0.26rem;
		font-size: 0.8rem;
	}

	.tree-header:hover,
	.file-row:hover {
		background: rgba(255, 255, 255, 0.05);
	}

	.file-row.active {
		background: var(--accent-soft);
		color: var(--text-primary);
		box-shadow: inset 3px 0 0 var(--accent);
	}

	.depth-0 { padding-left: 0.55rem; }
	.depth-1 { padding-left: 1.25rem; }
	.depth-2 { padding-left: 1.95rem; }
	.depth-3 { padding-left: 3.55rem; padding-right: 0.65rem; }

	.twisty {
		align-self: center;
		color: var(--text-muted);
		font-size: 0.72rem;
		line-height: 1.35;
	}

	.kind-badge {
		display: block;
		align-self: center;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-muted);
		font-size: 0.6rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		line-height: 1.45;
		text-transform: uppercase;
	}

	.node-text {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.node-text {
		display: grid;
		gap: 0.04rem;
		line-height: 1.25;
	}

	.node-label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-secondary);
	}

	.file-row.active .node-label {
		color: var(--text-primary);
	}

	.node-detail {
		color: var(--text-muted);
		font-size: 0.72rem;
	}
</style>
