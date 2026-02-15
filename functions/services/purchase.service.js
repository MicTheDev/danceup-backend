const admin = require("firebase-admin");
const authService = require("./auth.service");
const studentsService = require("./students.service");
const creditTrackingService = require("./credit-tracking.service");
const classesService = require("./classes.service");
const eventsService = require("./events.service");
const workshopsService = require("./workshops.service");
const packagesService = require("./packages.service");
const notificationsService = require("./notifications.service");
const {getFirestore} = require("../utils/firestore");

/**
 * Recursively remove undefined values from an object (Firestore does not allow undefined).
 * @param {Object} obj - Object to sanitize
 * @returns {Object} New object without undefined values
 */
function stripUndefined(obj) {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map((v) => (typeof v === "object" && v !== null ? stripUndefined(v) : v));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    out[k] = typeof v === "object" && v !== null && !Array.isArray(v)
      ? stripUndefined(v) : v;
  }
  return out;
}

/**
 * Unified Purchase Service for handling all purchase types (classes, events, workshops, packages)
 */
class PurchaseService {
  /**
   * Get item details and price based on purchase type
   * @param {string} purchaseType - 'class' | 'event' | 'workshop' | 'package'
   * @param {string} itemId - Item document ID
   * @param {string} studioOwnerId - Studio owner document ID (optional, for validation if needed)
   * @returns {Promise<Object>} Item details with price, name, and metadata
   */
  async getItemDetails(purchaseType, itemId, studioOwnerId = null) {
    let itemData;
    let price;
    let itemName;
    let metadata = {};

    switch (purchaseType) {
      case "class": {
        itemData = await classesService.getPublicClassById(itemId);
        if (!itemData) {
          throw new Error("Class not found");
        }
        // Get studioOwnerId from the class data (students can purchase from any studio)
        // The class data should have studioOwnerId in the original data or in studio.id
        const classStudioOwnerId = itemData.studioOwnerId || itemData.studio?.id;
        if (!classStudioOwnerId) {
          throw new Error("Class studio information not found");
        }
        price = itemData.cost;
        itemName = itemData.name;
        metadata = {
          classId: itemId,
          level: itemData.level,
          dayOfWeek: itemData.dayOfWeek,
        };
        // Use the class's studio owner ID (students can purchase from any studio)
        studioOwnerId = classStudioOwnerId;
        break;
      }

      case "event": {
        itemData = await eventsService.getPublicEventById(itemId);
        if (!itemData) {
          throw new Error("Event not found");
        }
        // Get studioOwnerId from the event data (students can purchase from any studio)
        const eventStudioOwnerId = itemData.studioOwnerId || itemData.studio?.id;
        if (!eventStudioOwnerId) {
          throw new Error("Event studio information not found");
        }
        // Events use price tiers - get the lowest price tier
        if (!itemData.priceTiers || itemData.priceTiers.length === 0) {
          throw new Error("Event has no price tiers");
        }
        const lowestTier = itemData.priceTiers.reduce((min, tier) => 
          tier.price < min.price ? tier : min
        );
        price = lowestTier.price;
        itemName = itemData.name;
        metadata = {
          eventId: itemId,
          startTime: itemData.startTime,
          endTime: itemData.endTime,
        };
        // Use the event's studio owner ID
        studioOwnerId = eventStudioOwnerId;
        break;
      }

      case "workshop": {
        itemData = await workshopsService.getPublicWorkshopById(itemId);
        if (!itemData) {
          throw new Error("Workshop not found");
        }
        // Get studioOwnerId from the workshop data (students can purchase from any studio)
        const workshopStudioOwnerId = itemData.studioOwnerId || itemData.studio?.id;
        if (!workshopStudioOwnerId) {
          throw new Error("Workshop studio information not found");
        }
        // Workshops use price tiers - get the lowest price tier
        if (!itemData.priceTiers || itemData.priceTiers.length === 0) {
          throw new Error("Workshop has no price tiers");
        }
        const lowestTier = itemData.priceTiers.reduce((min, tier) => 
          tier.price < min.price ? tier : min
        );
        price = lowestTier.price;
        itemName = itemData.name;
        metadata = {
          workshopId: itemId,
          startTime: itemData.startTime,
          endTime: itemData.endTime,
        };
        // Use the workshop's studio owner ID
        studioOwnerId = workshopStudioOwnerId;
        break;
      }

      case "package": {
        // For packages, we need to find which studio it belongs to
        // First try to get it without studioOwnerId validation
        const db = getFirestore();
        const packageRef = db.collection("packages").doc(itemId);
        const packageDoc = await packageRef.get();
        
        if (!packageDoc.exists) {
          throw new Error("Package not found");
        }
        
        itemData = packageDoc.data();
        if (!itemData.isActive) {
          throw new Error("Package is not active");
        }
        
        // Get studioOwnerId from the package
        const packageStudioOwnerId = itemData.studioOwnerId;
        if (!packageStudioOwnerId) {
          throw new Error("Package studio information not found");
        }
        
        price = itemData.price;
        itemName = itemData.name;
        metadata = {
          packageId: itemId,
          credits: itemData.credits,
          expirationDays: itemData.expirationDays || 365,
          isRecurring: itemData.isRecurring || false,
          allowCancellation: itemData.allowCancellation !== undefined ? itemData.allowCancellation : true,
        };
        if (itemData.billingFrequency !== undefined) metadata.billingFrequency = itemData.billingFrequency;
        if (itemData.billingInterval !== undefined) metadata.billingInterval = itemData.billingInterval;
        if (itemData.subscriptionDuration !== undefined) metadata.subscriptionDuration = itemData.subscriptionDuration;
        // Use the package's studio owner ID
        studioOwnerId = packageStudioOwnerId;
        break;
      }

      default:
        throw new Error(`Invalid purchase type: ${purchaseType}`);
    }

    // Get studio name
    const db = getFirestore();
    const studioOwnerRef = db.collection("users").doc(studioOwnerId);
    const studioOwnerDoc = await studioOwnerRef.get();
    const studioName = studioOwnerDoc.exists 
      ? studioOwnerDoc.data().studioName || "Studio"
      : "Studio";

    // For packages, get recurring info from itemData (package document)
    const isRecurring = purchaseType === "package" && itemData?.isRecurring === true;
    const billingFrequency = purchaseType === "package" ? itemData?.billingFrequency : undefined;
    const billingInterval = purchaseType === "package" ? itemData?.billingInterval : undefined;
    const subscriptionDuration = purchaseType === "package" ? itemData?.subscriptionDuration : undefined;

    return {
      itemId,
      itemName,
      price,
      studioOwnerId,
      studioName,
      metadata,
      purchaseType,
      isRecurring,
      billingFrequency,
      billingInterval,
      subscriptionDuration,
    };
  }

