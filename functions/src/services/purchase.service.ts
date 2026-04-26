import * as admin from "firebase-admin";
import authService from "./auth.service";
import creditTrackingService from "./credit-tracking.service";
import classesService from "./classes.service";
import eventsService from "./events.service";
import workshopsService from "./workshops.service";
import notificationsService from "./notifications.service";
import { getFirestore } from "../utils/firestore";

type PurchaseType = "class" | "event" | "workshop" | "package";

interface ItemDetails {
  itemId: string;
  itemName: string;
  price: number;
  studioOwnerId: string;
  studioName: string;
  metadata: Record<string, unknown>;
  purchaseType: PurchaseType;
  isRecurring: boolean;
  billingFrequency?: unknown;
  billingInterval?: unknown;
  subscriptionDuration?: unknown;
  stripeProductId: string | null;
}

interface PurchaseRecordData {
  studentId: string;
  authUid: string;
  purchaseType: string;
  itemId: string;
  studioOwnerId: string;
  itemName: string;
  studioName: string;
  price: number;
  stripePaymentIntentId?: string | null;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  isRecurring?: boolean;
  isRenewal?: boolean;
  renewalNumber?: number | null;
  subscriptionStatus?: string | null;
  status?: string;
  creditGranted?: boolean;
  creditsGranted?: number;
  creditIds?: string[];
  classId?: string | null;
  metadata?: Record<string, unknown>;
  studentName?: string;
  guestEmail?: string | null;
}

function stripUndefined(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map((v) => (typeof v === "object" && v !== null ? stripUndefined(v) : v));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (v === undefined) continue;
    out[k] = typeof v === "object" && v !== null && !Array.isArray(v) ? stripUndefined(v) : v;
  }
  return out;
}

