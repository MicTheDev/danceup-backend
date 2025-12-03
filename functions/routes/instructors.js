const express = require("express");
const instructorsService = require("../services/instructors.service");
const storageService = require("../services/storage.service");
const {verifyToken} = require("../middleware/auth.middleware");
const {
  validateCreateInstructorPayload,
  validateUpdateInstructorPayload,
} = require("../utils/validation");

// eslint-disable-next-line new-cap
const router = express.Router();

/**
 * GET /v1/instructors
 * Get all instructors for the authenticated studio owner
 */
router.get("/", verifyToken, async (req, res) => {
  try {
    const {uid} = req.user;

    // Get studio owner ID from authenticated user
    const studioOwnerId = await instructorsService.getStudioOwnerId(uid);
    if (!studioOwnerId) {
      return res.status(403).json({
        error: "Access Denied",
        message: "Studio owner not found or insufficient permissions",
      });
    }

    // Get all instructors for this studio owner
    const instructors = await instructorsService.getInstructors(studioOwnerId);

    res.json(instructors);
  } catch (error) {
    console.error("Error getting instructors:", error);
    res.status(500).json({
      error: "Internal Server Error",
      message: error.message || "Failed to retrieve instructors",
    });
  }
});

/**
 * GET /v1/instructors/options
 * Get instructor options for dropdowns (simplified version)
 */
router.get("/options", verifyToken, async (req, res) => {
  try {
    const {uid} = req.user;

    // Get studio owner ID from authenticated user
    const studioOwnerId = await instructorsService.getStudioOwnerId(uid);
    if (!studioOwnerId) {
      return res.status(403).json({
        error: "Access Denied",
        message: "Studio owner not found or insufficient permissions",
      });
    }

    // Get all instructors for this studio owner
    const instructors = await instructorsService.getInstructors(studioOwnerId);

    // Return simplified options
    const options = instructors.map((instructor) => ({
      id: instructor.id,
      name: `${instructor.firstName} ${instructor.lastName}`.trim(),
    }));

    res.json(options);
  } catch (error) {
    console.error("Error getting instructor options:", error);
    res.status(500).json({
      error: "Internal Server Error",
      message: error.message || "Failed to retrieve instructor options",
    });
  }
});

/**
 * GET /v1/instructors/:id
 * Get a single instructor by ID
 */
router.get("/:id", verifyToken, async (req, res) => {
  try {
    const {uid} = req.user;
    const {id} = req.params;

    // Get studio owner ID from authenticated user
    const studioOwnerId = await instructorsService.getStudioOwnerId(uid);
    if (!studioOwnerId) {
      return res.status(403).json({
        error: "Access Denied",
        message: "Studio owner not found or insufficient permissions",
      });
    }

    // Get the instructor
    const instructorData = await instructorsService.getInstructorById(id, studioOwnerId);
    if (!instructorData) {
      return res.status(404).json({
        error: "Not Found",
        message: "Instructor not found",
      });
    }

    res.json(instructorData);
  } catch (error) {
    console.error("Error getting instructor:", error);
    
    // Handle access denied errors
    if (error.message.includes("Access denied")) {
      return res.status(403).json({
        error: "Access Denied",
        message: error.message,
      });
    }

    res.status(500).json({
      error: "Internal Server Error",
      message: error.message || "Failed to retrieve instructor",
    });
  }
});

/**
 * POST /v1/instructors
 * Create a new instructor
 */
router.post("/", verifyToken, async (req, res) => {
  try {
    const {uid} = req.user;

    // Extract photo file from payload if present
    const {photoFile, ...instructorData} = req.body;

    // Validate input (excluding photoFile)
    const validation = validateCreateInstructorPayload(instructorData);
    if (!validation.valid) {
      return res.status(400).json({
        error: "Validation Error",
        message: "Invalid instructor data",
        errors: validation.errors,
      });
    }

    // Get studio owner ID from authenticated user
    const studioOwnerId = await instructorsService.getStudioOwnerId(uid);
    if (!studioOwnerId) {
      return res.status(403).json({
        error: "Access Denied",
        message: "Studio owner not found or insufficient permissions",
      });
    }

    // Handle photo upload if provided
    let photoUrl = null;
    if (photoFile && typeof photoFile === "string") {
      try {
        const fileBuffer = storageService.base64ToBuffer(photoFile);
        const mimeType = storageService.getMimeTypeFromBase64(photoFile);
        const fileName = `instructor-${Date.now()}.${mimeType.split("/")[1]}`;

        photoUrl = await storageService.uploadInstructorPhoto(
            fileBuffer,
            fileName,
            mimeType,
        );
      } catch (imageError) {
        console.error("Error uploading instructor photo:", imageError);
        return res.status(400).json({
          error: "File Upload Error",
          message: imageError.message || "Failed to upload instructor photo",
        });
      }
    }

    // Add photoUrl to payload if uploaded
    const payload = photoUrl ? {...instructorData, photoUrl} : instructorData;

    // Create the instructor
    const instructorId = await instructorsService.createInstructor(payload, studioOwnerId);

    res.status(201).json({
      id: instructorId,
      message: "Instructor created successfully",
    });
  } catch (error) {
    console.error("Error creating instructor:", error);
    res.status(500).json({
      error: "Internal Server Error",
      message: error.message || "Failed to create instructor",
    });
  }
});

