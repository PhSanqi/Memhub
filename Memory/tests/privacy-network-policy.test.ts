import { describe, expect, it, vi } from "vitest";
import {
  MemoryPrivacyBoundaryError,
  assertMemoryNetworkTarget,
  isLoopbackMemoryEndpoint
} from "../src/privacy/network-policy.js";
import { postJsonWithRetry } from "../src/model/http.js";
import { createStorageBackend } from "../src/storage/backend.js";
import { MemoryRestClient } from "../src/client/rest-client.js";
import { OpenMemCloudClient } from "../src/client/openmem-cloud-client.js";

describe("Memory local-only privacy boundary", () => {
  it.each([
    "http://127.0.0.1:18960",
    "http://127.12.34.56:18960",
    "http://localhost:18960",
    "http://[::1]:18960"
  ])("allows loopback endpoint %s", (endpoint) => {
    expect(() => assertMemoryNetworkTarget(endpoint)).not.toThrow();
    expect(isLoopbackMemoryEndpoint(endpoint)).toBe(true);
  });

  it.each([
    "https://api.openai.com/v1",
    "https://memos-api.openmem.net",
    "http://192.168.1.20:11434",
    "http://0.0.0.0:18960"
  ])("blocks non-loopback endpoint %s by default", (endpoint) => {
    expect(() => assertMemoryNetworkTarget(endpoint)).toThrow(MemoryPrivacyBoundaryError);
    expect(isLoopbackMemoryEndpoint(endpoint)).toBe(false);
  });

  it("requires an explicit opt-in before model content can be sent remotely", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(postJsonWithRetry({
      provider: "openai_compatible",
      operation: "memory_summary",
      url: "https://api.example.test/v1/chat/completions",
      body: { private: "memory" },
      timeoutMs: 1_000,
      maxRetries: 0
    })).rejects.toThrow(MemoryPrivacyBoundaryError);

    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("blocks remote storage and raw Memory REST endpoints by default", () => {
    expect(() => createStorageBackend({
      mode: "cloud",
      backend: "openmem-cloud-rest",
      endpoint: "https://memos-api.openmem.net"
    })).toThrow(MemoryPrivacyBoundaryError);

    expect(() => new MemoryRestClient({
      endpoint: "https://memory.example.test"
    })).toThrow(MemoryPrivacyBoundaryError);

    expect(() => new OpenMemCloudClient({
      endpoint: "https://memos.memtensor.cn/api/openmem/v1/"
    })).toThrow(MemoryPrivacyBoundaryError);
  });

  it("keeps a narrow explicit compatibility escape hatch", () => {
    expect(() => assertMemoryNetworkTarget("https://memory.example.test", {
      allowRemote: true,
      purpose: "explicit compatibility test"
    })).not.toThrow();

    const backend = createStorageBackend({
      mode: "cloud",
      backend: "openmem-cloud-rest",
      endpoint: "https://memory.example.test",
      allowRemote: true
    });
    expect(backend.kind).toBe("openmem-cloud-rest");

    expect(() => new MemoryRestClient({
      endpoint: "https://memory.example.test",
      allowRemote: true
    })).not.toThrow();
  });
});
