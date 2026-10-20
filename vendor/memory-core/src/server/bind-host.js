// Both the CLI entry point and the library listener must refuse non-loopback
// binds, so this lives in its own module: index.js imports http.js and http.js
// cannot import index.js without a cycle.
export function assertLoopbackBindHost(host) {
    if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
        throw new Error(`Memory service must listen on a loopback address, received: ${host}`);
    }
}
