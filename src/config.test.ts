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
} from "./config";

describe("Config Module", () => {
  describe("buildDatabasePaths", () => {
    describe("with nested structure", () => {
      it("should build documents path under base path", () => {
        // Arrange
        const docId = "test-doc";

        // Act
        const paths = buildDatabasePaths(DEFAULT_DATABASE_PATHS, docId);

        // Assert
        expect(paths.documents).toBe("/documents/test-doc/documents");
      });

      it("should build rooms path under base path", () => {
        // Arrange
        const docId = "test-doc";

        // Act
        const paths = buildDatabasePaths(DEFAULT_DATABASE_PATHS, docId);

        // Assert
        expect(paths.rooms).toBe("/documents/test-doc/rooms");
      });

      it("should build signaling path under base path", () => {
        // Arrange
        const docId = "test-doc";

        // Act
        const paths = buildDatabasePaths(DEFAULT_DATABASE_PATHS, docId);

        // Assert
        expect(paths.signaling).toBe("/documents/test-doc/signaling");
      });

      it("should support custom workspace base paths", () => {
        // Arrange
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

        // Act
        const paths = buildDatabasePaths(workspaceConfig, docId);

        // Assert
        expect(paths.documents).toBe("/workspace-1/documents/doc-1/documents");
      });

      it("should throw error when nested config is missing", () => {
        // Arrange
        const invalidConfig: DatabasePathsConfig = {
          structure: "nested",
        };

        // Act & Assert
        expect(() => buildDatabasePaths(invalidConfig, "test-doc")).toThrow(
          "Nested structure requires nested config"
        );
      });
    });

    describe("with flat structure", () => {
      it("should use provided documents path directly", () => {
        // Arrange
        const flatConfig: DatabasePathsConfig = {
          structure: "flat",
          flat: {
            documents: "/docs",
            rooms: "/rooms",
            snapshots: "/snaps",
            signaling: "/signals",
          },
        };

        // Act
        const paths = buildDatabasePaths(flatConfig, "test-doc");

        // Assert
        expect(paths.documents).toBe("/docs");
      });

      it("should use provided signaling path directly", () => {
        // Arrange
        const flatConfig: DatabasePathsConfig = {
          structure: "flat",
          flat: {
            documents: "/docs",
            rooms: "/rooms",
            snapshots: "/snaps",
            signaling: "/signals",
          },
        };

        // Act
        const paths = buildDatabasePaths(flatConfig, "test-doc");

        // Assert
        expect(paths.signaling).toBe("/signals");
      });

      it("should throw error when flat config is missing", () => {
        // Arrange
        const invalidConfig: DatabasePathsConfig = {
          structure: "flat",
        };

        // Act & Assert
        expect(() => buildDatabasePaths(invalidConfig, "test-doc")).toThrow(
          "Flat structure requires flat config"
        );
      });
    });
  });

  describe("createSimpleConfig", () => {
    it("should use provided document ID", () => {
      // Arrange
      const docId = "my-document";
      const user = { name: "Test User" };

      // Act
      const config = createSimpleConfig(docId, user);

      // Assert
      expect(config.docId).toBe("my-document");
    });

    it("should use provided user name", () => {
      // Arrange
      const docId = "doc-1";
      const user = { name: "Jane Doe" };

      // Act
      const config = createSimpleConfig(docId, user);

      // Assert
      expect(config.user.name).toBe("Jane Doe");
    });

    it("should set default max direct peers", () => {
      // Arrange
      const docId = "doc-1";
      const user = { name: "Test User" };

      // Act
      const config = createSimpleConfig(docId, user);

      // Assert
      expect(config.maxDirectPeers).toBe(6);
    });

    it("should include database paths configuration", () => {
      // Arrange
      const docId = "doc-1";
      const user = { name: "Test User" };

      // Act
      const config = createSimpleConfig(docId, user);

      // Assert
      expect(config.databasePaths).toBeDefined();
    });

    it("should not include firebaseDatabase property", () => {
      // Arrange
      const docId = "doc-1";
      const user = { name: "Test User" };

      // Act
      const config = createSimpleConfig(docId, user);

      // Assert
      expect(config).not.toHaveProperty("firebaseDatabase");
    });
  });

  describe("createWorkspaceConfig", () => {
    it("should include workspace in database base path", () => {
      // Arrange
      const docId = "doc-1";
      const workspaceId = "my-workspace";
      const user = { name: "Test User" };

      // Act
      const config = createWorkspaceConfig(docId, workspaceId, user);

      // Assert
      if (config.databasePaths?.structure === "nested") {
        expect(config.databasePaths.nested?.basePath).toBe(
          "/my-workspace/documents"
        );
      }
    });

    it("should create paths that include workspace identifier", () => {
      // Arrange
      const docId = "doc-1";
      const workspaceId = "workspace-123";
      const user = { name: "Test User" };

      // Act
      const config = createWorkspaceConfig(docId, workspaceId, user);

      // Assert
      if (config.databasePaths) {
        const paths = buildDatabasePaths(config.databasePaths, docId);
        expect(paths.documents).toContain("workspace-123");
      }
    });
  });

  describe("createAdapterConfig", () => {
    it("should merge user-provided config with defaults", () => {
      // Arrange
      const userConfig = {
        docId: "test-doc",
        user: { name: "Custom User" },
      };

      // Act
      const config = createAdapterConfig(userConfig);

      // Assert
      expect(config.docId).toBe("test-doc");
    });

    it("should allow overriding default max peers", () => {
      // Arrange
      const userConfig = {
        docId: "test-doc",
        user: { name: "User" },
        maxDirectPeers: 10,
      };

      // Act
      const config = createAdapterConfig(userConfig);

      // Assert
      expect(config.maxDirectPeers).toBe(10);
    });

    it("should use default sync interval when not specified", () => {
      // Arrange
      const userConfig = {
        docId: "test-doc",
        user: { name: "User" },
      };

      // Act
      const config = createAdapterConfig(userConfig);

      // Assert
      expect(config.syncIntervalMs).toBe(DEFAULT_CONFIG.syncIntervalMs);
    });

    it("should accept custom database paths", () => {
      // Arrange
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

      // Act
      const config = createAdapterConfig(userConfig);

      // Assert
      expect(config.databasePaths).toEqual(customPaths);
    });
  });

  describe("validateConfig", () => {
    it("should return no errors for valid configuration", () => {
      // Arrange
      const validConfig = {
        docId: "test-doc",
        user: { name: "Test User" },
        maxDirectPeers: 6,
        syncIntervalMs: 15000,
      };

      // Act
      const errors = validateConfig(validConfig);

      // Assert
      expect(errors).toEqual([]);
    });

    it("should reject empty document ID", () => {
      // Arrange
      const configWithEmptyDocId = {
        docId: "   ",
        user: { name: "Test User" },
      };

      // Act
      const errors = validateConfig(configWithEmptyDocId);

      // Assert
      expect(errors).toContain("Document ID cannot be empty");
    });

    it("should reject empty user name", () => {
      // Arrange
      const configWithEmptyUserName = {
        docId: "test-doc",
        user: { name: "   " },
      };

      // Act
      const errors = validateConfig(configWithEmptyUserName);

      // Assert
      expect(errors).toContain("User name cannot be empty");
    });

    it("should reject negative peer count", () => {
      // Arrange
      const configWithNegativePeers = {
        docId: "test-doc",
        user: { name: "Test User" },
        maxDirectPeers: -1,
      };

      // Act
      const errors = validateConfig(configWithNegativePeers);

      // Assert
      expect(errors).toContain("Max direct peers must be between 1 and 20");
    });

    it("should reject excessive peer count", () => {
      // Arrange
      const configWithTooManyPeers = {
        docId: "test-doc",
        user: { name: "Test User" },
        maxDirectPeers: 100,
      };

      // Act
      const errors = validateConfig(configWithTooManyPeers);

      // Assert
      expect(errors.some((e) => e.includes("Max direct peers"))).toBe(true);
    });

    it("should reject sync interval below minimum", () => {
      // Arrange
      const configWithLowInterval = {
        docId: "test-doc",
        user: { name: "Test User" },
        syncIntervalMs: 500,
      };

      // Act
      const errors = validateConfig(configWithLowInterval);

      // Assert
      expect(errors.some((e) => e.includes("Sync interval"))).toBe(true);
    });

    it("should return all errors when multiple issues exist", () => {
      // Arrange
      const invalidConfig = {
        docId: "   ",
        user: { name: "   " },
        maxDirectPeers: -5,
        syncIntervalMs: 100,
      };

      // Act
      const errors = validateConfig(invalidConfig);

      // Assert
      expect(errors.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("generateUserId", () => {
    it("should return a non-empty string", () => {
      // Act
      const userId = generateUserId();

      // Assert
      expect(userId.length).toBeGreaterThan(0);
    });

    it("should return different IDs on successive calls", () => {
      // Act
      const id1 = generateUserId();
      const id2 = generateUserId();

      // Assert
      expect(id1).not.toBe(id2);
    });

    it("should start with user prefix", () => {
      // Act
      const userId = generateUserId();

      // Assert
      expect(userId).toMatch(/^user-/);
    });

    it("should include timestamp component", () => {
      // Arrange
      const beforeTime = Date.now();

      // Act
      const userId = generateUserId();
      const timestamp = parseInt(userId.split("-")[1]);
      const afterTime = Date.now();

      // Assert
      expect(timestamp).toBeGreaterThanOrEqual(beforeTime);
      expect(timestamp).toBeLessThanOrEqual(afterTime);
    });
  });

  describe("DEFAULT_DATABASE_PATHS", () => {
    it("should use nested structure", () => {
      // Assert
      expect(DEFAULT_DATABASE_PATHS.structure).toBe("nested");
    });

    it("should define documents subpath", () => {
      // Assert
      expect(DEFAULT_DATABASE_PATHS.nested?.subPaths).toHaveProperty(
        "documents"
      );
    });

    it("should define rooms subpath", () => {
      // Assert
      expect(DEFAULT_DATABASE_PATHS.nested?.subPaths).toHaveProperty("rooms");
    });

    it("should define snapshots subpath", () => {
      // Assert
      expect(DEFAULT_DATABASE_PATHS.nested?.subPaths).toHaveProperty(
        "snapshots"
      );
    });

    it("should define signaling subpath", () => {
      // Assert
      expect(DEFAULT_DATABASE_PATHS.nested?.subPaths).toHaveProperty(
        "signaling"
      );
    });

    it("should use /documents as base path", () => {
      // Assert
      expect(DEFAULT_DATABASE_PATHS.nested?.basePath).toBe("/documents");
    });
  });

  describe("DEFAULT_CONFIG", () => {
    it("should have auto-reconnect enabled", () => {
      // Assert
      expect(DEFAULT_CONFIG.autoReconnect).toBe(true);
    });

    it("should have positive connection timeout", () => {
      // Assert
      expect(DEFAULT_CONFIG.connectionTimeout).toBeGreaterThan(0);
    });

    it("should have positive heartbeat interval", () => {
      // Assert
      expect(DEFAULT_CONFIG.heartbeatInterval).toBeGreaterThan(0);
    });

    it("should have valid default peer count", () => {
      // Assert
      expect(DEFAULT_CONFIG.maxDirectPeers).toBeGreaterThan(0);
    });

    it("should have positive sync interval", () => {
      // Assert
      expect(DEFAULT_CONFIG.syncIntervalMs).toBeGreaterThan(0);
    });
  });
});
