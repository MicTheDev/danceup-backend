import { getStorage } from "firebase-admin/storage";
import type { Bucket } from "@google-cloud/storage";

const ALLOWED_MIME_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
const MAX_SIZE = 5 * 1024 * 1024; // 5 MB

export class StorageService {
  getBucket(): Bucket {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const admin = require("firebase-admin") as typeof import("firebase-admin");
      const storage = getStorage();
      const app = admin.app();
      const storageBucket =
        (app.options.storageBucket as string | undefined) ??
        (app.options.projectId ? `${app.options.projectId}.appspot.com` : null);
      if (storageBucket) return storage.bucket(storageBucket);
      return storage.bucket();
    } catch (error) {
      console.error("Error getting storage bucket:", error);
      throw new Error("Storage bucket not available. Please configure Firebase Storage in your project.");
    }
  }

  private async uploadImage(
    fileBuffer: Buffer,
    fileName: string,
    mimeType: string,
    storagePath: string,
    context: string,
  ): Promise<string> {
    if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
      throw new Error("Invalid file type. Only JPEG, PNG, and WebP images are allowed");
    }
    if (fileBuffer.length > MAX_SIZE) {
      throw new Error("File size exceeds 5MB limit");
    }
    const timestamp = Date.now();
    const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, "_");
    const storageFileName = `${storagePath}/${timestamp}-${sanitizedFileName}`;
    const bucket = this.getBucket();
    const file = bucket.file(storageFileName);
    await file.save(fileBuffer, { metadata: { contentType: mimeType } });
    await file.makePublic();
    return `https://storage.googleapis.com/${bucket.name}/${storageFileName}`;
  }

  async uploadStudioImage(fileBuffer: Buffer, fileName: string, mimeType: string): Promise<string> {
    try {
      return await this.uploadImage(fileBuffer, fileName, mimeType, "studio-images", "studio image");
    } catch (error) {
      const err = error as Error;
      console.error("Error uploading studio image:", err);
      if (err.message.includes("Invalid file type") || err.message.includes("File size")) throw err;
      throw new Error("Failed to upload studio image");
    }
  }

  async deleteFile(fileUrl: string): Promise<void> {
    try {
      let filePath = fileUrl;
      if (fileUrl.includes("storage.googleapis.com")) {
        const urlParts = fileUrl.split("/");
        const bucketIndex = urlParts.findIndex((part) => part.includes("firebasestorage"));
        if (bucketIndex !== -1) {
          filePath = urlParts.slice(bucketIndex + 1).join("/");
        }
      }
      const bucket = this.getBucket();
      await bucket.file(filePath).delete();
    } catch (error) {
      console.error("Error deleting file:", error);
      // Don't throw — file might not exist
    }
  }

  base64ToBuffer(base64String: string): Buffer {
    const base64Data = base64String.replace(/^data:image\/\w+;base64,/, "");
    return Buffer.from(base64Data, "base64");
  }

  getMimeTypeFromBase64(base64String: string): string {
    const match = base64String.match(/^data:([^;]+);base64,/);
    return match?.[1] ?? "image/png";
  }

  async uploadInstructorPhoto(fileBuffer: Buffer, fileName: string, mimeType: string): Promise<string> {
    try {
      return await this.uploadImage(fileBuffer, fileName, mimeType, "instructor-photos", "instructor photo");
    } catch (error) {
      const err = error as Error;
      console.error("Error uploading instructor photo:", err);
      if (err.message.includes("Invalid file type") || err.message.includes("File size")) throw err;
      throw new Error("Failed to upload instructor photo");
    }
  }

  async uploadWorkshopImage(
    fileBuffer: Buffer, fileName: string, mimeType: string, studioOwnerId: string, workshopId: string,
  ): Promise<string> {
    try {
      return await this.uploadImage(
        fileBuffer, fileName, mimeType, `workshops/${studioOwnerId}/${workshopId}`, "workshop image",
      );
    } catch (error) {
      const err = error as Error;
      console.error("Error uploading workshop image:", err);
      if (err.message.includes("Invalid file type") || err.message.includes("File size") ||
          err.message.includes("Storage bucket not available")) throw err;
      throw new Error(`Failed to upload workshop image: ${err.message}`);
    }
  }

  async uploadClassImage(
    fileBuffer: Buffer, fileName: string, mimeType: string, studioOwnerId: string, classId: string,
  ): Promise<string> {
    try {
      return await this.uploadImage(
        fileBuffer, fileName, mimeType, `classes/${studioOwnerId}/${classId}`, "class image",
      );
    } catch (error) {
      const err = error as Error;
      console.error("Error uploading class image:", err);
      if (err.message.includes("Invalid file type") || err.message.includes("File size")) throw err;
      throw new Error(`Failed to upload class image: ${err.message}`);
    }
  }

  async uploadEventImage(
    fileBuffer: Buffer, fileName: string, mimeType: string, studioOwnerId: string, eventId: string,
  ): Promise<string> {
    try {
      return await this.uploadImage(
        fileBuffer, fileName, mimeType, `events/${studioOwnerId}/${eventId}`, "event image",
      );
    } catch (error) {
      const err = error as Error;
      console.error("Error uploading event image:", err);
      if (err.message.includes("Invalid file type") || err.message.includes("File size") ||
          err.message.includes("Storage bucket not available")) throw err;
      throw new Error(`Failed to upload event image: ${err.message}`);
    }
  }

  async uploadStudentAvatar(fileBuffer: Buffer, fileName: string, mimeType: string, authUid: string): Promise<string> {
    try {
      return await this.uploadImage(
        fileBuffer, fileName, mimeType, `student-avatars/${authUid}`, "student avatar",
      );
    } catch (error) {
      const err = error as Error;
      console.error("Error uploading student avatar:", err);
      if (err.message.includes("Invalid file type") || err.message.includes("File size") ||
          err.message.includes("Storage bucket not available")) throw err;
      throw new Error("Failed to upload student avatar");
    }
  }
}

export default new StorageService();
