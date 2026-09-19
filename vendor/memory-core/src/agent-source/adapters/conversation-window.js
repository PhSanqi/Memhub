/**
 * Buffers one scan target and keeps whole conversations whose latest activity
 * reaches the incremental cursor. This prevents a cursor from cutting off the
 * user message at the beginning of a turn.
 */
export async function collectConversationWindow(input, since, signal, maxMessages) {
    if (maxMessages !== undefined && maxMessages <= 0)
        return [];
    const messages = [];
    for await (const message of input) {
        signal?.throwIfAborted();
        messages.push(message);
    }
    const cursor = since ? Date.parse(since) : Number.NaN;
    const eligible = new Set();
    const conversationOrder = [];
    const counts = new Map();
    for (const message of messages) {
        if (!counts.has(message.conversationId))
            conversationOrder.push(message.conversationId);
        counts.set(message.conversationId, (counts.get(message.conversationId) ?? 0) + 1);
        const createdAt = Date.parse(message.createdAt);
        if (!since || !Number.isFinite(cursor) || !Number.isFinite(createdAt) || createdAt >= cursor) {
            eligible.add(message.conversationId);
        }
    }
    const included = new Set();
    let selectedCount = 0;
    for (const conversationId of conversationOrder) {
        if (!eligible.has(conversationId))
            continue;
        const conversationSize = counts.get(conversationId) ?? 0;
        if (maxMessages !== undefined && included.size > 0 && selectedCount + conversationSize > maxMessages)
            break;
        included.add(conversationId);
        selectedCount += conversationSize;
    }
    return messages.filter((message) => included.has(message.conversationId));
}
/** Streams a source target without materializing its complete history. */
export async function* streamConversationWindow(input, since, signal, maxMessages, fullHistory = false) {
    if (maxMessages !== undefined && maxMessages <= 0)
        return;
    if (fullHistory) {
        let emitted = 0;
        for await (const message of input) {
            signal?.throwIfAborted();
            if (maxMessages !== undefined && emitted >= maxMessages)
                break;
            emitted += 1;
            yield message;
        }
        return;
    }
    for (const message of await collectConversationWindow(input, since, signal, maxMessages))
        yield message;
}
export function remainingMessageCapacity(limit, emitted) {
    return limit === undefined ? undefined : Math.max(0, limit - emitted);
}