  /**
   * Grant credits based on purchase type
   * @param {string} purchaseType - 'class' | 'event' | 'workshop' | 'package'
   * @param {string} studentId - Student document ID
   * @param {string} studioOwnerId - Studio owner document ID
   * @param {Object} itemData - Item data from getItemDetails
   * @returns {Promise<{creditIds: string[], creditsGranted: number}>} Credit entry IDs and count
   */
  async grantCreditsForPurchase(purchaseType, studentId, studioOwnerId, itemData) {
    const creditIds = [];
    let creditsGranted = 0;

    switch (purchaseType) {
      case "class": {
        // Grant 1 class-specific credit (tied to classId)
        const expirationDays = 365; // Default 1 year for class credits
        const creditId = await creditTrackingService.addCredits(
            studentId,
            studioOwnerId,
            1, // 1 credit per class purchase
            expirationDays,
            null, // packageId = null for class purchases
            itemData.itemId // classId for class-specific credits
        );
        creditIds.push(creditId);
        creditsGranted = 1;
        break;
      }

      case "package": {
        // Grant N general credits (classId = null)
        const expirationDays = itemData.metadata.expirationDays || 365;
        const credits = itemData.metadata.credits || 0;
        if (credits > 0) {
          const creditId = await creditTrackingService.addCredits(
              studentId,
              studioOwnerId,
              credits,
              expirationDays,
              itemData.itemId, // packageId
              null // classId = null for general credits
          );
          creditIds.push(creditId);
          creditsGranted = credits;
        }
        break;
      }

      case "event":
      case "workshop": {
        // No credits granted for events/workshops (direct purchase)
        creditsGranted = 0;
        break;
      }

      default:
        throw new Error(`Invalid purchase type: ${purchaseType}`);
    }

    return { creditIds, creditsGranted };
  }