export class PurchaseService {
  async getItemDetails(
    purchaseType: PurchaseType, itemId: string, studioOwnerId: string | null = null,
  ): Promise<ItemDetails> {
    let itemData: Record<string, unknown> | null = null;
    let price: number;
    let itemName: string;
    let metadata: Record<string, unknown> = {};
    let resolvedStudioOwnerId: string;

    switch (purchaseType) {
      case "class": {
        const classItem = await classesService.getPublicClassById(itemId);
        if (!classItem) throw new Error("Class not found");
        const classStudioOwnerId = (classItem["studioOwnerId"] as string | undefined) ??
          ((classItem["studio"] as Record<string, unknown> | undefined)?.["id"] as string | undefined);
        if (!classStudioOwnerId) throw new Error("Class studio information not found");
        price = classItem["cost"] as number;
        itemName = classItem["name"] as string;
        metadata = { classId: itemId, level: classItem["level"], dayOfWeek: classItem["dayOfWeek"] };
        resolvedStudioOwnerId = classStudioOwnerId;
        break;
      }
      case "event": {
        const eventItem = await eventsService.getPublicEventById(itemId);
        if (!eventItem) throw new Error("Event not found");
        const eventStudioOwnerId = (eventItem["studioOwnerId"] as string | undefined) ??
          ((eventItem["studio"] as Record<string, unknown> | undefined)?.["id"] as string | undefined);
        if (!eventStudioOwnerId) throw new Error("Event studio information not found");
        const priceTiers = eventItem["priceTiers"] as Array<{ price?: number }> | undefined;
        if (!priceTiers || priceTiers.length === 0) throw new Error("Event has no price tiers");
        const lowestTier = priceTiers.reduce((min, tier) => (tier.price ?? 0) < (min.price ?? 0) ? tier : min);
        price = lowestTier.price ?? 0;
        itemName = eventItem["name"] as string;
        metadata = { eventId: itemId, startTime: eventItem["startTime"], endTime: eventItem["endTime"] };
        resolvedStudioOwnerId = eventStudioOwnerId;
        break;
      }
      case "workshop": {
        const workshopItem = await workshopsService.getPublicWorkshopById(itemId);
        if (!workshopItem) throw new Error("Workshop not found");
        const workshopStudioOwnerId = (workshopItem["studioOwnerId"] as string | undefined) ??
          ((workshopItem["studio"] as Record<string, unknown> | undefined)?.["id"] as string | undefined);
        if (!workshopStudioOwnerId) throw new Error("Workshop studio information not found");
        const priceTiers = workshopItem["priceTiers"] as Array<{ price?: number }> | undefined;
        if (!priceTiers || priceTiers.length === 0) throw new Error("Workshop has no price tiers");
        const lowestTier = priceTiers.reduce((min, tier) => (tier.price ?? 0) < (min.price ?? 0) ? tier : min);
        price = lowestTier.price ?? 0;
        itemName = workshopItem["name"] as string;
        metadata = { workshopId: itemId, startTime: workshopItem["startTime"], endTime: workshopItem["endTime"] };
        resolvedStudioOwnerId = workshopStudioOwnerId;
        break;
      }
      case "package": {
        const db = getFirestore();
        const packageDoc = await db.collection("packages").doc(itemId).get();
        if (!packageDoc.exists) throw new Error("Package not found");
        itemData = packageDoc.data() as Record<string, unknown>;
        if (!itemData["isActive"]) throw new Error("Package is not active");
        const packageStudioOwnerId = itemData["studioOwnerId"] as string | undefined;
        if (!packageStudioOwnerId) throw new Error("Package studio information not found");
        price = itemData["price"] as number;
        itemName = itemData["name"] as string;
        metadata = {
          packageId: itemId,
          credits: itemData["credits"],
          expirationDays: (itemData["expirationDays"] as number) || 365,
          isRecurring: (itemData["isRecurring"] as boolean) || false,
          allowCancellation: itemData["allowCancellation"] !== undefined ? itemData["allowCancellation"] : true,
        };
        if (itemData["billingFrequency"] !== undefined) metadata["billingFrequency"] = itemData["billingFrequency"];
        if (itemData["billingInterval"] !== undefined) metadata["billingInterval"] = itemData["billingInterval"];
        if (itemData["subscriptionDuration"] !== undefined) metadata["subscriptionDuration"] = itemData["subscriptionDuration"];
        resolvedStudioOwnerId = packageStudioOwnerId;
        break;
      }
      default:
        throw new Error(`Invalid purchase type: ${purchaseType as string}`);
    }

    // Silence unused param warning
    void studioOwnerId;

    const db = getFirestore();
    const studioOwnerDoc = await db.collection("users").doc(resolvedStudioOwnerId).get();
    const studioName = studioOwnerDoc.exists
      ? ((studioOwnerDoc.data() as Record<string, unknown>)["studioName"] as string) || "Studio"
      : "Studio";

    const isRecurring = purchaseType === "package" && itemData?.["isRecurring"] === true;

    return {
      itemId,
      itemName,
      price,
      studioOwnerId: resolvedStudioOwnerId,
      studioName,
      metadata,
      purchaseType,
      isRecurring,
      billingFrequency: purchaseType === "package" ? itemData?.["billingFrequency"] : undefined,
      billingInterval: purchaseType === "package" ? itemData?.["billingInterval"] : undefined,
      subscriptionDuration: purchaseType === "package" ? itemData?.["subscriptionDuration"] : undefined,
      stripeProductId: (itemData?.["stripeProductId"] as string | null) ?? null,
    };
  }

  async grantCreditsForPurchase(
    purchaseType: PurchaseType,
    studentId: string,
    studioOwnerId: string,
    itemData: ItemDetails,
  ): Promise<{ creditIds: string[]; creditsGranted: number }> {
    const creditIds: string[] = [];
    let creditsGranted = 0;

    switch (purchaseType) {
      case "class": {
        const creditId = await creditTrackingService.addCredits(
          studentId, studioOwnerId, 1, 365, null, itemData.itemId,
        );
        creditIds.push(creditId);
        creditsGranted = 1;
        break;
      }
      case "package": {
        const expirationDays = (itemData.metadata["expirationDays"] as number) || 365;
        const credits = (itemData.metadata["credits"] as number) || 0;
        if (credits > 0) {
          const creditId = await creditTrackingService.addCredits(
            studentId, studioOwnerId, credits, expirationDays, itemData.itemId, null,
          );
          creditIds.push(creditId);
          creditsGranted = credits;
        }
        break;
      }
      case "event":
      case "workshop":
        creditsGranted = 0;
        break;
      default:
        throw new Error(`Invalid purchase type: ${purchaseType as string}`);
    }

    return { creditIds, creditsGranted };
  }

