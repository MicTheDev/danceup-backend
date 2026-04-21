import * as admin from "firebase-admin";
import authService from "./auth.service";
import { getFirestore } from "../utils/firestore";

type EntityType = "class" | "instructor" | "studio";

interface ReviewData {
  entityType: EntityType;
  entityId: string;
  rating: number;
  comment?: string;
}

interface ReviewFilters {
  limit?: number;
  startAfter?: string;
  entityType?: EntityType;
  rating?: number;
  hasResponse?: boolean;
}

export class ReviewsService {
  async getStudentId(authUid: string): Promise<string | null> {
    const studentDoc = await authService.getStudentProfileByAuthUid(authUid);
    if (!studentDoc) return null;
    return studentDoc.id;
  }

  async getStudentName(studentId: string): Promise<string> {
    const db = getFirestore();
    const doc = await db.collection("usersStudentProfiles").doc(studentId).get();
    if (!doc.exists) return "Anonymous";
    const data = doc.data() as Record<string, unknown> | undefined;
    const firstName = (data?.["firstName"] as string) || "";
    const lastName = (data?.["lastName"] as string) || "";
    return `${firstName} ${lastName}`.trim() || "Anonymous";
  }

  async canStudentReview(entityType: EntityType, entityId: string, studentId: string): Promise<boolean> {
    const db = getFirestore();
    const studentDoc = await db.collection("usersStudentProfiles").doc(studentId).get();
    if (!studentDoc.exists) return false;
    const studentData = studentDoc.data() as Record<string, unknown> | undefined;
    const studios = (studentData?.["studios"] as Record<string, unknown> | undefined) || {};

    if (entityType === "studio") {
      return !!studios[entityId];
    } else if (entityType === "class") {
      const classDoc = await db.collection("classes").doc(entityId).get();
      if (!classDoc.exists) return false;
      const classData = classDoc.data() as Record<string, unknown> | undefined;
      const studioOwnerId = classData?.["studioOwnerId"] as string | undefined;
      if (!studioOwnerId) return false;
      return !!studios[studioOwnerId];
    } else if (entityType === "instructor") {
      const instructorDoc = await db.collection("instructors").doc(entityId).get();
      if (!instructorDoc.exists) return false;
      const instructorData = instructorDoc.data() as Record<string, unknown> | undefined;
      const studioOwnerId = instructorData?.["studioOwnerId"] as string | undefined;
      if (!studioOwnerId) return false;
      return !!studios[studioOwnerId];
    }
    return false;
  }

  async hasExistingReview(entityType: EntityType, entityId: string, studentId: string): Promise<boolean> {
    const db = getFirestore();
    const snapshot = await db.collection("reviews")
      .where("entityType", "==", entityType)
      .where("entityId", "==", entityId)
      .where("studentId", "==", studentId)
      .where("isDeleted", "==", false)
      .limit(1)
      .get();
    return !snapshot.empty;
  }

  async getStudioOwnerId(entityType: EntityType, entityId: string): Promise<string | null> {
    const db = getFirestore();
    if (entityType === "studio") return entityId;
    if (entityType === "class") {
      const classDoc = await db.collection("classes").doc(entityId).get();
      if (!classDoc.exists) return null;
      return ((classDoc.data() as Record<string, unknown>)["studioOwnerId"] as string) || null;
    }
    if (entityType === "instructor") {
      const instructorDoc = await db.collection("instructors").doc(entityId).get();
      if (!instructorDoc.exists) return null;
      return ((instructorDoc.data() as Record<string, unknown>)["studioOwnerId"] as string) || null;
    }
    return null;
  }

  async createReview(reviewData: ReviewData, studentId: string, authUid: string): Promise<string> {
    const db = getFirestore();

    if (!reviewData.rating || reviewData.rating < 1 || reviewData.rating > 5) {
      throw new Error("Rating must be between 1 and 5");
    }

    const canReview = await this.canStudentReview(reviewData.entityType, reviewData.entityId, studentId);
    if (!canReview) throw new Error("Student is not enrolled and cannot review this entity");

    const hasReview = await this.hasExistingReview(reviewData.entityType, reviewData.entityId, studentId);
    if (hasReview) throw new Error("Student already has a review for this entity");

    const studioOwnerId = await this.getStudioOwnerId(reviewData.entityType, reviewData.entityId);
    if (!studioOwnerId) throw new Error("Could not determine studio owner for this entity");

    const studentName = await this.getStudentName(studentId);

    const reviewDoc = {
      entityType: reviewData.entityType,
      entityId: reviewData.entityId,
      studioOwnerId,
      studentId,
      studentAuthUid: authUid,
      studentName,
      rating: reviewData.rating,
      comment: reviewData.comment || "",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      isDeleted: false,
    };

    const reviewRef = db.collection("reviews").doc();
    await reviewRef.set(reviewDoc);
    await this.calculateAggregateRatings(reviewData.entityType, reviewData.entityId);
    return reviewRef.id;
  }

