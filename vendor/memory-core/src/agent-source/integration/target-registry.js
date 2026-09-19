/** Creates create skill target registry. */
export function createSkillTargetRegistry(targets) {
    const targetMap = new Map(targets.map((target) => [target.targetId, target]));
    return Object.freeze({
        list() {
            return [...targetMap.values()];
        },
        get(targetId) {
            return targetMap.get(targetId);
        },
        require(targetId) {
            const target = targetMap.get(targetId);
            if (!target) {
                throw new Error(`Unknown skill target: ${targetId}`);
            }
            return target;
        }
    });
}
