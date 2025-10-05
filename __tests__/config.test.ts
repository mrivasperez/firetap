import { describe, it, expect } from "vitest";
import {
  buildDatabasePaths,
  DEFAULT_DATABASE_PATHS,
  DEFAULT_CONFIG,
  createSimpleConfig,
  createWorkspaceConfig,
  createAdapterConfig,
  validateConfig,
  generateUserId,
  type DatabasePathsConfig,
} from "../src/config";
import {
  createTestDatabasePaths,
} from "./utils/helpers";

describe("Config Module", () => {
  describe("buildDatabasePaths", () => {
    describe("with nested structure", () => {
      it("should build documents path under base path", () => {
        const docId = "test-doc";

        const paths = buildDatabasePaths(DEFAULT_DATABASE_PATHS, docId);

        expect(paths.documents).toBe("/documents/test-doc/documents");
      });

      it("should build rooms path under base path", () => {
        const docId = "test-doc";

        const paths = buildDatabasePaths(DEFAULT_DATABASE_PATHS, docId);

        expect(paths.rooms).toBe("/documents/test-doc/rooms");
      });

      it("should build signaling path under base path", () => {
        const docId = "test-doc";

        const paths = buildDatabasePaths(DEFAULT_DATABASE_PATHS, docId);

        expect(paths.signaling).toBe("/documents/test-doc/signaling");
      });

      it("should support custom workspace base paths", () => {
        const workspaceConfig: DatabasePathsConfig = {
          structure: "nested",
          nested: {
            basePath: "/workspace-1/documents",
            subPaths: {
              documents: "documents",
              rooms: "rooms",
              snapshots: "snapshots",
              signaling: "signaling",
            },
          },
        };
        const docId = "doc-1";

        const paths = buildDatabasePaths(workspaceConfig, docId);

        expect(paths.documents).toBe("/workspace-1/documents/doc-1/documents");
      });

      it("should throw error when nested config is missing", () => {
        const invalidConfig: DatabasePathsConfig = {
          structure: "nested",
        };

        expect(() => buildDatabasePaths(invalidConfig, "test-doc")).toThrow(
          "Nested structure requires nested config"
        );
      });
    });

    describe("with flat structure", () => {
      it("should use provided documents path directly", () => {
        const flatConfig = createTestDatabasePaths();

        const paths = buildDatabasePaths(flatConfig, "test-doc");

        expect(paths.documents).toBe("/test-docs");
      });

      it("should use provided signaling path directly", () => {
        const flatConfig = createTestDatabasePaths();

        const paths = buildDatabasePaths(flatConfig, "test-doc");

        expect(paths.signaling).toBe("/test-signals");
      });

      it("should throw error when flat config is missing", () => {
        const invalidConfig: DatabasePathsConfig = {
          structure: "flat",
        };

        expect(() => buildDatabasePaths(invalidConfig, "test-doc")).toThrow(
          "Flat structure requires flat config"
        );
      });
    });
  });

  describe("createSimpleConfig", () => {
    it("should use provided document ID", () => {
      const docId = "my-document";
      const user = { name: "Test User" };

      const config = createSimpleConfig(docId, user);

      expect(config.docId).toBe("my-document");
    });

    it("should use provided user name", () => {
      const docId = "doc-1";
      const user = { name: "Jane Doe" };

      const config = createSimpleConfig(docId, user);

      expect(config.user?.name).toBe("Jane Doe");
    });

    it("should set default max direct peers", () => {
      const docId = "doc-1";
      const user = { name: "Test User" };

      const config = createSimpleConfig(docId, user);

      expect(config.maxDirectPeers).toBe(6);
    });

    it("should include database paths configuration", () => {
      const docId = "doc-1";
      const user = { name: "Test User" };

      const config = createSimpleConfig(docId, user);

      expect(config.databasePaths).toBeDefined();
    });

    it("should not include firebaseDatabase property", () => {
      const docId = "doc-1";
      const user = { name: "Test User" };

      const config = createSimpleConfig(docId, user);

      expect(config).not.toHaveProperty("firebaseDatabase");
    });
  });

  describe("createWorkspaceConfig", () => {
    it("should include workspace in database base path", () => {
      const docId = "doc-1";
      const workspaceId = "my-workspace";
      const user = { name: "Test User" };

      const config = createWorkspaceConfig(docId, workspaceId, user);

      if (config.databasePaths?.structure === "nested") {
        expect(config.databasePaths.nested?.basePath).toBe(
          "/my-workspace/documents"
        );
      }
    });

    it("should create paths that include workspace identifier", () => {
      const docId = "doc-1";
      const workspaceId = "workspace-123";
      const user = { name: "Test User" };

      const config = createWorkspaceConfig(docId, workspaceId, user);

      if (config.databasePaths) {
        const paths = buildDatabasePaths(config.databasePaths, docId);
        expect(paths.documents).toContain("workspace-123");
      }
    });
  });

  describe("createAdapterConfig", () => {
    it("should merge user-provided config with defaults", () => {
      const userConfig = {
        docId: "test-doc",
        user: { name: "Custom User" },
      };

      const config = createAdapterConfig(userConfig);

      expect(config.docId).toBe("test-doc");
    });

    it("should allow overriding default max peers", () => {
      const userConfig = {
        docId: "test-doc",
        user: { name: "User" },
        maxDirectPeers: 10,
      };

      const config = createAdapterConfig(userConfig);

      expect(config.maxDirectPeers).toBe(10);
    });

    it("should use default sync interval when not specified", () => {
      const userConfig = {
        docId: "test-doc",
        user: { name: "User" },
      };

      const config = createAdapterConfig(userConfig);

      expect(config.syncIntervalMs).toBe(DEFAULT_CONFIG.syncIntervalMs);
    });

    it("should accept custom database paths", () => {
      const customPaths: DatabasePathsConfig = {
        structure: "flat",
        flat: {
          documents: "/custom-docs",
          rooms: "/custom-rooms",
          snapshots: "/custom-snaps",
          signaling: "/custom-signals",
        },
      };
      const userConfig = {
        docId: "test-doc",
        user: { name: "User" },
        databasePaths: customPaths,
      };

      const config = createAdapterConfig(userConfig);

      expect(config.databasePaths).toEqual(customPaths);
    });
  });

  describe("validateConfig", () => {
    it("should return no errors for valid configuration", () => {
      const validConfig = {
        docId: "test-doc",
        user: { name: "Test User" },
        maxDirectPeers: 6,
        syncIntervalMs: 15000,
      };

      const errors = validateConfig(validConfig);

      expect(errors).toEqual([]);
    });

    it("should reject empty document ID", () => {
      const configWithEmptyDocId = {
        docId: "   ",
        user: { name: "Test User" },
      };

      const errors = validateConfig(configWithEmptyDocId);

      expect(errors).toContain("Document ID cannot be empty");
    });

    it("should reject empty user name", () => {
      const configWithEmptyUserName = {
        docId: "test-doc",
        user: { name: "   " },
      };

      const errors = validateConfig(configWithEmptyUserName);

      expect(errors).toContain("User name cannot be empty");
    });

    it("should reject negative peer count", () => {
      const configWithNegativePeers = {
        docId: "test-doc",
        user: { name: "Test User" },
        maxDirectPeers: -1,
      };

      const errors = validateConfig(configWithNegativePeers);

      expect(errors).toContain("Max direct peers must be between 1 and 20");
    });

    it("should reject excessive peer count", () => {
      const configWithTooManyPeers = {
        docId: "test-doc",
        user: { name: "Test User" },
        maxDirectPeers: 100,
      };

      const errors = validateConfig(configWithTooManyPeers);

      expect(errors.some((e) => e.includes("Max direct peers"))).toBe(true);
    });

    it("should reject sync interval below minimum", () => {
      const configWithLowInterval = {
        docId: "test-doc",
        user: { name: "Test User" },
        syncIntervalMs: 500,
      };

      const errors = validateConfig(configWithLowInterval);

      expect(errors.some((e) => e.includes("Sync interval"))).toBe(true);
    });

    it("should return all errors when multiple issues exist", () => {
      const invalidConfig = {
        docId: "   ",
        user: { name: "   " },
        maxDirectPeers: -5,
        syncIntervalMs: 100,
      };

      const errors = validateConfig(invalidConfig);

      expect(errors.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("generateUserId", () => {
    it("should return a non-empty string", () => {
      const userId = generateUserId();

      expect(userId.length).toBeGreaterThan(0);
    });

    it("should return different IDs on successive calls", () => {
      const id1 = generateUserId();
      const id2 = generateUserId();

      expect(id1).not.toBe(id2);
    });

    it("should start with user prefix", () => {
      const userId = generateUserId();

      expect(userId).toMatch(/^user-/);
    });

    it("should include timestamp component", () => {
      const beforeTime = Date.now();

      const userId = generateUserId();
      const timestamp = parseInt(userId.split("-")[1]);
      const afterTime = Date.now();

      expect(timestamp).toBeGreaterThanOrEqual(beforeTime);
      expect(timestamp).toBeLessThanOrEqual(afterTime);
    });
  });

  describe("DEFAULT_DATABASE_PATHS", () => {
    it("should use nested structure", () => {
      expect(DEFAULT_DATABASE_PATHS.structure).toBe("nested");
    });

    it("should define documents subpath", () => {
      expect(DEFAULT_DATABASE_PATHS.nested?.subPaths).toHaveProperty(
        "documents"
      );
    });

    it("should define rooms subpath", () => {
      expect(DEFAULT_DATABASE_PATHS.nested?.subPaths).toHaveProperty("rooms");
    });

    it("should define snapshots subpath", () => {
      expect(DEFAULT_DATABASE_PATHS.nested?.subPaths).toHaveProperty(
        "snapshots"
      );
    });

    it("should define signaling subpath", () => {
      expect(DEFAULT_DATABASE_PATHS.nested?.subPaths).toHaveProperty(
        "signaling"
      );
    });

    it("should use /documents as base path", () => {
      expect(DEFAULT_DATABASE_PATHS.nested?.basePath).toBe("/documents");
    });
  });

  describe("DEFAULT_CONFIG", () => {
    it("should have auto-reconnect enabled", () => {
      expect(DEFAULT_CONFIG.autoReconnect).toBe(true);
    });

    it("should have positive connection timeout", () => {
      expect(DEFAULT_CONFIG.connectionTimeout).toBeGreaterThan(0);
    });

    it("should have positive heartbeat interval", () => {
      expect(DEFAULT_CONFIG.heartbeatInterval).toBeGreaterThan(0);
    });

    it("should have valid default peer count", () => {
      expect(DEFAULT_CONFIG.maxDirectPeers).toBeGreaterThan(0);
    });

    it("should have positive sync interval", () => {
      expect(DEFAULT_CONFIG.syncIntervalMs).toBeGreaterThan(0);
    });
  });
});