  /**
   * Create purchase record in database
   * @param {Object} purchaseData - Purchase data
   * @returns {Promise<string>} Purchase document ID
   */
  async createPurchaseRecord(purchaseData) {
    const db = getFirestore();
    const purchasesRef = db.collection("purchases");

    const purchaseDoc = {
      studentId: purchaseData.studentId,
      authUid: purchaseData.authUid,
      purchaseType: purchaseData.purchaseType,
      itemId: purchaseData.itemId,
      studioOwnerId: purchaseData.studioOwnerId,
      itemName: purchaseData.itemName,
      studioName: purchaseData.studioName,
      price: purchaseData.price,
      stripePaymentIntentId: purchaseData.stripePaymentIntentId || null,
      stripeCustomerId: purchaseData.stripeCustomerId || null,
      stripeSubscriptionId: purchaseData.stripeSubscriptionId || null,
      isRecurring: purchaseData.isRecurring || false,
      subscriptionStatus: purchaseData.subscriptionStatus || null,
      status: purchaseData.status || "completed",
      creditGranted: purchaseData.creditGranted || false,
      creditsGranted: purchaseData.creditsGranted || 0,
      creditIds: purchaseData.creditIds || [],
      classId: purchaseData.classId || null, // Only for class purchases
      metadata: stripUndefined(purchaseData.metadata || {}),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const docRef = await purchasesRef.add(purchaseDoc);
    return docRef.id;
  }

  /**
   * Create notification for studio owner about purchase
   * @param {Object} purchaseData - Purchase data
   * @returns {Promise<string>} Notification document ID
   */
  async createPurchaseNotification(purchaseData) {
    const notificationTypeMap = {
      class: "class_purchase",
      event: "event_purchase",
      workshop: "workshop_purchase",
      package: "package_purchase",
    };

    const notificationType = notificationTypeMap[purchaseData.purchaseType] || "purchase";
    
    let title;
    let message;

    switch (purchaseData.purchaseType) {
      case "class":
        title = "New Class Purchase";
        message = `${purchaseData.studentName || "A student"} purchased "${purchaseData.itemName}"`;
        break;
      case "event":
        title = "New Event Purchase";
        message = `${purchaseData.studentName || "A student"} purchased "${purchaseData.itemName}"`;
        break;
      case "workshop":
        title = "New Workshop Purchase";
        message = `${purchaseData.studentName || "A student"} purchased "${purchaseData.itemName}"`;
        break;
      case "package":
        title = "New Package Purchase";
        message = `${purchaseData.studentName || "A student"} purchased "${purchaseData.itemName}"`;
        break;
      default:
        title = "New Purchase";
        message = `${purchaseData.studentName || "A student"} made a purchase`;
    }

    return await notificationsService.createNotification(
        purchaseData.studioOwnerId,
        null, // bookingId
        notificationType,
        title,
        message,
        purchaseData.studentId // studentId
    );
  }

  /**
   * Get student ID from auth UID
   * @param {string} authUid - Firebase Auth UID
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<{studentId: string, studentName: string}>} Student ID and name
   */
  async getStudentFromAuthUid(authUid, studioOwnerId) {
    // Find student document
    const db = getFirestore();
    const studentsRef = db.collection("students");
    const studentSnapshot = await studentsRef
        .where("authUid", "==", authUid)
        .where("studioOwnerId", "==", studioOwnerId)
        .limit(1)
        .get();

    if (studentSnapshot.empty) {
      throw new Error("Student not found for this studio");
    }

    const studentDoc = studentSnapshot.docs[0];
    const studentData = studentDoc.data();
    
    // Get student name from profile
    const studentProfileDoc = await authService.getStudentProfileByAuthUid(authUid);
    let studentName = null;
    if (studentProfileDoc) {
      const profileData = studentProfileDoc.data();
      const firstName = profileData.firstName || "";
      const lastName = profileData.lastName || "";
      studentName = `${firstName} ${lastName}`.trim() || null;
    }

    return {
      studentId: studentDoc.id,
      studentName: studentName || studentData.email || "Student",
    };
  }
}

module.exports = new PurchaseService();

