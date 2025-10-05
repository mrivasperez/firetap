import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  loadDocumentFromFirebase,
  persistDocument,
  startPeriodicPersistence,
  persistDocumentIfChanged,
  getDocumentStateHash,
  createDocumentSnapshot,
  loadDocumentSnapshot,
  getDocumentVersion,
  type DocumentSnapshot,
} from "../src/persistence";
import * as Y from "yjs";
import type { Database } from "firebase/database";
import type { DatabasePathsConfig } from "../src/config";
import {
  createTestDatabase,
  createMockDocumentSnapshot,
  generateMockBase64,
  createCustomDatabasePaths,
} from "./utils/helpers";

vi.mock("firebase/database", async () => {
  const actual = await vi.importActual("firebase/database");
  return {
    ...actual,
    ref: vi.fn((db, path) => ({ _path: path })),
    set: vi.fn(() => Promise.resolve()),
    get: vi.fn(() =>
      Promise.resolve({
        exists: () => false,
        val: () => null,
      })
    ),
    serverTimestamp: vi.fn(() => ({ ".sv": "timestamp" })),
  };
});

describe("Persistence Module", () => {
  let mockDatabase: Database;
  let ydoc: Y.Doc;
  const mockDocId = "test-doc";

  beforeEach(() => {
    mockDatabase = createTestDatabase();
    ydoc = new Y.Doc();
    vi.clearAllMocks();
  });

  afterEach(() => {
    ydoc.destroy();
  });

  describe("loadDocumentFromFirebase", () => {
    it("should return null when no document exists", async () => {
      const { get } = await import("firebase/database");
      vi.mocked(get).mockResolvedValueOnce({
        exists: () => false,
        val: () => null,
      } as any);

      const result = await loadDocumentFromFirebase(mockDatabase, mockDocId);

      expect(result).toBeNull();
    });

    it("should load document from snapshots when available", async () => {
      const { get } = await import("firebase/database");
      const snapshot = createMockDocumentSnapshot({
        update: generateMockBase64("test-update"),
        stateVector: generateMockBase64("state-vector"),
      });

      vi.mocked(get).mockResolvedValueOnce({
        exists: () => true,
        val: () => snapshot,
      } as any);

      const result = await loadDocumentFromFirebase(mockDatabase, mockDocId);

      expect(result).toBeInstanceOf(Uint8Array);
    });

    it("should fallback to legacy documents collection", async () => {
      const { get } = await import("firebase/database");
      const mockUpdate = generateMockBase64("legacy-update");

      vi.mocked(get)
        .mockResolvedValueOnce({
          exists: () => false,
          val: () => null,
        } as any)
        .mockResolvedValueOnce({
          exists: () => true,
          val: () => ({ update: mockUpdate }),
        } as any);

      const result = await loadDocumentFromFirebase(mockDatabase, mockDocId);

      expect(result).toBeInstanceOf(Uint8Array);
    });

    it("should use custom database paths when provided", async () => {
      const { ref } = await import("firebase/database");
      const customPaths = createCustomDatabasePaths("custom");

      await loadDocumentFromFirebase(mockDatabase, mockDocId, customPaths);

      const refCalls = vi.mocked(ref).mock.calls;
      const pathUsed = refCalls[0][1];
      expect(pathUsed).toContain("custom-snaps");
    });

    it("should handle errors gracefully", async () => {
      const { get } = await import("firebase/database");
      vi.mocked(get).mockRejectedValueOnce(new Error("Network error"));

      const result = await loadDocumentFromFirebase(mockDatabase, mockDocId);

      expect(result).toBeNull();
    });
  });

  describe("persistDocument", () => {
    it("should persist document to Firebase", async () => {
      const { set } = await import("firebase/database");
      const ytext = ydoc.getText("test");
      ytext.insert(0, "Hello World");

      await persistDocument(mockDatabase, ydoc, mockDocId);

      expect(set).toHaveBeenCalled();
    });

    it("should include document update in snapshot", async () => {
      const { set } = await import("firebase/database");
      const ytext = ydoc.getText("test");
      ytext.insert(0, "Hello");

      await persistDocument(mockDatabase, ydoc, mockDocId);

      const callArgs = vi.mocked(set).mock.calls[0];
      const snapshot = callArgs[1] as DocumentSnapshot;
      expect(snapshot).toHaveProperty("update");
    });

    it("should include state vector in snapshot", async () => {
      const { set } = await import("firebase/database");

      await persistDocument(mockDatabase, ydoc, mockDocId);

      const callArgs = vi.mocked(set).mock.calls[0];
      const snapshot = callArgs[1] as DocumentSnapshot;
      expect(snapshot).toHaveProperty("stateVector");
    });

    it("should include checksum in snapshot", async () => {
      const { set } = await import("firebase/database");

      await persistDocument(mockDatabase, ydoc, mockDocId);

      const callArgs = vi.mocked(set).mock.calls[0];
      const snapshot = callArgs[1] as DocumentSnapshot;
      expect(snapshot).toHaveProperty("checksum");
      expect(snapshot.checksum).toBeDefined();
    });

    it("should use provided version number", async () => {
      const { set } = await import("firebase/database");
      const customVersion = 42;

      await persistDocument(mockDatabase, ydoc, mockDocId, customVersion);

      const callArgs = vi.mocked(set).mock.calls[0];
      const snapshot = callArgs[1] as DocumentSnapshot;
      expect(snapshot.version).toBe(customVersion);
    });

    it("should use timestamp as version when not provided", async () => {
      const { set } = await import("firebase/database");
      const beforeTime = Date.now();

      await persistDocument(mockDatabase, ydoc, mockDocId);

      const callArgs = vi.mocked(set).mock.calls[0];
      const snapshot = callArgs[1] as DocumentSnapshot;
      const afterTime = Date.now();

      expect(snapshot.version).toBeGreaterThanOrEqual(beforeTime);
      expect(snapshot.version).toBeLessThanOrEqual(afterTime);
    });

    it("should use custom database paths when provided", async () => {
      const { ref } = await import("firebase/database");
      const customPaths = createCustomDatabasePaths("custom");

      await persistDocument(
        mockDatabase,
        ydoc,
        mockDocId,
        undefined,
        customPaths
      );

      const refCalls = vi.mocked(ref).mock.calls;
      const pathUsed = refCalls[0][1];
      expect(pathUsed).toContain("custom-snaps");
    });

    it("should throw on persistence errors", async () => {
      const { set } = await import("firebase/database");
      vi.mocked(set).mockRejectedValueOnce(new Error("Write failed"));

      await expect(
        persistDocument(mockDatabase, ydoc, mockDocId)
      ).rejects.toThrow("Write failed");
    });
  });

  describe("persistDocumentIfChanged", () => {
    it("should persist when document has changes", async () => {
      const { set } = await import("firebase/database");
      const ytext = ydoc.getText("test");
      ytext.insert(0, "Hello");

      const result = await persistDocumentIfChanged(
        mockDatabase,
        ydoc,
        mockDocId
      );

      expect(result).toBe(true);
      expect(set).toHaveBeenCalled();
    });

    it("should not persist when document unchanged", async () => {
      const { set } = await import("firebase/database");
      const currentState = getDocumentStateHash(ydoc);

      const result = await persistDocumentIfChanged(
        mockDatabase,
        ydoc,
        mockDocId,
        currentState
      );

      expect(result).toBe(false);
      expect(set).not.toHaveBeenCalled();
    });

    it("should persist when lastKnownState not provided", async () => {
      const { set } = await import("firebase/database");

      const result = await persistDocumentIfChanged(
        mockDatabase,
        ydoc,
        mockDocId
      );

      expect(result).toBe(true);
      expect(set).toHaveBeenCalled();
    });
  });

  describe("getDocumentStateHash", () => {
    it("should return consistent hash for same document state", () => {
      const hash1 = getDocumentStateHash(ydoc);
      const hash2 = getDocumentStateHash(ydoc);

      expect(hash1).toBe(hash2);
    });

    it("should return different hash when document changes", () => {
      const hash1 = getDocumentStateHash(ydoc);

      const ytext = ydoc.getText("test");
      ytext.insert(0, "Hello");

      const hash2 = getDocumentStateHash(ydoc);

      expect(hash1).not.toBe(hash2);
    });

    it("should return a non-empty string", () => {
      const hash = getDocumentStateHash(ydoc);

      expect(hash).toBeDefined();
      expect(typeof hash).toBe("string");
      expect(hash.length).toBeGreaterThan(0);
    });
  });

  describe("startPeriodicPersistence", () => {
    it("should return cleanup function", () => {
      const cleanup = startPeriodicPersistence(
        mockDatabase,
        ydoc,
        mockDocId,
        1000
      );

      expect(typeof cleanup).toBe("function");
      cleanup();
    });

    it("should persist on document updates", async () => {
      const { set } = await import("firebase/database");
      const cleanup = startPeriodicPersistence(
        mockDatabase,
        ydoc,
        mockDocId,
        1000
      );

      const ytext = ydoc.getText("test");
      ytext.insert(0, "Hello");

      await new Promise((resolve) => setTimeout(resolve, 2500));

      expect(set).toHaveBeenCalled();
      cleanup();
    });

    it("should debounce rapid changes", async () => {
      const { set } = await import("firebase/database");
      const cleanup = startPeriodicPersistence(
        mockDatabase,
        ydoc,
        mockDocId,
        10000
      );

      const ytext = ydoc.getText("test");
      ytext.insert(0, "H");
      ytext.insert(1, "e");
      ytext.insert(2, "l");

      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(set).not.toHaveBeenCalled();
      cleanup();
    });

    it("should cleanup listeners on cleanup call", () => {
      const cleanup = startPeriodicPersistence(
        mockDatabase,
        ydoc,
        mockDocId,
        1000
      );

      expect(() => cleanup()).not.toThrow();
    });

    it("should use custom interval", () => {
      const customInterval = 5000;
      const cleanup = startPeriodicPersistence(
        mockDatabase,
        ydoc,
        mockDocId,
        customInterval
      );

      expect(cleanup).toBeDefined();
      cleanup();
    });
  });

  describe("createDocumentSnapshot", () => {
    it("should create snapshot with timestamp", async () => {
      const { set } = await import("firebase/database");

      await createDocumentSnapshot(mockDatabase, ydoc, mockDocId);

      expect(set).toHaveBeenCalled();
    });

    it("should use provided label in snapshot key", async () => {
      const { ref } = await import("firebase/database");
      const label = "backup";

      await createDocumentSnapshot(mockDatabase, ydoc, mockDocId, label);

      const refCalls = vi.mocked(ref).mock.calls;
      const pathUsed = refCalls[0][1];
      expect(pathUsed).toContain(label);
    });

    it("should include checksum in snapshot", async () => {
      const { set } = await import("firebase/database");

      await createDocumentSnapshot(mockDatabase, ydoc, mockDocId);

      const callArgs = vi.mocked(set).mock.calls[0];
      const snapshot = callArgs[1] as DocumentSnapshot;
      expect(snapshot).toHaveProperty("checksum");
    });

    it("should use custom database paths", async () => {
      const { ref } = await import("firebase/database");
      const customPaths = createCustomDatabasePaths("custom");

      await createDocumentSnapshot(
        mockDatabase,
        ydoc,
        mockDocId,
        undefined,
        customPaths
      );

      const refCalls = vi.mocked(ref).mock.calls;
      const pathUsed = refCalls[0][1];
      expect(pathUsed).toContain("custom-snaps");
    });
  });

  describe("loadDocumentSnapshot", () => {
    it("should return null when snapshot does not exist", async () => {
      const { get } = await import("firebase/database");
      vi.mocked(get).mockResolvedValueOnce({
        exists: () => false,
        val: () => null,
      } as any);

      const result = await loadDocumentSnapshot(
        mockDatabase,
        mockDocId,
        "snapshot_123"
      );

      expect(result).toBeNull();
    });

    it("should load snapshot data when exists", async () => {
      const { get } = await import("firebase/database");
      const snapshot = createMockDocumentSnapshot({
        update: generateMockBase64("snapshot-data"),
        stateVector: generateMockBase64("state"),
      });

      vi.mocked(get).mockResolvedValueOnce({
        exists: () => true,
        val: () => snapshot,
      } as any);

      const result = await loadDocumentSnapshot(
        mockDatabase,
        mockDocId,
        "snapshot_123"
      );

      expect(result).toBeInstanceOf(Uint8Array);
    });

    it("should handle errors gracefully", async () => {
      const { get } = await import("firebase/database");
      vi.mocked(get).mockRejectedValueOnce(new Error("Read error"));

      const result = await loadDocumentSnapshot(
        mockDatabase,
        mockDocId,
        "snapshot_123"
      );

      expect(result).toBeNull();
    });
  });

  describe("getDocumentVersion", () => {
    it("should return null when no document exists", async () => {
      const { get } = await import("firebase/database");
      vi.mocked(get).mockResolvedValueOnce({
        exists: () => false,
        val: () => null,
      } as any);

      const result = await getDocumentVersion(mockDatabase, mockDocId);

      expect(result).toBeNull();
    });

    it("should return version number when document exists", async () => {
      const { get } = await import("firebase/database");
      const mockVersion = 42;
      const snapshot = createMockDocumentSnapshot({
        version: mockVersion,
      });

      vi.mocked(get).mockResolvedValueOnce({
        exists: () => true,
        val: () => snapshot,
      } as any);

      const result = await getDocumentVersion(mockDatabase, mockDocId);

      expect(result).toBe(mockVersion);
    });

    it("should handle errors gracefully", async () => {
      const { get } = await import("firebase/database");
      vi.mocked(get).mockRejectedValueOnce(new Error("Read error"));

      const result = await getDocumentVersion(mockDatabase, mockDocId);

      expect(result).toBeNull();
    });
  });
});
