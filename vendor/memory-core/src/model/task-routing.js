import { AsyncLocalStorage } from "node:async_hooks";
export class MemoryModelTaskRouter {
    resolveContext;
    storage = new AsyncLocalStorage();
    constructor(resolveContext) {
        this.resolveContext = resolveContext;
    }
    client(role) {
        return new TaskRoutedLlmClient(role, this);
    }
    embedder() {
        return new TaskRoutedEmbedder(this);
    }
    currentOrResolve() {
        return this.storage.getStore() ?? this.resolveContext();
    }
    run(operation) {
        if (this.storage.getStore())
            return operation();
        return this.storage.run(this.resolveContext(), operation);
    }
}
class TaskRoutedEmbedder {
    router;
    constructor(router) {
        this.router = router;
    }
    get config() {
        return this.delegate().config;
    }
    isRemote() {
        return this.delegate().isRemote();
    }
    embed(texts, role) {
        return this.router.run(() => this.delegate().embed(texts, role));
    }
    embedOne(text, role) {
        return this.router.run(() => this.delegate().embedOne(text, role));
    }
    status() {
        return this.delegate().status();
    }
    delegate() {
        return this.router.currentOrResolve().embedding;
    }
}
class TaskRoutedLlmClient {
    role;
    router;
    constructor(role, router) {
        this.role = role;
        this.router = router;
    }
    get config() {
        return this.delegate().config;
    }
    isConfigured() {
        return this.delegate().isConfigured();
    }
    complete(messages, options) {
        return this.router.run(() => this.delegate().complete(messages, options));
    }
    completeJson(messages, options) {
        return this.router.run(() => this.delegate().completeJson(messages, options));
    }
    status() {
        return this.delegate().status();
    }
    delegate() {
        return this.router.currentOrResolve()[this.role];
    }
}
