/** Creates create source registry. */
export function createSourceRegistry(adapters) {
    const adapterMap = new Map(adapters.map((adapter) => [adapter.descriptor.sourceId, adapter]));
    return Object.freeze({
        list() {
            return [...adapterMap.values()];
        },
        get(sourceId) {
            return adapterMap.get(sourceId);
        },
        require(sourceId) {
            const adapter = adapterMap.get(sourceId);
            if (!adapter) {
                throw new Error(`Unknown agent source: ${sourceId}`);
            }
            return adapter;
        }
    });
}
