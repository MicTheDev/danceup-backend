const request = require("supertest");
const admin = require("firebase-admin");

// Mock Firebase Admin
jest.mock("firebase-admin", () => ({
  auth: jest.fn(() => ({
    createUser: jest.fn(),
    getUserByEmail: jest.fn(),
    createCustomToken: jest.fn(),
    verifyIdToken: jest.fn(),
  })),
  firestore: {
    FieldValue: {
      serverTimestamp: jest.fn(() => ({_methodName: "serverTimestamp"})),
    },
  },
  apps: [],
  initializeApp: jest.fn(),
}));

jest.mock("firebase-admin/firestore", () => ({
  getFirestore: jest.fn(() => ({
    collection: jest.fn(() => ({
      where: jest.fn(() => ({
        limit: jest.fn(() => ({
          get: jest.fn(),
        })),
      })),
      add: jest.fn(),
    })),
  })),
}));

jest.mock("firebase-admin/storage", () => ({
  getStorage: jest.fn(() => ({
    bucket: jest.fn(() => ({
      file: jest.fn(() => ({
        save: jest.fn(),
        makePublic: jest.fn(),
        delete: jest.fn(),
      })),
    })),
  })),
}));

// Mock services
jest.mock("../services/auth.service");
jest.mock("../services/storage.service");
jest.mock("../middleware/auth.middleware");

const authService = require("../services/auth.service");
const storageService = require("../services/storage.service");
const {verifyToken} = require("../middleware/auth.middleware");

// Import app after mocks
const {app} = require("../index");