  async createPurchaseRecord(purchaseData: PurchaseRecordData): Promise<string> {
    const db = getFirestore();
    const docRef = await db.collection("purchases").add({
      studentId: purchaseData.studentId,
      authUid: purchaseData.authUid,
      purchaseType: purchaseData.purchaseType,
      itemId: purchaseData.itemId,
      studioOwnerId: purchaseData.studioOwnerId,
      itemName: purchaseData.itemName,
      studioName: purchaseData.studioName,
      price: purchaseData.price,
      stripePaymentIntentId: purchaseData.stripePaymentIntentId ?? null,
      stripeCustomerId: purchaseData.stripeCustomerId ?? null,
      stripeSubscriptionId: purchaseData.stripeSubscriptionId ?? null,
      isRecurring: purchaseData.isRecurring ?? false,
      isRenewal: purchaseData.isRenewal === true,
      renewalNumber: purchaseData.renewalNumber ?? null,
      subscriptionStatus: purchaseData.subscriptionStatus ?? null,
      status: purchaseData.status ?? "completed",
      creditGranted: purchaseData.creditGranted ?? false,
      creditsGranted: purchaseData.creditsGranted ?? 0,
      creditIds: purchaseData.creditIds ?? [],
      classId: purchaseData.classId ?? null,
      metadata: stripUndefined(purchaseData.metadata ?? {}),
      ...(purchaseData.guestEmail ? { guestEmail: purchaseData.guestEmail.toLowerCase() } : {}),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return docRef.id;
  }

  async createPurchaseNotification(purchaseData: PurchaseRecordData): Promise<string> {
    const notificationTypeMap: Record<string, string> = {
      class: "class_purchase",
      event: "event_purchase",
      workshop: "workshop_purchase",
      package: "package_purchase",
    };
    const notificationType = notificationTypeMap[purchaseData.purchaseType] ?? "purchase";

    let title: string;
    let message: string;
    const studentLabel = purchaseData.studentName || "A student";

    switch (purchaseData.purchaseType) {
      case "class":
        title = "New Class Purchase";
        message = `${studentLabel} purchased "${purchaseData.itemName}"`;
        break;
      case "event":
        title = "New Event Purchase";
        message = `${studentLabel} purchased "${purchaseData.itemName}"`;
        break;
      case "workshop":
        title = "New Workshop Purchase";
        message = `${studentLabel} purchased "${purchaseData.itemName}"`;
        break;
      case "package":
        title = "New Package Purchase";
        message = `${studentLabel} purchased "${purchaseData.itemName}"`;
        break;
      default:
        title = "New Purchase";
        message = `${studentLabel} made a purchase`;
    }

    return await notificationsService.createNotification(
      purchaseData.studioOwnerId, null, notificationType, title, message, purchaseData.studentId,
    );
  }

  async getStudentFromAuthUid(
    authUid: string, studioOwnerId: string,
  ): Promise<{ studentId: string; studentName: string }> {
    const db = getFirestore();
    const studentSnapshot = await db.collection("students")
      .where("authUid", "==", authUid)
      .where("studioOwnerId", "==", studioOwnerId)
      .limit(1)
      .get();

    if (studentSnapshot.empty) throw new Error("Student not found for this studio");
    const firstDoc = studentSnapshot.docs[0];
    if (!firstDoc) throw new Error("Student not found for this studio");
    const studentData = firstDoc.data() as Record<string, unknown>;

    const studentProfileDoc = await authService.getStudentProfileByAuthUid(authUid);
    let studentName: string | null = null;
    if (studentProfileDoc) {
      const profileData = studentProfileDoc.data() as Record<string, unknown> | undefined;
      if (profileData) {
        const firstName = (profileData["firstName"] as string) || "";
        const lastName = (profileData["lastName"] as string) || "";
        studentName = `${firstName} ${lastName}`.trim() || null;
      }
    }

    return {
      studentId: firstDoc.id,
      studentName: studentName || (studentData["email"] as string) || "Student",
    };
  }
}

export default new PurchaseService();
