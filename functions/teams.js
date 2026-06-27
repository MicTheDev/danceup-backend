const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const authService = require("./services/auth.service");
const storageService = require("./services/storage.service");
const {verifyToken} = require("./utils/auth");
const {getFirestore} = require("./utils/firestore");
const {
  sendJsonResponse,
  sendErrorResponse,
  handleError,
  corsOptions,
  isAllowedOrigin,
  applySecurityMiddleware,
} = require("./utils/http");

const VALID_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const TIME_REGEX = /^([0-1][0-9]|2[0-3]):[0-5][0-9]$/;

if (!admin.apps.length) {
  admin.initializeApp();
}

const app = express();

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.setHeader("Access-Control-Expose-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "3600");
  if (req.method === "OPTIONS") return res.status(204).send("");
  next();
});

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json());
applySecurityMiddleware(app);
app.use(express.urlencoded({extended: true}));

function validatePracticeSchedule(schedule) {
  if (!Array.isArray(schedule)) return "practiceSchedule must be an array";
  for (const slot of schedule) {
    if (!VALID_DAYS.includes(slot.dayOfWeek)) {
      return `Invalid dayOfWeek: ${slot.dayOfWeek}`;
    }
    if (!TIME_REGEX.test(slot.startTime)) {
      return "startTime must be in HH:mm format";
    }
    if (!TIME_REGEX.test(slot.endTime)) {
      return "endTime must be in HH:mm format";
    }
  }
  return null;
}

/**
 * GET /
 * List all performance teams for the authenticated studio owner
 */
app.get("/", async (req, res) => {
  try {
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const userDoc = await authService.getUserDocumentByAuthUid(user.uid);
    if (!userDoc) {
      return sendErrorResponse(req, res, 404, "Not Found", "User profile not found");
    }
    if (!authService.hasStudioOwnerRole(userDoc)) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner access required");
    }

    const db = getFirestore();
    const snapshot = await db.collection("performanceTeams")
        .where("studioOwnerId", "==", userDoc.id)
        .orderBy("createdAt", "desc")
        .get();

    const teams = [];
    snapshot.forEach((doc) => {
      const data = doc.data();
      teams.push({
        id: doc.id,
        name: data.name,
        description: data.description || null,
        imageUrl: data.imageUrl || null,
        memberIds: data.memberIds || [],
        memberCount: (data.memberIds || []).length,
        practiceSchedule: data.practiceSchedule || [],
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
      });
    });

    sendJsonResponse(req, res, 200, teams);
  } catch (error) {
    console.error("Get teams error:", error);
    handleError(req, res, error);
  }
});

/**
 * POST /
 * Create a new performance team
 */
app.post("/", async (req, res) => {
  try {
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const userDoc = await authService.getUserDocumentByAuthUid(user.uid);
    if (!userDoc) {
      return sendErrorResponse(req, res, 404, "Not Found", "User profile not found");
    }
    if (!authService.hasStudioOwnerRole(userDoc)) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner access required");
    }

    const {name, description, memberIds, practiceSchedule, teamImageFile} = req.body;

    if (!name || typeof name !== "string" || !name.trim()) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Team name is required");
    }
    if (!Array.isArray(memberIds)) {
      return sendErrorResponse(req, res, 400, "Validation Error", "memberIds must be an array");
    }
    const scheduleError = validatePracticeSchedule(practiceSchedule || []);
    if (scheduleError) {
      return sendErrorResponse(req, res, 400, "Validation Error", scheduleError);
    }

    let imageUrl = null;
    if (teamImageFile && typeof teamImageFile === "string") {
      try {
        const fileBuffer = storageService.base64ToBuffer(teamImageFile);
        const mimeType = storageService.getMimeTypeFromBase64(teamImageFile);
        const fileName = `team-image-${user.uid}-${Date.now()}.${mimeType.split("/")[1]}`;
        imageUrl = await storageService.uploadStudioImage(fileBuffer, fileName, mimeType);
      } catch (imgErr) {
        return sendErrorResponse(req, res, 400, "Image Upload Failed", imgErr.message || "Failed to upload team image");
      }
    }

    const db = getFirestore();
    const teamData = {
      studioOwnerId: userDoc.id,
      name: name.trim(),
      description: description ? description.trim() : null,
      imageUrl,
      memberIds: memberIds.filter((id) => typeof id === "string" && id.trim()),
      practiceSchedule: practiceSchedule || [],
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const docRef = await db.collection("performanceTeams").add(teamData);

    sendJsonResponse(req, res, 201, {id: docRef.id, ...teamData});
  } catch (error) {
    console.error("Create team error:", error);
    handleError(req, res, error);
  }
});

/**
 * GET /:id
 * Get a single team with enriched member data
 */
