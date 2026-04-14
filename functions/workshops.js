const functions = require("firebase-functions");
const express = require("express");
const cors = require("cors");
const workshopsService = require("./services/workshops.service");
const storageService = require("./services/storage.service");
const {verifyToken} = require("./utils/auth");
const {
  validateCreateWorkshopPayload,
  validateUpdateWorkshopPayload,
} = require("./utils/validation");
const {
  sendJsonResponse,
  sendErrorResponse,
  handleError,
  corsOptions,
  isAllowedOrigin,
} = require("./utils/http");

// Initialize Express app
const app = express();

// CORS — only reflect origin if it is in the allowlist
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
app.use(express.urlencoded({extended: true}));


/**
 * GET /public
 * Get all public workshops with optional filters (no authentication required)
 */
app.get("/public", async (req, res) => {
  try {
    // Extract filter parameters from query string
    const filters = {
      level: req.query.level || null,
      city: req.query.city || null,
      state: req.query.state || null,
      studioName: req.query.studioName || null,
      minPrice: req.query.minPrice ? parseFloat(req.query.minPrice) : null,
      maxPrice: req.query.maxPrice ? parseFloat(req.query.maxPrice) : null,
      startDate: req.query.startDate || null,
      endDate: req.query.endDate || null,
      lat: req.query.lat ? parseFloat(req.query.lat) : null,
      lng: req.query.lng ? parseFloat(req.query.lng) : null,
      radius: req.query.radius ? parseFloat(req.query.radius) : null,
      limit: req.query.limit ? parseInt(req.query.limit, 10) : null,
    };

    // Get all public workshops with filters
    const workshops = await workshopsService.getAllPublicWorkshops(filters);

    sendJsonResponse(req, res, 200, workshops);
  } catch (error) {
    console.error("Error getting public workshops:", error);
    handleError(req, res, error);
  }
});


/**
 * GET /public/:id
 * Get a single public workshop by ID (no authentication required)
 */
app.get("/public/:id", async (req, res) => {
  try {
    const {id} = req.params;

    // Get the workshop
    const workshopData = await workshopsService.getPublicWorkshopById(id);
    if (!workshopData) {
      return sendErrorResponse(req, res, 404, "Not Found", "Workshop not found or not available");
    }

    sendJsonResponse(req, res, 200, workshopData);
  } catch (error) {
    console.error("Error getting public workshop:", error);
    handleError(req, res, error);
  }
});

/**
 * GET /
 * Get all workshops for the authenticated studio owner
 */
app.get("/", async (req, res) => {
  try {
    // Verify token and get user info
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    // Get studio owner ID from authenticated user
    const studioOwnerId = await workshopsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    // Get all workshops for this studio owner
    const workshops = await workshopsService.getWorkshops(studioOwnerId);

    sendJsonResponse(req, res, 200, workshops);
  } catch (error) {
    console.error("Error getting workshops:", error);
    handleError(req, res, error);
  }
});

/**
 * POST /
 * Create a new workshop
 */
app.post("/", async (req, res) => {
  try {
    // Verify token and get user info
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    // Extract image file from payload if present
    const {imageFile, ...workshopData} = req.body;

    // Validate input (excluding imageFile)
    const validation = validateCreateWorkshopPayload(req.body);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid workshop data", {
        errors: validation.errors,
      });
    }

    // Get studio owner ID from authenticated user
    const studioOwnerId = await workshopsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    // Create the workshop first to get the ID
    const workshopId = await workshopsService.createWorkshop(workshopData, studioOwnerId);

    // Handle image upload if provided
    let imageUrl = null;
    if (imageFile && typeof imageFile === "string") {
      try {
        const fileBuffer = storageService.base64ToBuffer(imageFile);
        const mimeType = storageService.getMimeTypeFromBase64(imageFile);
        // Extract file extension from mimeType (e.g., "image/png" -> "png")
        const extension = mimeType.split("/")[1] || "jpg";
        const fileName = `workshop-${Date.now()}.${extension}`;

        imageUrl = await storageService.uploadWorkshopImage(
            fileBuffer,
            fileName,
            mimeType,
            studioOwnerId,
            workshopId,
        );

        // Update the workshop with the image URL
        await workshopsService.updateWorkshop(workshopId, {imageUrl}, studioOwnerId);
      } catch (imageError) {
        console.error("Error uploading workshop image:", imageError);
        console.error("Image upload error details:", {
          message: imageError.message,
          stack: imageError.stack,
          studioOwnerId,
          workshopId,
        });
        // Continue without image - workshop is still created
      }
    }

    sendJsonResponse(req, res, 201, {
      id: workshopId,
      message: "Workshop created successfully",
    });
  } catch (error) {
    console.error("Error creating workshop:", error);
    handleError(req, res, error);
  }
});

/**
 * GET /:id/attendees
 * Get attendees (purchases) for a workshop.
 */
