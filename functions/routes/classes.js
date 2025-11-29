const express = require("express");
const classesService = require("../services/classes.service");
const {verifyToken} = require("../middleware/auth.middleware");
const {
  validateCreateClassPayload,
  validateUpdateClassPayload,
} = require("../utils/validation");

// eslint-disable-next-line new-cap
const router = express.Router();

/**
 * GET /v1/classes
 * Get all classes for the authenticated studio owner
 */
router.get("/", verifyToken, async (req, res) => {
  try {
    const {uid} = req.user;

    // Get studio owner ID from authenticated user
    const studioOwnerId = await classesService.getStudioOwnerId(uid);
    if (!studioOwnerId) {
      return res.status(403).json({
        error: "Access Denied",
        message: "Studio owner not found or insufficient permissions",
      });
    }

    // Get all classes for this studio owner
    const classes = await classesService.getClasses(studioOwnerId);

    res.json(classes);
  } catch (error) {
    console.error("Error getting classes:", error);
    res.status(500).json({
      error: "Internal Server Error",
      message: error.message || "Failed to retrieve classes",
    });
  }
});

/**
 * GET /v1/classes/:id
 * Get a single class by ID
 */
router.get("/:id", verifyToken, async (req, res) => {
  try {
    const {uid} = req.user;
    const {id} = req.params;

    // Get studio owner ID from authenticated user
    const studioOwnerId = await classesService.getStudioOwnerId(uid);
    if (!studioOwnerId) {
      return res.status(403).json({
        error: "Access Denied",
        message: "Studio owner not found or insufficient permissions",
      });
    }

    // Get the class
    const classData = await classesService.getClassById(id, studioOwnerId);
    if (!classData) {
      return res.status(404).json({
        error: "Not Found",
        message: "Class not found",
      });
    }

    res.json(classData);
  } catch (error) {
    console.error("Error getting class:", error);
    
    // Handle access denied errors
    if (error.message.includes("Access denied")) {
      return res.status(403).json({
        error: "Access Denied",
        message: error.message,
      });
    }

    res.status(500).json({
      error: "Internal Server Error",
      message: error.message || "Failed to retrieve class",
    });
  }
});

/**
 * POST /v1/classes
 * Create a new class
 */
router.post("/", verifyToken, async (req, res) => {
  try {
    const {uid} = req.user;

    // Validate input
    const validation = validateCreateClassPayload(req.body);
    if (!validation.valid) {
      return res.status(400).json({
        error: "Validation Error",
        message: "Invalid class data",
        errors: validation.errors,
      });
    }

    // Get studio owner ID from authenticated user
    const studioOwnerId = await classesService.getStudioOwnerId(uid);
    if (!studioOwnerId) {
      return res.status(403).json({
        error: "Access Denied",
        message: "Studio owner not found or insufficient permissions",
      });
    }

    // Create the class
    const classId = await classesService.createClass(req.body, studioOwnerId);

    res.status(201).json({
      id: classId,
      message: "Class created successfully",
    });
  } catch (error) {
    console.error("Error creating class:", error);
    res.status(500).json({
      error: "Internal Server Error",
      message: error.message || "Failed to create class",
    });
  }
});

/**
 * PUT /v1/classes/:id
 * Update an existing class
 */
router.put("/:id", verifyToken, async (req, res) => {
  try {
    const {uid} = req.user;
    const {id} = req.params;

    // Validate input
    const validation = validateUpdateClassPayload(req.body);
    if (!validation.valid) {
      return res.status(400).json({
        error: "Validation Error",
        message: "Invalid class data",
        errors: validation.errors,
      });
    }

    // Get studio owner ID from authenticated user
    const studioOwnerId = await classesService.getStudioOwnerId(uid);
    if (!studioOwnerId) {
      return res.status(403).json({
        error: "Access Denied",
        message: "Studio owner not found or insufficient permissions",
      });
    }

    // Update the class
    await classesService.updateClass(id, req.body, studioOwnerId);

    res.json({
      message: "Class updated successfully",
    });
  } catch (error) {
    console.error("Error updating class:", error);
    
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
      message: error.message || "Failed to update class",
    });
  }
});

/**
 * DELETE /v1/classes/:id
 * Delete a class
 */
router.delete("/:id", verifyToken, async (req, res) => {
  try {
    const {uid} = req.user;
    const {id} = req.params;

    // Get studio owner ID from authenticated user
    const studioOwnerId = await classesService.getStudioOwnerId(uid);
    if (!studioOwnerId) {
      return res.status(403).json({
        error: "Access Denied",
        message: "Studio owner not found or insufficient permissions",
      });
    }

    // Delete the class
    await classesService.deleteClass(id, studioOwnerId);

    res.json({
      message: "Class deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting class:", error);
    
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
      message: error.message || "Failed to delete class",
    });
  }
});

module.exports = router;