/**
 * PUT /v1/instructors/:id
 * Update an existing instructor
 */
router.put("/:id", verifyToken, async (req, res) => {
  try {
    const {uid} = req.user;
    const {id} = req.params;

    // Extract photo file from payload if present
    const {photoFile, ...instructorData} = req.body;

    // Validate input (excluding photoFile)
    const validation = validateUpdateInstructorPayload(instructorData);
    if (!validation.valid) {
      return res.status(400).json({
        error: "Validation Error",
        message: "Invalid instructor data",
        errors: validation.errors,
      });
    }

    // Get studio owner ID from authenticated user
    const studioOwnerId = await instructorsService.getStudioOwnerId(uid);
    if (!studioOwnerId) {
      return res.status(403).json({
        error: "Access Denied",
        message: "Studio owner not found or insufficient permissions",
      });
    }

    // Handle photo upload if provided
    let photoUrl = undefined;
    if (photoFile && typeof photoFile === "string") {
      try {
        const fileBuffer = storageService.base64ToBuffer(photoFile);
        const mimeType = storageService.getMimeTypeFromBase64(photoFile);
        const fileName = `instructor-${Date.now()}.${mimeType.split("/")[1]}`;

        photoUrl = await storageService.uploadInstructorPhoto(
            fileBuffer,
            fileName,
            mimeType,
        );
      } catch (imageError) {
        console.error("Error uploading instructor photo:", imageError);
        return res.status(400).json({
          error: "File Upload Error",
          message: imageError.message || "Failed to upload instructor photo",
        });
      }
    }

    // Add photoUrl to payload if uploaded
    const payload = photoUrl !== undefined ? {...instructorData, photoUrl} : instructorData;

    // Update the instructor
    await instructorsService.updateInstructor(id, payload, studioOwnerId);

    res.json({
      message: "Instructor updated successfully",
    });
  } catch (error) {
    console.error("Error updating instructor:", error);
    
    // Handle specific error cases
    if (error.message.includes("not found")) {
      return res.status(404).json({
        error: "Not Found",
        message: error.message,
      });
    }

    if (error.message.includes("Access denied")) {
      return res.status(403).json({
        error: "Access Denied",
        message: error.message,
      });
    }

    res.status(500).json({
      error: "Internal Server Error",
      message: error.message || "Failed to update instructor",
    });
  }
});

/**
 * DELETE /v1/instructors/:id
 * Delete an instructor
 */
router.delete("/:id", verifyToken, async (req, res) => {
  try {
    const {uid} = req.user;
    const {id} = req.params;

    // Get studio owner ID from authenticated user
    const studioOwnerId = await instructorsService.getStudioOwnerId(uid);
    if (!studioOwnerId) {
      return res.status(403).json({
        error: "Access Denied",
        message: "Studio owner not found or insufficient permissions",
      });
    }

    // Delete the instructor
    await instructorsService.deleteInstructor(id, studioOwnerId);

    res.json({
      message: "Instructor deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting instructor:", error);
    
    // Handle specific error cases
    if (error.message.includes("not found")) {
      return res.status(404).json({
        error: "Not Found",
        message: error.message,
      });
    }

    if (error.message.includes("Access denied")) {
      return res.status(403).json({
        error: "Access Denied",
        message: error.message,
      });
    }

    res.status(500).json({
      error: "Internal Server Error",
      message: error.message || "Failed to delete instructor",
    });
  }
});

module.exports = router;