app.get("/:id/attendees", async (req, res) => {
  try {
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }
    const {id} = req.params;
    const {getFirestore} = require("./utils/firestore");
    const db = getFirestore();
    const studioOwnerId = await workshopsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }
    const workshopData = await workshopsService.getWorkshopById(id, studioOwnerId);
    if (!workshopData) {
      return sendErrorResponse(req, res, 404, "Not Found", "Workshop not found");
    }

    // Query all completed purchases for this workshop
    const purchasesSnapshot = await db.collection("purchases")
        .where("purchaseType", "==", "workshop")
        .where("itemId", "==", id)
        .where("studioOwnerId", "==", studioOwnerId)
        .where("status", "==", "completed")
        .get();

    const attendees = [];
    for (const doc of purchasesSnapshot.docs) {
      const purchase = doc.data();

      let firstName = "";
      let lastName = "";
      let email = "";
      let city = null;
      let state = null;
      let zip = null;
      let isGuest = !purchase.studentId || purchase.studentId === "guest";

      // Look up student record for name/email
      if (purchase.studentId && purchase.studentId !== "guest") {
        try {
          const studentDoc = await db.collection("students").doc(purchase.studentId).get();
          if (studentDoc.exists) {
            const s = studentDoc.data();
            firstName = s.firstName || "";
            lastName = s.lastName || "";
            email = s.email || "";
            city = s.city || null;
            state = s.state || null;
            zip = s.zip || null;
          }
        } catch (err) {
          console.error(`Error fetching student ${purchase.studentId}:`, err);
        }
      }

      // Fallback to the user's profile document if no student record
      if (!firstName && !email && purchase.authUid && purchase.authUid !== "guest") {
        try {
          const userSnapshot = await db.collection("users")
              .where("authUid", "==", purchase.authUid)
              .limit(1)
              .get();
          if (!userSnapshot.empty) {
            const u = userSnapshot.docs[0].data();
            firstName = firstName || u.firstName || "";
            lastName = lastName || u.lastName || "";
            email = email || u.email || "";
          }
        } catch (err) {
          console.error(`Error fetching user profile ${purchase.authUid}:`, err);
        }
      }

      attendees.push({
        id: doc.id,
        purchaseId: doc.id,
        firstName,
        lastName,
        email,
        city,
        state,
        zip,
        priceTierName: null,
        priceTierPrice: purchase.price || null,
        price: purchase.price || 0,
        purchaseDate: purchase.createdAt || null,
        checkedIn: purchase.checkedIn || false,
        checkedInAt: purchase.checkedInAt || null,
        checkedInBy: purchase.checkedInBy || null,
        eventCode: null,
        stripePaymentIntentId: purchase.stripePaymentIntentId || null,
        isGuest,
      });
    }

    sendJsonResponse(req, res, 200, attendees);
  } catch (error) {
    console.error("Error getting workshop attendees:", error);
    handleError(req, res, error);
  }
});

/**
 * GET /:id/report
 * Get workshop report: ticket sales by tier, revenue, and check-in counts.
 */
app.get("/:id/report", async (req, res) => {
  try {
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }
    const {id} = req.params;
    const {getFirestore} = require("./utils/firestore");
    const db = getFirestore();

    const studioOwnerId = await workshopsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }
    const workshopData = await workshopsService.getWorkshopById(id, studioOwnerId);
    if (!workshopData) {
      return sendErrorResponse(req, res, 404, "Not Found", "Workshop not found");
    }

    // Fetch all completed purchases for this workshop
    const purchasesSnapshot = await db.collection("purchases")
        .where("purchaseType", "==", "workshop")
        .where("itemId", "==", id)
        .where("studioOwnerId", "==", studioOwnerId)
        .where("status", "==", "completed")
        .get();

    const purchases = purchasesSnapshot.docs.map((d) => d.data());
    const totalTickets = purchases.length;
    const totalRevenue = purchases.reduce((sum, p) => sum + (p.price || 0), 0);
    const checkedInCount = purchases.filter((p) => p.checkedIn === true).length;

    // Map price tiers from the workshop definition and tally actual sales by
    // matching each purchase's price against a tier price (best-effort, since
    // tier name is not stored on the purchase record).
    const priceTiers = workshopData.priceTiers || [];
    const tierMap = new Map();
    for (const tier of priceTiers) {
      tierMap.set(tier.price, {
        tierName: tier.name || "Tier",
        quantity: 0,
        revenue: 0,
      });
    }

    // If there are no defined tiers (shouldn't happen) fall back to a single bucket
    const fallback = {tierName: "General", quantity: 0, revenue: 0};

    for (const purchase of purchases) {
      const price = purchase.price || 0;
      if (tierMap.has(price)) {
        const entry = tierMap.get(price);
        entry.quantity += 1;
        entry.revenue += price;
      } else {
        // Price doesn't match any known tier — put in fallback bucket
        fallback.quantity += 1;
        fallback.revenue += price;
      }
    }

    const ticketSalesByTier = [...tierMap.values()];
    if (fallback.quantity > 0) {
      ticketSalesByTier.push(fallback);
    }

    const report = {
      workshopId: id,
      name: workshopData.name || "Workshop",
      attendeesCount: totalTickets,
      checkedInCount,
      ticketSalesByTier,
      totalTickets,
      totalRevenue,
    };
    sendJsonResponse(req, res, 200, report);
  } catch (error) {
    console.error("Error getting workshop report:", error);
    handleError(req, res, error);
  }
});

