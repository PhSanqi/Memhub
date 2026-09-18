const memoryVectors = Symbol.for("memmy.memory.vectors");
export function attachMemoryVectors(memory, vectors) {
    const values = new Map();
    for (const entry of vectors) {
        if (entry.vector.length === 0)
            continue;
        values.set(entry.vectorField, {
            ...entry,
            vector: [...entry.vector]
        });
    }
    const carrier = memory;
    if (values.size > 0)
        carrier[memoryVectors] = { values, dirty: new Set() };
    else
        delete carrier[memoryVectors];
    return memory;
}
export function attachMemoryVector(memory, vector) {
    const current = memory[memoryVectors];
    const values = new Map(memoryVectorEntries(memory).map((entry) => [entry.vectorField, entry]));
    values.set(vector.vectorField, {
        ...vector,
        vector: [...vector.vector]
    });
    memory[memoryVectors] = {
        values,
        dirty: new Set([...(current?.dirty ?? []), vector.vectorField])
    };
    return memory;
}
export function memoryVector(memory, vectorField) {
    return memory[memoryVectors]?.values.get(vectorField)?.vector ?? null;
}
export function memoryVectorEntries(memory) {
    return [...(memory[memoryVectors]?.values.values() ?? [])].map((entry) => ({
        ...entry,
        vector: [...entry.vector]
    }));
}
export function dirtyMemoryVectorEntries(memory) {
    const state = memory[memoryVectors];
    if (!state)
        return [];
    return [...state.dirty].flatMap((field) => {
        const entry = state.values.get(field);
        return entry ? [{ ...entry, vector: [...entry.vector] }] : [];
    });
}
export function transferMemoryVectors(source, target) {
    const sourceState = source[memoryVectors];
    if (!sourceState)
        return attachMemoryVectors(target, []);
    const values = new Map(memoryVectorEntries(source).map((entry) => [entry.vectorField, entry]));
    target[memoryVectors] = {
        values,
        dirty: new Set(sourceState.dirty)
    };
    return target;
}
