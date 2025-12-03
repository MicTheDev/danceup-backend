const express = require("express");
const admin = require("firebase-admin");
const authService = require("../services/auth.service");
const storageService = require("../services/storage.service");
const {verifyToken} = require("../middleware/auth.middleware");
const {validateUpdateProfilePayload} = require("../utils/validation");

// eslint-disable-next-line new-cap
const router = express.Router();

/**
 * GET /v1/profile
 * Get current authenticated user's studio profile
 */
router.get("/", verifyToken, async (req, res) => {
  try {
    const {uid} = req.user;

    // Get user document from Firestore
    const userDoc = await authService.getUserDocumentByAuthUid(uid);
    if (!userDoc) {
      return res.status(404).json({
        error: "Not Found",
        message: "User profile not found",
      });
    }

    const userData = userDoc.data();

    // Verify user has studio_owner role
    if (!authService.hasStudioOwnerRole(userDoc)) {
      return res.status(403).json({
        error: "Access Denied",
        message: "This account does not have studio owner access",
      });
    }

    res.json({
      firstName: userData.firstName,
      lastName: userData.lastName,
      studioName: userData.studioName,
      studioAddressLine1: userData.studioAddressLine1,
      studioAddressLine2: userData.studioAddressLine2 || null,
      city: userData.city,
      state: userData.state,
      zip: userData.zip,
      studioImageUrl: userData.studioImageUrl || null,
      facebook: userData.facebook || null,
      instagram: userData.instagram || null,
      tiktok: userData.tiktok || null,
      youtube: userData.youtube || null,
      email: userData.email,
      membership: userData.membership,
    });
  } catch (error) {
    console.error("Get profile error:", error);
    res.status(500).json({
      error: "Internal Server Error",
      message: "Failed to retrieve profile",
    });
  }
});

/**
 * PUT /v1/profile
 * Update current authenticated user's studio profile
 */
router.put("/", verifyToken, async (req, res) => {
  try {
    const {uid} = req.user;

    // Validate input
    const validation = validateUpdateProfilePayload(req.body);
    if (!validation.valid) {
      return res.status(400).json({
        error: "Validation Error",
        message: "Invalid profile data",
        errors: validation.errors,
      });
    }

    // Get user document from Firestore
    const userDoc = await authService.getUserDocumentByAuthUid(uid);
    if (!userDoc) {
      return res.status(404).json({
        error: "Not Found",
        message: "User profile not found",
      });
    }

    // Verify user has studio_owner role
    if (!authService.hasStudioOwnerRole(userDoc)) {
      return res.status(403).json({
        error: "Access Denied",
        message: "This account does not have studio owner access",
      });
    }

    const {
      firstName,
      lastName,
      studioName,
      studioAddressLine1,
      studioAddressLine2,
      city,
      state,
      zip,
      facebook,
      instagram,
      tiktok,
      youtube,
      studioImageFile,
    } = req.body;

    // Handle studio image upload if provided
    let studioImageUrl = null;
    let oldStudioImageUrl = userDoc.data().studioImageUrl || null;

    if (studioImageFile && typeof studioImageFile === "string") {
      try {
        const fileBuffer = storageService.base64ToBuffer(studioImageFile);
        const mimeType = storageService.getMimeTypeFromBase64(studioImageFile);
        const fileName = `studio-image-${uid}.${mimeType.split("/")[1]}`;

        studioImageUrl = await storageService.uploadStudioImage(
            fileBuffer,
            fileName,
            mimeType,
        );

        // Delete old image if it exists and is different from new one
        if (oldStudioImageUrl && oldStudioImageUrl !== studioImageUrl) {
          try {
            await storageService.deleteFile(oldStudioImageUrl);
          } catch (deleteError) {
            console.error("Error deleting old studio image:", deleteError);
            // Continue even if deletion fails
          }
        }
      } catch (imageError) {
        console.error("Error uploading studio image:", imageError);
        return res.status(400).json({
          error: "Image Upload Failed",
          message: imageError.message || "Failed to upload studio image",
        });
      }
    }

    // Prepare update data
    const updateData = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (firstName !== undefined) {
      updateData.firstName = firstName.trim();
    }
    if (lastName !== undefined) {
      updateData.lastName = lastName.trim();
    }
    if (studioName !== undefined) {
      updateData.studioName = studioName.trim();
    }
    if (studioAddressLine1 !== undefined) {
      updateData.studioAddressLine1 = studioAddressLine1.trim();
    }
    if (studioAddressLine2 !== undefined) {
      updateData.studioAddressLine2 = studioAddressLine2 ? studioAddressLine2.trim() : null;
    }
    if (city !== undefined) {
      updateData.city = city.trim();
    }
    if (state !== undefined) {
      updateData.state = state.trim().toUpperCase();
    }
    if (zip !== undefined) {
      updateData.zip = zip.trim();
    }
    if (facebook !== undefined) {
      updateData.facebook = facebook ? facebook.trim() : null;
    }
    if (instagram !== undefined) {
      updateData.instagram = instagram ? instagram.trim() : null;
    }
    if (tiktok !== undefined) {
      updateData.tiktok = tiktok ? tiktok.trim() : null;
    }
    if (youtube !== undefined) {
      updateData.youtube = youtube ? youtube.trim() : null;
    }
    if (studioImageUrl !== null) {
      updateData.studioImageUrl = studioImageUrl;
    }

    // Update Firestore document
    const db = admin.firestore();
    await db.collection("users").doc(userDoc.id).update(updateData);

    // Get updated document
    const updatedDoc = await db.collection("users").doc(userDoc.id).get();
    const updatedData = updatedDoc.data();

    res.json({
      firstName: updatedData.firstName,
      lastName: updatedData.lastName,
      studioName: updatedData.studioName,
      studioAddressLine1: updatedData.studioAddressLine1,
      studioAddressLine2: updatedData.studioAddressLine2 || null,
      city: updatedData.city,
      state: updatedData.state,
      zip: updatedData.zip,
      studioImageUrl: updatedData.studioImageUrl || null,
      facebook: updatedData.facebook || null,
      instagram: updatedData.instagram || null,
      tiktok: updatedData.tiktok || null,
      youtube: updatedData.youtube || null,
      email: updatedData.email,
      membership: updatedData.membership,
    });
  } catch (error) {
    console.error("Update profile error:", error);
    res.status(500).json({
      error: "Internal Server Error",
      message: error.message || "Failed to update profile",
    });
  }
});

module.exports = router;

