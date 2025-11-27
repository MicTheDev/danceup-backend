const request = require("supertest");

// Mock Firebase Functions
jest.mock("firebase-functions", () => ({
  https: {
    onRequest: (handler) => handler,
  },
}));

jest.mock("firebase-admin", () => ({
  initializeApp: jest.fn(),
  apps: [],
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

// Import app after mocks
const {app} = require("../index");

describe("Health Check Endpoint", () => {
  test("GET /health should return 200 with status ok", async () => {
    const response = await request(app)
        .get("/health")
        .expect(200);

    expect(response.body).toHaveProperty("status", "ok");
    expect(response.body).toHaveProperty("timestamp");
    expect(response.body).toHaveProperty("service", "danceup-backend");
    expect(new Date(response.body.timestamp)).toBeInstanceOf(Date);
  });
});

describe("404 Handler", () => {
  test("GET /nonexistent should return 404", async () => {
    const response = await request(app)
        .get("/nonexistent")
        .expect(404);

    expect(response.body).toHaveProperty("error", "Not Found");
    expect(response.body).toHaveProperty("message");
  });
});

