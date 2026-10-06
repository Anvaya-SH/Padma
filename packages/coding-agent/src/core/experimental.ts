export function areExperimentalFeaturesEnabled(): boolean {
	return process.env.PADMA_EXPERIMENTAL === "1";
}