describe("Auth Routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Set FIREBASE_WEB_API_KEY for login route tests
    process.env.FIREBASE_WEB_API_KEY = "test-api-key";
  });

  describe("POST /v1/auth/register", () => {
    const validRegistrationData = {
      email: "test@studio.com",
      password: "password123",
      firstName: "John",
      lastName: "Doe",
      studioName: "Test Studio",
      studioAddressLine1: "123 Main St",
      studioAddressLine2: null,
      city: "New York",
      state: "NY",
      zip: "10001",
      membership: "basic",
      facebook: null,
      instagram: null,
      tiktok: null,
      youtube: null,
      studioImageFile: null,
    };

    test("should register a new user successfully", async () => {
      const mockUserRecord = {
        uid: "test-uid",
        email: "test@studio.com",
      };

      authService.createUser.mockResolvedValue(mockUserRecord);
      authService.createUserDocument.mockResolvedValue("doc-id");
      authService.createCustomToken.mockResolvedValue("custom-token");

      const response = await request(app)
          .post("/v1/auth/register")
          .send(validRegistrationData)
          .expect(201);

      expect(response.body).toHaveProperty("customToken", "custom-token");
      expect(response.body).toHaveProperty("user");
      expect(response.body.user).toHaveProperty("uid", "test-uid");
      expect(response.body.user).toHaveProperty("email", "test@studio.com");
      expect(response.body.user).toHaveProperty("studioOwnerId", "doc-id");
    });

    test("should return 400 for invalid email", async () => {
      const invalidData = {
        ...validRegistrationData,
        email: "invalid-email",
      };

      const response = await request(app)
          .post("/v1/auth/register")
          .send(invalidData)
          .expect(400);

      expect(response.body).toHaveProperty("error", "Validation Error");
      expect(response.body).toHaveProperty("errors");
    });

    test("should return 400 for missing required fields", async () => {
      const invalidData = {
        email: "test@studio.com",
        password: "password123",
        // Missing other required fields
      };

      const response = await request(app)
          .post("/v1/auth/register")
          .send(invalidData)
          .expect(400);

      expect(response.body).toHaveProperty("error", "Validation Error");
    });

    test("should handle registration with studio image", async () => {
      const dataWithImage = {
        ...validRegistrationData,
        studioImageFile: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      };

      const mockUserRecord = {
        uid: "test-uid",
        email: "test@studio.com",
      };

      authService.createUser.mockResolvedValue(mockUserRecord);
      authService.createUserDocument.mockResolvedValue("doc-id");
      authService.createCustomToken.mockResolvedValue("custom-token");
      storageService.base64ToBuffer.mockReturnValue(Buffer.from("test"));
      storageService.getMimeTypeFromBase64.mockReturnValue("image/png");
      storageService.uploadStudioImage.mockResolvedValue("https://storage.googleapis.com/test/image.png");

      const response = await request(app)
          .post("/v1/auth/register")
          .send(dataWithImage)
          .expect(201);

      expect(response.body).toHaveProperty("customToken");
      expect(storageService.uploadStudioImage).toHaveBeenCalled();
    });
  });

  describe("POST /v1/auth/login", () => {
    const validLoginData = {
      email: "test@studio.com",
      password: "password123",
    };

    test("should login successfully", async () => {
      const mockUserRecord = {
        uid: "test-uid",
        email: "test@studio.com",
      };

      const mockUserDoc = {
        id: "doc-id",
        exists: true,
        data: () => ({
          roles: ["student", "studio_owner"],
        }),
      };

      authService.verifyPassword.mockResolvedValue({
        idToken: "test-token",
        localId: "test-uid",
      });
      authService.getUserByEmail.mockResolvedValue(mockUserRecord);
      authService.getUserDocumentByAuthUid.mockResolvedValue(mockUserDoc);
      authService.hasStudioOwnerRole.mockReturnValue(true);
      authService.createCustomToken.mockResolvedValue("custom-token");

      const response = await request(app)
          .post("/v1/auth/login")
          .send(validLoginData)
          .expect(200);

      expect(response.body).toHaveProperty("customToken", "custom-token");
      expect(response.body).toHaveProperty("user");
    });

    test("should return 400 for invalid email", async () => {
      const invalidData = {
        email: "invalid-email",
        password: "password123",
      };

      const response = await request(app)
          .post("/v1/auth/login")
          .send(invalidData)
          .expect(400);

      expect(response.body).toHaveProperty("error", "Validation Error");
    });

    test("should return 401 for non-existent user", async () => {
      authService.verifyPassword.mockResolvedValue({
        idToken: "test-token",
        localId: "test-uid",
      });
      authService.getUserByEmail.mockRejectedValue(
          new Error("User not found"),
      );

      const response = await request(app)
          .post("/v1/auth/login")
          .send(validLoginData)
          .expect(401);

      expect(response.body).toHaveProperty("error", "Authentication Failed");
    });

    test("should return 403 for user without studio_owner role", async () => {
      const mockUserRecord = {
        uid: "test-uid",
        email: "test@studio.com",
      };

      const mockUserDoc = {
        id: "doc-id",
        exists: true,
        data: () => ({
          roles: ["student"],
        }),
      };

      authService.verifyPassword.mockResolvedValue({
        idToken: "test-token",
        localId: "test-uid",
      });
      authService.getUserByEmail.mockResolvedValue(mockUserRecord);
      authService.getUserDocumentByAuthUid.mockResolvedValue(mockUserDoc);
      authService.hasStudioOwnerRole.mockReturnValue(false);

      const response = await request(app)
          .post("/v1/auth/login")
          .send(validLoginData)
          .expect(403);

      expect(response.body).toHaveProperty("error", "Access Denied");
    });
  });

  describe("GET /v1/auth/me", () => {
    test("should return user profile with valid token", async () => {
      const mockUser = {
        uid: "test-uid",
        email: "test@studio.com",
      };

      const mockUserDoc = {
        id: "doc-id",
        exists: true,
        data: () => ({
          firstName: "John",
          lastName: "Doe",
          studioName: "Test Studio",
          studioAddressLine1: "123 Main St",
          studioAddressLine2: null,
          city: "New York",
          state: "NY",
          zip: "10001",
          studioImageUrl: null,
          membership: "basic",
          facebook: null,
          instagram: null,
          tiktok: null,
          youtube: null,
          roles: ["student", "studio_owner"],
        }),
      };

      verifyToken.mockImplementation((req, res, next) => {
        req.user = mockUser;
        next();
      });

      authService.getUserDocumentByAuthUid.mockResolvedValue(mockUserDoc);

      const response = await request(app)
          .get("/v1/auth/me")
          .set("Authorization", "Bearer valid-token")
          .expect(200);

      expect(response.body).toHaveProperty("uid", "test-uid");
      expect(response.body).toHaveProperty("email", "test@studio.com");
      expect(response.body).toHaveProperty("profile");
      expect(response.body.profile).toHaveProperty("firstName", "John");
    });

    test("should return 401 without token", async () => {
      verifyToken.mockImplementation((req, res) => {
        return res.status(401).json({
          error: "Unauthorized",
          message: "Missing or invalid authorization header",
        });
      });

      const response = await request(app)
          .get("/v1/auth/me")
          .expect(401);

      expect(response.body).toHaveProperty("error", "Unauthorized");
    });
  });

  describe("POST /v1/auth/logout", () => {
    test("should logout successfully", async () => {
      const mockUser = {
        uid: "test-uid",
        email: "test@studio.com",
      };

      verifyToken.mockImplementation((req, res, next) => {
        req.user = mockUser;
        next();
      });

      const response = await request(app)
          .post("/v1/auth/logout")
          .set("Authorization", "Bearer valid-token")
          .expect(200);

      expect(response.body).toHaveProperty("message", "Logged out successfully");
    });
  });
});