/**
 * GET /:id
 * Get a single workshop by ID
 */
app.get("/:id", async (req, res) => {
  try {
    // Verify token and get user info
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const {id} = req.params;

    // Get studio owner ID from authenticated user
    const studioOwnerId = await workshopsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    // Get the workshop
    const workshopData = await workshopsService.getWorkshopById(id, studioOwnerId);
    if (!workshopData) {
      return sendErrorResponse(req, res, 404, "Not Found", "Workshop not found");
    }

    sendJsonResponse(req, res, 200, workshopData);
  } catch (error) {
    console.error("Error getting workshop:", error);
    
    // Handle access denied errors
    if (error.message?.includes("Access denied")) {
      return sendErrorResponse(req, res, 403, "Access Denied", error.message);
    }

    handleError(req, res, error);
  }
});

/**
 * PUT /:id
 * Update an existing workshop
 */
app.put("/:id", async (req, res) => {
  try {
    // Verify token and get user info
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const {id} = req.params;

    // Extract image file from payload if present
    const {imageFile, ...workshopData} = req.body;

    // Validate input (excluding imageFile)
    const validation = validateUpdateWorkshopPayload(req.body);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid workshop data", {
        errors: validation.errors,
      });
    }

    // Get studio owner ID from authenticated user
    const studioOwnerId = await workshopsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    // Handle image upload if provided
    let imageUrl = undefined;
    if (imageFile && typeof imageFile === "string") {
      try {
        const fileBuffer = storageService.base64ToBuffer(imageFile);
        const mimeType = storageService.getMimeTypeFromBase64(imageFile);
        // Extract file extension from mimeType (e.g., "image/png" -> "png")
        const extension = mimeType.split("/")[1] || "jpg";
        const fileName = `workshop-${Date.now()}.${extension}`;

        imageUrl = await storageService.uploadWorkshopImage(
            fileBuffer,
            fileName,
            mimeType,
            studioOwnerId,
            id,
        );
      } catch (imageError) {
        console.error("Error uploading workshop image:", imageError);
        console.error("Image upload error details:", {
          message: imageError.message,
          stack: imageError.stack,
          studioOwnerId,
          workshopId: id,
        });
        return sendErrorResponse(req, res, 400, "File Upload Error", imageError.message || "Failed to upload workshop image");
      }
    }

    // Add imageUrl to payload if uploaded
    const payload = imageUrl !== undefined ? {...workshopData, imageUrl} : workshopData;

    // Update the workshop
    await workshopsService.updateWorkshop(id, payload, studioOwnerId);

    sendJsonResponse(req, res, 200, {
      message: "Workshop updated successfully",
    });
  } catch (error) {
    console.error("Error updating workshop:", error);
    
    // Handle specific error cases
    if (error.message?.includes("not found")) {
      return sendErrorResponse(req, res, 404, "Not Found", error.message);
    }

    if (error.message?.includes("Access denied")) {
      return sendErrorResponse(req, res, 403, "Access Denied", error.message);
    }

    handleError(req, res, error);
  }
});

/**
 * DELETE /:id
 * Delete a workshop
 */
app.delete("/:id", async (req, res) => {
  try {
    // Verify token and get user info
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const {id} = req.params;

    // Get studio owner ID from authenticated user
    const studioOwnerId = await workshopsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    // Delete the workshop
    await workshopsService.deleteWorkshop(id, studioOwnerId);

    sendJsonResponse(req, res, 200, {
      message: "Workshop deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting workshop:", error);
    
    // Handle specific error cases
    if (error.message?.includes("not found")) {
      return sendErrorResponse(req, res, 404, "Not Found", error.message);
    }

    if (error.message?.includes("Access denied")) {
      return sendErrorResponse(req, res, 403, "Access Denied", error.message);
    }

    handleError(req, res, error);
  }
});

/**
 * GET /upcoming
 * Get upcoming workshops for the authenticated studio owner (startDate >= today)
 */
app.get("/upcoming", async (req, res) => {
  try {
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const studioOwnerId = await workshopsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const {getFirestore} = require("./utils/firestore");
    const db = getFirestore();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const snapshot = await db.collection("workshops")
        .where("studioOwnerId", "==", studioOwnerId)
        .get();

    const workshops = [];
    snapshot.forEach((doc) => {
      const data = doc.data();
      const startRaw = data.startTime;
      const startDate = startRaw?.toDate ? startRaw.toDate() : (startRaw ? new Date(startRaw) : null);
      if (startDate && startDate >= today) {
        workshops.push({
          id: doc.id,
          ...data,
          startTime: startDate.toISOString(),
          endTime: data.endTime?.toDate ? data.endTime.toDate().toISOString() : (data.endTime || null),
        });
      }
    });

    workshops.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
    sendJsonResponse(req, res, 200, workshops);
  } catch (error) {
    console.error("Error getting upcoming workshops:", error);
    handleError(req, res, error);
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Error:", err);
  handleError(req, res, err);
});

// Export Express app as Firebase Function
exports.workshops = functions.https.onRequest(app);