app.get("/:id", async (req, res) => {
  try {
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const userDoc = await authService.getUserDocumentByAuthUid(user.uid);
    if (!userDoc) {
      return sendErrorResponse(req, res, 404, "Not Found", "User profile not found");
    }
    if (!authService.hasStudioOwnerRole(userDoc)) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner access required");
    }

    const db = getFirestore();
    const teamDoc = await db.collection("performanceTeams").doc(req.params.id).get();

    if (!teamDoc.exists) {
      return sendErrorResponse(req, res, 404, "Not Found", "Team not found");
    }

    const teamData = teamDoc.data();
    if (teamData.studioOwnerId !== userDoc.id) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Team does not belong to this studio");
    }

    // Enrich with member details from students collection
    const memberIds = teamData.memberIds || [];
    const members = [];
    if (memberIds.length > 0) {
      const studentsSnapshot = await db.collection("students")
          .where("studioOwnerId", "==", userDoc.id)
          .get();
      const studentMap = {};
      studentsSnapshot.forEach((doc) => {
        studentMap[doc.id] = {id: doc.id, ...doc.data()};
      });
      for (const memberId of memberIds) {
        if (studentMap[memberId]) {
          const s = studentMap[memberId];
          members.push({
            id: memberId,
            firstName: s.firstName || "",
            lastName: s.lastName || "",
            email: s.email || null,
            lastAttendedAt: s.lastAttendedAt || null,
          });
        }
      }
    }

    sendJsonResponse(req, res, 200, {
      id: teamDoc.id,
      studioOwnerId: teamData.studioOwnerId,
      name: teamData.name,
      description: teamData.description || null,
      imageUrl: teamData.imageUrl || null,
      memberIds,
      memberCount: memberIds.length,
      practiceSchedule: teamData.practiceSchedule || [],
      members,
      createdAt: teamData.createdAt,
      updatedAt: teamData.updatedAt,
    });
  } catch (error) {
    console.error("Get team error:", error);
    handleError(req, res, error);
  }
});

/**
 * PUT /:id
 * Update a performance team
 */
app.put("/:id", async (req, res) => {
  try {
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const userDoc = await authService.getUserDocumentByAuthUid(user.uid);
    if (!userDoc) {
      return sendErrorResponse(req, res, 404, "Not Found", "User profile not found");
    }
    if (!authService.hasStudioOwnerRole(userDoc)) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner access required");
    }

    const db = getFirestore();
    const teamDoc = await db.collection("performanceTeams").doc(req.params.id).get();
    if (!teamDoc.exists) {
      return sendErrorResponse(req, res, 404, "Not Found", "Team not found");
    }
    if (teamDoc.data().studioOwnerId !== userDoc.id) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Team does not belong to this studio");
    }

    const {name, description, memberIds, practiceSchedule, teamImageFile} = req.body;

    const updateData = {updatedAt: admin.firestore.FieldValue.serverTimestamp()};

    if (name !== undefined) {
      if (!name || typeof name !== "string" || !name.trim()) {
        return sendErrorResponse(req, res, 400, "Validation Error", "Team name cannot be empty");
      }
      updateData.name = name.trim();
    }
    if (description !== undefined) {
      updateData.description = description ? description.trim() : null;
    }
    if (memberIds !== undefined) {
      if (!Array.isArray(memberIds)) {
        return sendErrorResponse(req, res, 400, "Validation Error", "memberIds must be an array");
      }
      updateData.memberIds = memberIds.filter((id) => typeof id === "string" && id.trim());
    }
    if (practiceSchedule !== undefined) {
      const scheduleError = validatePracticeSchedule(practiceSchedule);
      if (scheduleError) {
        return sendErrorResponse(req, res, 400, "Validation Error", scheduleError);
      }
      updateData.practiceSchedule = practiceSchedule;
    }
    if (teamImageFile && typeof teamImageFile === "string") {
      try {
        const fileBuffer = storageService.base64ToBuffer(teamImageFile);
        const mimeType = storageService.getMimeTypeFromBase64(teamImageFile);
        const fileName = `team-image-${user.uid}-${Date.now()}.${mimeType.split("/")[1]}`;
        updateData.imageUrl = await storageService.uploadStudioImage(fileBuffer, fileName, mimeType);
        const oldUrl = teamDoc.data().imageUrl;
        if (oldUrl && oldUrl !== updateData.imageUrl) {
          storageService.deleteFile(oldUrl).catch((e) => console.error("Error deleting old team image:", e));
        }
      } catch (imgErr) {
        return sendErrorResponse(req, res, 400, "Image Upload Failed", imgErr.message || "Failed to upload team image");
      }
    }

    await db.collection("performanceTeams").doc(req.params.id).update(updateData);
    const updated = await db.collection("performanceTeams").doc(req.params.id).get();
    const data = updated.data();

    sendJsonResponse(req, res, 200, {
      id: updated.id,
      studioOwnerId: data.studioOwnerId,
      name: data.name,
      description: data.description || null,
      imageUrl: data.imageUrl || null,
      memberIds: data.memberIds || [],
      memberCount: (data.memberIds || []).length,
      practiceSchedule: data.practiceSchedule || [],
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    });
  } catch (error) {
    console.error("Update team error:", error);
    handleError(req, res, error);
  }
});

/**
 * DELETE /:id
 * Delete a performance team
 */
app.delete("/:id", async (req, res) => {
  try {
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const userDoc = await authService.getUserDocumentByAuthUid(user.uid);
    if (!userDoc) {
      return sendErrorResponse(req, res, 404, "Not Found", "User profile not found");
    }
    if (!authService.hasStudioOwnerRole(userDoc)) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner access required");
    }

    const db = getFirestore();
    const teamDoc = await db.collection("performanceTeams").doc(req.params.id).get();
    if (!teamDoc.exists) {
      return sendErrorResponse(req, res, 404, "Not Found", "Team not found");
    }
    if (teamDoc.data().studioOwnerId !== userDoc.id) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Team does not belong to this studio");
    }

    const imageUrl = teamDoc.data().imageUrl;
    await db.collection("performanceTeams").doc(req.params.id).delete();
    if (imageUrl) {
      storageService.deleteFile(imageUrl).catch((e) => console.error("Error deleting team image:", e));
    }

    sendJsonResponse(req, res, 200, {message: "Team deleted successfully"});
  } catch (error) {
    console.error("Delete team error:", error);
    handleError(req, res, error);
  }
});

app.use((err, req, res, next) => {
  console.error("Error:", err);
  handleError(req, res, err);
});

exports.teams = functions.https.onRequest(app);
