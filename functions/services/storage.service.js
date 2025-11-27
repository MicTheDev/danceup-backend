const {getStorage} = require("firebase-admin/storage");

const bucket = getStorage().bucket();

/**
 * Service for handling file uploads to Firebase Storage
 */
class StorageService {
  /**
   * Upload studio image to Firebase Storage
   * @param {Buffer} fileBuffer - File buffer
   * @param {string} fileName - Original file name
   * @param {string} mimeType - File MIME type
   * @returns {Promise<string>} Download URL
   */
  async uploadStudioImage(fileBuffer, fileName, mimeType) {
    try {
      // Validate file type
      const allowedMimeTypes = [
        "image/jpeg",
        "image/jpg",
        "image/png",
        "image/webp",
      ];
      if (!allowedMimeTypes.includes(mimeType)) {
        throw new Error(
            "Invalid file type. Only JPEG, PNG, and WebP images are allowed",
        );
      }

      // Validate file size (max 5MB)
      const maxSize = 5 * 1024 * 1024; // 5MB
      if (fileBuffer.length > maxSize) {
        throw new Error("File size exceeds 5MB limit");
      }

      // Generate unique file name
      const timestamp = Date.now();
      const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, "_");
      const storageFileName = `studio-images/${timestamp}-${sanitizedFileName}`;

      // Upload file
      const file = bucket.file(storageFileName);
      await file.save(fileBuffer, {
        metadata: {
          contentType: mimeType,
        },
      });

      // Make file publicly accessible
      await file.makePublic();

      // Get public URL
      const publicUrl = `https://storage.googleapis.com/${bucket.name}/${storageFileName}`;

      return publicUrl;
    } catch (error) {
      console.error("Error uploading studio image:", error);
      if (error.message.includes("Invalid file type") ||
          error.message.includes("File size")) {
        throw error;
      }
      throw new Error("Failed to upload studio image");
    }
  }

  /**
   * Delete a file from Firebase Storage
   * @param {string} fileUrl - Full file URL or path
   * @returns {Promise<void>}
   */
  async deleteFile(fileUrl) {
    try {
      // Extract file path from URL if full URL is provided
      let filePath = fileUrl;
      if (fileUrl.includes("storage.googleapis.com")) {
        const urlParts = fileUrl.split("/");
        const bucketIndex = urlParts.findIndex((part) =>
          part.includes("firebasestorage"),
        );
        if (bucketIndex !== -1) {
          filePath = urlParts.slice(bucketIndex + 1).join("/");
        }
      }

      const file = bucket.file(filePath);
      await file.delete();
    } catch (error) {
      console.error("Error deleting file:", error);
      // Don't throw - file might not exist
    }
  }

  /**
   * Convert base64 string to buffer
   * @param {string} base64String - Base64 encoded string
   * @returns {Buffer}
   */
  base64ToBuffer(base64String) {
    // Remove data URL prefix if present (e.g., "data:image/png;base64,")
    const base64Data = base64String.replace(
        /^data:image\/\w+;base64,/,
        "",
    );
    return Buffer.from(base64Data, "base64");
  }

  /**
   * Extract MIME type from base64 data URL
   * @param {string} base64String - Base64 encoded string with data URL prefix
   * @returns {string} MIME type
   */
  getMimeTypeFromBase64(base64String) {
    const match = base64String.match(/^data:([^;]+);base64,/);
    return match ? match[1] : "image/png"; // Default to PNG
  }
}

module.exports = new StorageService();