  async getReviews(
    entityType: EntityType,
    entityId: string,
    filters: ReviewFilters = {},
  ): Promise<Array<Record<string, unknown> & { id: string }>> {
    const db = getFirestore();
    let query = db.collection("reviews")
      .where("entityType", "==", entityType)
      .where("entityId", "==", entityId)
      .where("isDeleted", "==", false)
      .orderBy("createdAt", "desc") as FirebaseFirestore.Query;

    if (filters.startAfter) {
      const startAfterDoc = await db.collection("reviews").doc(filters.startAfter).get();
      if (startAfterDoc.exists) query = query.startAfter(startAfterDoc);
    }

    query = query.limit(filters.limit || 20);
    const snapshot = await query.get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() as Record<string, unknown>) }));
  }

  async getReviewById(reviewId: string): Promise<(Record<string, unknown> & { id: string }) | null> {
    const db = getFirestore();
    const doc = await db.collection("reviews").doc(reviewId).get();
    if (!doc.exists) return null;
    const data = doc.data() as Record<string, unknown>;
    if (data["isDeleted"]) return null;
    return { id: doc.id, ...data };
  }

  async updateReview(reviewId: string, updates: { rating?: number; comment?: string }, studentId: string): Promise<void> {
    const db = getFirestore();
    const reviewRef = db.collection("reviews").doc(reviewId);
    const reviewDoc = await reviewRef.get();
    if (!reviewDoc.exists) throw new Error("Review not found");
    const reviewData = reviewDoc.data() as Record<string, unknown>;
    if (reviewData["studentId"] !== studentId) throw new Error("Access denied: Can only update your own reviews");
    if (reviewData["isDeleted"]) throw new Error("Cannot update deleted review");

    if (updates.rating !== undefined && (updates.rating < 1 || updates.rating > 5)) {
      throw new Error("Rating must be between 1 and 5");
    }

    const updateData: Record<string, unknown> = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (updates.rating !== undefined) updateData["rating"] = updates.rating;
    if (updates.comment !== undefined) updateData["comment"] = updates.comment;

    await reviewRef.update(updateData);
    await this.calculateAggregateRatings(
      reviewData["entityType"] as EntityType,
      reviewData["entityId"] as string,
    );
  }

  async deleteReview(reviewId: string, studentId: string): Promise<void> {
    const db = getFirestore();
    const reviewRef = db.collection("reviews").doc(reviewId);
    const reviewDoc = await reviewRef.get();
    if (!reviewDoc.exists) throw new Error("Review not found");
    const reviewData = reviewDoc.data() as Record<string, unknown>;
    if (reviewData["studentId"] !== studentId) throw new Error("Access denied: Can only delete your own reviews");
    if (reviewData["isDeleted"]) return;

    await reviewRef.update({
      isDeleted: true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await this.calculateAggregateRatings(
      reviewData["entityType"] as EntityType,
      reviewData["entityId"] as string,
    );
  }

  async hardDeleteReview(reviewId: string, studioOwnerId: string): Promise<void> {
    const db = getFirestore();
    const reviewRef = db.collection("reviews").doc(reviewId);
    const reviewDoc = await reviewRef.get();
    if (!reviewDoc.exists) throw new Error("Review not found");
    const reviewData = reviewDoc.data() as Record<string, unknown>;

    const ownsEntity = await this.verifyStudioOwnership(
      reviewData["entityType"] as EntityType,
      reviewData["entityId"] as string,
      studioOwnerId,
    );
    if (!ownsEntity) throw new Error("Access denied: Studio owner does not own this entity");

    const entityType = reviewData["entityType"] as EntityType;
    const entityId = reviewData["entityId"] as string;
    await reviewRef.delete();
    await this.calculateAggregateRatings(entityType, entityId);
  }

  async verifyStudioOwnership(entityType: EntityType, entityId: string, studioOwnerId: string): Promise<boolean> {
    const db = getFirestore();
    if (entityType === "studio") return entityId === studioOwnerId;
    if (entityType === "class") {
      const classDoc = await db.collection("classes").doc(entityId).get();
      if (!classDoc.exists) return false;
      return ((classDoc.data() as Record<string, unknown>)["studioOwnerId"] as string) === studioOwnerId;
    }
    if (entityType === "instructor") {
      const instructorDoc = await db.collection("instructors").doc(entityId).get();
      if (!instructorDoc.exists) return false;
      return ((instructorDoc.data() as Record<string, unknown>)["studioOwnerId"] as string) === studioOwnerId;
    }
    return false;
  }

  async addResponse(reviewId: string, responseText: string, studioOwnerId: string): Promise<void> {
    const db = getFirestore();
    const reviewRef = db.collection("reviews").doc(reviewId);
    const reviewDoc = await reviewRef.get();
    if (!reviewDoc.exists) throw new Error("Review not found");
    const reviewData = reviewDoc.data() as Record<string, unknown>;
    if (reviewData["isDeleted"]) throw new Error("Cannot respond to deleted review");

    const ownsEntity = await this.verifyStudioOwnership(
      reviewData["entityType"] as EntityType,
      reviewData["entityId"] as string,
      studioOwnerId,
    );
    if (!ownsEntity) throw new Error("Access denied: Studio owner does not own this entity");
    if (reviewData["response"]) throw new Error("Response already exists. Use updateResponse to modify it.");

    await reviewRef.update({
      response: {
        text: responseText,
        respondedBy: studioOwnerId,
        respondedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  async updateResponse(reviewId: string, responseText: string, studioOwnerId: string): Promise<void> {
    const db = getFirestore();
    const reviewRef = db.collection("reviews").doc(reviewId);
    const reviewDoc = await reviewRef.get();
    if (!reviewDoc.exists) throw new Error("Review not found");
    const reviewData = reviewDoc.data() as Record<string, unknown>;
    const response = reviewData["response"] as Record<string, unknown> | undefined;
    if (!response) throw new Error("No response exists. Use addResponse to create one.");
    if (response["respondedBy"] !== studioOwnerId) throw new Error("Access denied: Can only update your own responses");

    await reviewRef.update({
      "response.text": responseText,
      "response.respondedAt": admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  async deleteResponse(reviewId: string, studioOwnerId: string): Promise<void> {
    const db = getFirestore();
    const reviewRef = db.collection("reviews").doc(reviewId);
    const reviewDoc = await reviewRef.get();
    if (!reviewDoc.exists) throw new Error("Review not found");
    const reviewData = reviewDoc.data() as Record<string, unknown>;
    const response = reviewData["response"] as Record<string, unknown> | undefined;
    if (!response) return;
    if (response["respondedBy"] !== studioOwnerId) throw new Error("Access denied: Can only delete your own responses");

    await reviewRef.update({
      response: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  async calculateAggregateRatings(entityType: EntityType, entityId: string): Promise<void> {
    const db = getFirestore();
    const snapshot = await db.collection("reviews")
      .where("entityType", "==", entityType)
      .where("entityId", "==", entityId)
      .where("isDeleted", "==", false)
      .get();

    let totalRating = 0;
    let reviewCount = 0;
    const ratingDistribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

    snapshot.forEach((doc) => {
      const data = doc.data() as Record<string, unknown>;
      const rating = data["rating"] as number;
      if (rating >= 1 && rating <= 5) {
        totalRating += rating;
        reviewCount++;
        ratingDistribution[rating] = (ratingDistribution[rating] ?? 0) + 1;
      }
    });

    const averageRating = reviewCount > 0 ? totalRating / reviewCount : 0;

    let entityRef: FirebaseFirestore.DocumentReference;
    if (entityType === "studio") {
      entityRef = db.collection("users").doc(entityId);
    } else if (entityType === "class") {
      entityRef = db.collection("classes").doc(entityId);
    } else if (entityType === "instructor") {
      entityRef = db.collection("instructors").doc(entityId);
    } else {
      return;
    }

    await entityRef.update({
      averageRating: Math.round(averageRating * 10) / 10,
      totalReviews: reviewCount,
      ratingDistribution,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  async getAggregateRatings(entityType: EntityType, entityId: string): Promise<{
    averageRating: number;
    totalReviews: number;
    ratingDistribution: Record<number, number>;
  } | null> {
    const db = getFirestore();
    let entityRef: FirebaseFirestore.DocumentReference;
    if (entityType === "studio") {
      entityRef = db.collection("users").doc(entityId);
    } else if (entityType === "class") {
      entityRef = db.collection("classes").doc(entityId);
    } else if (entityType === "instructor") {
      entityRef = db.collection("instructors").doc(entityId);
    } else {
      return null;
    }

    const doc = await entityRef.get();
    if (!doc.exists) return null;
    const data = doc.data() as Record<string, unknown>;
    return {
      averageRating: (data["averageRating"] as number) || 0,
      totalReviews: (data["totalReviews"] as number) || 0,
      ratingDistribution: (data["ratingDistribution"] as Record<number, number>) || { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    };
  }

  async getReviewsForStudio(
    studioOwnerId: string,
    filters: ReviewFilters = {},
  ): Promise<Array<Record<string, unknown> & { id: string }>> {
    const db = getFirestore();
    let query = db.collection("reviews")
      .where("studioOwnerId", "==", studioOwnerId)
      .where("isDeleted", "==", false) as FirebaseFirestore.Query;

    if (filters.entityType) query = query.where("entityType", "==", filters.entityType);
    if (filters.rating) query = query.where("rating", "==", filters.rating);

    query = query.orderBy("createdAt", "desc").limit(filters.limit || 50);
    const snapshot = await query.get();

    const allReviews: Array<Record<string, unknown> & { id: string }> = [];
    snapshot.forEach((doc) => {
      const review = { id: doc.id, ...(doc.data() as Record<string, unknown>) } as Record<string, unknown> & { id: string };
      if (filters.hasResponse !== undefined) {
        const hasResponse = !!review["response"];
        if (hasResponse !== filters.hasResponse) return;
      }
      allReviews.push(review);
    });
    return allReviews;
  }
}

export default new ReviewsService();
