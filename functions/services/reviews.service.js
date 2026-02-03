const admin = require("firebase-admin");
const authService = require("./auth.service");
const studioEnrollmentService = require("./studio-enrollment.service");
const {getFirestore} = require("../utils/firestore");

/**
 * Service for handling review and rating operations
 */
class ReviewsService {
  /**
   * Get student ID from Firebase Auth UID
   * @param {string} authUid - Firebase Auth UID
   * @returns {Promise<string | null>} Student profile document ID
   */
  async getStudentId(authUid) {
    const studentDoc = await authService.getStudentProfileByAuthUid(authUid);
    if (!studentDoc) {
      return null;
    }
    return studentDoc.id;
  }

  /**
   * Get student name from profile
   * @param {string} studentId - Student profile document ID
   * @returns {Promise<string>} Student display name
   */
  async getStudentName(studentId) {
    const db = getFirestore();
    const studentProfileRef = db.collection("usersStudentProfiles").doc(studentId);
    const doc = await studentProfileRef.get();
    
    if (!doc.exists) {
      return "Anonymous";
    }
    
    const data = doc.data();
    const firstName = data.firstName || "";
    const lastName = data.lastName || "";
    return `${firstName} ${lastName}`.trim() || "Anonymous";
  }

  /**
   * Check if student can review an entity
   * @param {string} entityType - 'class' | 'instructor' | 'studio'
   * @param {string} entityId - Entity document ID
   * @param {string} studentId - Student profile document ID
   * @returns {Promise<boolean>} True if student can review
   */
  async canStudentReview(entityType, entityId, studentId) {
    const db = getFirestore();
    const studentProfileRef = db.collection("usersStudentProfiles").doc(studentId);
    const studentDoc = await studentProfileRef.get();
    
    if (!studentDoc.exists) {
      return false;
    }
    
    const studentData = studentDoc.data();
    
    if (entityType === "studio") {
      // For studios, check if student is enrolled
      const studios = studentData.studios || {};
      return !!studios[entityId];
    } else if (entityType === "class") {
      // For classes, check if student is enrolled in the studio that owns the class
      const classRef = db.collection("classes").doc(entityId);
      const classDoc = await classRef.get();
      
      if (!classDoc.exists) {
        return false;
      }
      
      const classData = classDoc.data();
      const studioOwnerId = classData.studioOwnerId;
      
      if (!studioOwnerId) {
        return false;
      }
      
      const studios = studentData.studios || {};
      return !!studios[studioOwnerId];
    } else if (entityType === "instructor") {
      // For instructors, check if student is enrolled in the studio that owns the instructor
      const instructorRef = db.collection("instructors").doc(entityId);
      const instructorDoc = await instructorRef.get();
      
      if (!instructorDoc.exists) {
        return false;
      }
      
      const instructorData = instructorDoc.data();
      const studioOwnerId = instructorData.studioOwnerId;
      
      if (!studioOwnerId) {
        return false;
      }
      
      const studios = studentData.studios || {};
      return !!studios[studioOwnerId];
    }
    
    return false;
  }

  /**
   * Check if student already has a review for an entity
   * @param {string} entityType - 'class' | 'instructor' | 'studio'
   * @param {string} entityId - Entity document ID
   * @param {string} studentId - Student profile document ID
   * @returns {Promise<boolean>} True if review exists
   */
  async hasExistingReview(entityType, entityId, studentId) {
    const db = getFirestore();
    const reviewsRef = db.collection("reviews");
    const snapshot = await reviewsRef
        .where("entityType", "==", entityType)
        .where("entityId", "==", entityId)
        .where("studentId", "==", studentId)
        .where("isDeleted", "==", false)
        .limit(1)
        .get();
    
    return !snapshot.empty;
  }

  /**
   * Get studio owner ID for an entity
   * @param {string} entityType - 'class' | 'instructor' | 'studio'
   * @param {string} entityId - Entity document ID
   * @returns {Promise<string | null>} Studio owner document ID
   */
  async getStudioOwnerId(entityType, entityId) {
    const db = getFirestore();
    
    if (entityType === "studio") {
      // For studios, the entityId IS the studioOwnerId
      return entityId;
    } else if (entityType === "class") {
      const classRef = db.collection("classes").doc(entityId);
      const classDoc = await classRef.get();
      if (!classDoc.exists) {
        return null;
      }
      return classDoc.data().studioOwnerId || null;
    } else if (entityType === "instructor") {
      const instructorRef = db.collection("instructors").doc(entityId);
      const instructorDoc = await instructorRef.get();
      if (!instructorDoc.exists) {
        return null;
      }
      return instructorDoc.data().studioOwnerId || null;
    }
    
    return null;
  }

  /**
   * Create a new review
   * @param {Object} reviewData - Review data
   * @param {string} reviewData.entityType - 'class' | 'instructor' | 'studio'
   * @param {string} reviewData.entityId - Entity document ID
   * @param {number} reviewData.rating - Rating (1-5)
   * @param {string} reviewData.comment - Review comment
   * @param {string} studentId - Student profile document ID
   * @param {string} authUid - Firebase Auth UID
   * @returns {Promise<string>} Created review document ID
   */
  async createReview(reviewData, studentId, authUid) {
    const db = getFirestore();
    
    // Validate rating
    if (!reviewData.rating || reviewData.rating < 1 || reviewData.rating > 5) {
      throw new Error("Rating must be between 1 and 5");
    }
    
    // Check if student can review
    const canReview = await this.canStudentReview(
        reviewData.entityType,
        reviewData.entityId,
        studentId,
    );
    
    if (!canReview) {
      throw new Error("Student is not enrolled and cannot review this entity");
    }
    
    // Check if review already exists
    const hasReview = await this.hasExistingReview(
        reviewData.entityType,
        reviewData.entityId,
        studentId,
    );
    
    if (hasReview) {
      throw new Error("Student already has a review for this entity");
    }
    
    // Get studio owner ID for this entity
    const studioOwnerId = await this.getStudioOwnerId(
        reviewData.entityType,
        reviewData.entityId,
    );
    
    if (!studioOwnerId) {
      throw new Error("Could not determine studio owner for this entity");
    }
    
    // Get student name
    const studentName = await this.getStudentName(studentId);
    
    // Create review document
    const reviewDoc = {
      entityType: reviewData.entityType,
      entityId: reviewData.entityId,
      studioOwnerId: studioOwnerId, // Store studio owner ID for efficient querying
      studentId: studentId,
      studentAuthUid: authUid,
      studentName: studentName,
      rating: reviewData.rating,
      comment: reviewData.comment || "",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      isDeleted: false,
    };
    
    const reviewRef = db.collection("reviews").doc();
    await reviewRef.set(reviewDoc);
    
    // Calculate and update aggregate ratings
    await this.calculateAggregateRatings(reviewData.entityType, reviewData.entityId);
    
    return reviewRef.id;
  }

  /**
   * Get reviews for an entity
   * @param {string} entityType - 'class' | 'instructor' | 'studio'
   * @param {string} entityId - Entity document ID
   * @param {Object} filters - Filter options
   * @param {number} filters.limit - Number of reviews to return
   * @param {string} filters.startAfter - Document ID to start after (pagination)
   * @returns {Promise<Array>} Array of reviews
   */
  async getReviews(entityType, entityId, filters = {}) {
    const db = getFirestore();
    const reviewsRef = db.collection("reviews");
    
    let query = reviewsRef
        .where("entityType", "==", entityType)
        .where("entityId", "==", entityId)
        .where("isDeleted", "==", false)
        .orderBy("createdAt", "desc");
    
    if (filters.startAfter) {
      const startAfterDoc = await reviewsRef.doc(filters.startAfter).get();
      if (startAfterDoc.exists) {
        query = query.startAfter(startAfterDoc);
      }
    }
    
    const limit = filters.limit || 20;
    query = query.limit(limit);
    
    const snapshot = await query.get();
    const reviews = [];
    
    snapshot.forEach((doc) => {
      reviews.push({
        id: doc.id,
        ...doc.data(),
      });
    });
    
    return reviews;
  }

  /**
   * Get a single review by ID
   * @param {string} reviewId - Review document ID
   * @returns {Promise<Object | null>} Review data or null if not found
   */
  async getReviewById(reviewId) {
    const db = getFirestore();
    const reviewRef = db.collection("reviews").doc(reviewId);
    const doc = await reviewRef.get();
    
    if (!doc.exists) {
      return null;
    }
    
    const data = doc.data();
    if (data.isDeleted) {
      return null;
    }
    
    return {
      id: doc.id,
      ...data,
    };
  }

  /**
   * Update a review (student only)
   * @param {string} reviewId - Review document ID
   * @param {Object} updates - Update data
   * @param {number} updates.rating - Updated rating (1-5)
   * @param {string} updates.comment - Updated comment
   * @param {string} studentId - Student profile document ID
   * @returns {Promise<void>}
   */
  async updateReview(reviewId, updates, studentId) {
    const db = getFirestore();
    const reviewRef = db.collection("reviews").doc(reviewId);
    const reviewDoc = await reviewRef.get();
    
    if (!reviewDoc.exists) {
      throw new Error("Review not found");
    }
    
    const reviewData = reviewDoc.data();
    
    if (reviewData.studentId !== studentId) {
      throw new Error("Access denied: Can only update your own reviews");
    }
    
    if (reviewData.isDeleted) {
      throw new Error("Cannot update deleted review");
    }
    
    // Validate rating if provided
    if (updates.rating !== undefined) {
      if (updates.rating < 1 || updates.rating > 5) {
        throw new Error("Rating must be between 1 and 5");
      }
    }
    
    const updateData = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    
    if (updates.rating !== undefined) {
      updateData.rating = updates.rating;
    }
    
    if (updates.comment !== undefined) {
      updateData.comment = updates.comment;
    }
    
    await reviewRef.update(updateData);
    
    // Recalculate aggregate ratings
    await this.calculateAggregateRatings(reviewData.entityType, reviewData.entityId);
  }

  /**
   * Soft delete a review (student)
   * @param {string} reviewId - Review document ID
   * @param {string} studentId - Student profile document ID
   * @returns {Promise<void>}
   */
  async deleteReview(reviewId, studentId) {
    const db = getFirestore();
    const reviewRef = db.collection("reviews").doc(reviewId);
    const reviewDoc = await reviewRef.get();
    
    if (!reviewDoc.exists) {
      throw new Error("Review not found");
    }
    
    const reviewData = reviewDoc.data();
    
    if (reviewData.studentId !== studentId) {
      throw new Error("Access denied: Can only delete your own reviews");
    }
    
    if (reviewData.isDeleted) {
      return; // Already deleted
    }
    
    await reviewRef.update({
      isDeleted: true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    
    // Recalculate aggregate ratings
    await this.calculateAggregateRatings(reviewData.entityType, reviewData.entityId);
  }

  /**
   * Hard delete a review (studio owner)
   * @param {string} reviewId - Review document ID
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<void>}
   */
  async hardDeleteReview(reviewId, studioOwnerId) {
    const db = getFirestore();
    const reviewRef = db.collection("reviews").doc(reviewId);
    const reviewDoc = await reviewRef.get();
    
    if (!reviewDoc.exists) {
      throw new Error("Review not found");
    }
    
    const reviewData = reviewDoc.data();
    
    // Verify studio owner owns the entity
    const ownsEntity = await this.verifyStudioOwnership(
        reviewData.entityType,
        reviewData.entityId,
        studioOwnerId,
    );
    
    if (!ownsEntity) {
      throw new Error("Access denied: Studio owner does not own this entity");
    }
    
    const entityType = reviewData.entityType;
    const entityId = reviewData.entityId;
    
    // Hard delete the review
    await reviewRef.delete();
    
    // Recalculate aggregate ratings
    await this.calculateAggregateRatings(entityType, entityId);
  }

  /**
   * Verify studio owner owns an entity
   * @param {string} entityType - 'class' | 'instructor' | 'studio'
   * @param {string} entityId - Entity document ID
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<boolean>} True if studio owner owns the entity
   */
  async verifyStudioOwnership(entityType, entityId, studioOwnerId) {
    const db = getFirestore();
    
    if (entityType === "studio") {
      return entityId === studioOwnerId;
    } else if (entityType === "class") {
      const classRef = db.collection("classes").doc(entityId);
      const classDoc = await classRef.get();
      
      if (!classDoc.exists) {
        return false;
      }
      
      const classData = classDoc.data();
      return classData.studioOwnerId === studioOwnerId;
    } else if (entityType === "instructor") {
      const instructorRef = db.collection("instructors").doc(entityId);
      const instructorDoc = await instructorRef.get();
      
      if (!instructorDoc.exists) {
        return false;
      }
      
      const instructorData = instructorDoc.data();
      return instructorData.studioOwnerId === studioOwnerId;
    }
    
    return false;
  }

  /**
   * Add a response to a review (studio owner)
   * @param {string} reviewId - Review document ID
   * @param {string} responseText - Response text
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<void>}
   */
  async addResponse(reviewId, responseText, studioOwnerId) {
    const db = getFirestore();
    const reviewRef = db.collection("reviews").doc(reviewId);
    const reviewDoc = await reviewRef.get();
    
    if (!reviewDoc.exists) {
      throw new Error("Review not found");
    }
    
    const reviewData = reviewDoc.data();
    
    if (reviewData.isDeleted) {
      throw new Error("Cannot respond to deleted review");
    }
    
    // Verify studio owner owns the entity
    const ownsEntity = await this.verifyStudioOwnership(
        reviewData.entityType,
        reviewData.entityId,
        studioOwnerId,
    );
    
    if (!ownsEntity) {
      throw new Error("Access denied: Studio owner does not own this entity");
    }
    
    if (reviewData.response) {
      throw new Error("Response already exists. Use updateResponse to modify it.");
    }
    
    await reviewRef.update({
      response: {
        text: responseText,
        respondedBy: studioOwnerId,
        respondedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  /**
   * Update a response to a review (studio owner)
   * @param {string} reviewId - Review document ID
   * @param {string} responseText - Updated response text
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<void>}
   */
  async updateResponse(reviewId, responseText, studioOwnerId) {
    const db = getFirestore();
    const reviewRef = db.collection("reviews").doc(reviewId);
    const reviewDoc = await reviewRef.get();
    
    if (!reviewDoc.exists) {
      throw new Error("Review not found");
    }
    
    const reviewData = reviewDoc.data();
    
    if (!reviewData.response) {
      throw new Error("No response exists. Use addResponse to create one.");
    }
    
    if (reviewData.response.respondedBy !== studioOwnerId) {
      throw new Error("Access denied: Can only update your own responses");
    }
    
    await reviewRef.update({
      "response.text": responseText,
      "response.respondedAt": admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  /**
   * Delete a response to a review (studio owner)
   * @param {string} reviewId - Review document ID
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<void>}
   */
  async deleteResponse(reviewId, studioOwnerId) {
    const db = getFirestore();
    const reviewRef = db.collection("reviews").doc(reviewId);
    const reviewDoc = await reviewRef.get();
    
    if (!reviewDoc.exists) {
      throw new Error("Review not found");
    }
    
    const reviewData = reviewDoc.data();
    
    if (!reviewData.response) {
      return; // No response to delete
    }
    
    if (reviewData.response.respondedBy !== studioOwnerId) {
      throw new Error("Access denied: Can only delete your own responses");
    }
    
    await reviewRef.update({
      response: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  /**
   * Calculate and update aggregate ratings for an entity
   * @param {string} entityType - 'class' | 'instructor' | 'studio'
   * @param {string} entityId - Entity document ID
   * @returns {Promise<void>}
   */
  async calculateAggregateRatings(entityType, entityId) {
    const db = getFirestore();
    const reviewsRef = db.collection("reviews");
    
    // Get all non-deleted reviews for this entity
    const snapshot = await reviewsRef
        .where("entityType", "==", entityType)
        .where("entityId", "==", entityId)
        .where("isDeleted", "==", false)
        .get();
    
    let totalRating = 0;
    let reviewCount = 0;
    const ratingDistribution = {
      1: 0,
      2: 0,
      3: 0,
      4: 0,
      5: 0,
    };
    
    snapshot.forEach((doc) => {
      const data = doc.data();
      const rating = data.rating;
      
      if (rating >= 1 && rating <= 5) {
        totalRating += rating;
        reviewCount++;
        ratingDistribution[rating] = (ratingDistribution[rating] || 0) + 1;
      }
    });
    
    const averageRating = reviewCount > 0 ? totalRating / reviewCount : 0;
    
    // Determine which collection to update
    let entityRef;
    if (entityType === "studio") {
      entityRef = db.collection("users").doc(entityId);
    } else if (entityType === "class") {
      entityRef = db.collection("classes").doc(entityId);
    } else if (entityType === "instructor") {
      entityRef = db.collection("instructors").doc(entityId);
    } else {
      return; // Unknown entity type
    }
    
    // Update entity with aggregate ratings
    await entityRef.update({
      averageRating: Math.round(averageRating * 10) / 10, // Round to 1 decimal
      totalReviews: reviewCount,
      ratingDistribution: ratingDistribution,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  /**
   * Get aggregate ratings for an entity
   * @param {string} entityType - 'class' | 'instructor' | 'studio'
   * @param {string} entityId - Entity document ID
   * @returns {Promise<Object | null>} Aggregate ratings or null if not found
   */
  async getAggregateRatings(entityType, entityId) {
    const db = getFirestore();
    
    // Determine which collection to query
    let entityRef;
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
    
    if (!doc.exists) {
      return null;
    }
    
    const data = doc.data();
    
    return {
      averageRating: data.averageRating || 0,
      totalReviews: data.totalReviews || 0,
      ratingDistribution: data.ratingDistribution || {
        1: 0,
        2: 0,
        3: 0,
        4: 0,
        5: 0,
      },
    };
  }

  /**
   * Get all reviews for a studio (all entities owned by studio)
   * @param {string} studioOwnerId - Studio owner document ID
   * @param {Object} filters - Filter options
   * @param {string} filters.entityType - Filter by entity type
   * @param {number} filters.rating - Filter by rating
   * @param {boolean} filters.hasResponse - Filter by response status
   * @param {number} filters.limit - Number of reviews to return
   * @returns {Promise<Array>} Array of reviews
   */
  async getReviewsForStudio(studioOwnerId, filters = {}) {
    const db = getFirestore();
    const reviewsRef = db.collection("reviews");
    
    // Build base query using studioOwnerId (much more efficient)
    let query = reviewsRef
        .where("studioOwnerId", "==", studioOwnerId)
        .where("isDeleted", "==", false);
    
    // Apply entity type filter if specified
    if (filters.entityType) {
      query = query.where("entityType", "==", filters.entityType);
    }
    
    // Apply rating filter if specified
    if (filters.rating) {
      query = query.where("rating", "==", filters.rating);
    }
    
    // Order by created date (newest first)
    query = query.orderBy("createdAt", "desc");
    
    // Apply limit
    const limit = filters.limit || 50;
    query = query.limit(limit);
    
    // Execute query
    const snapshot = await query.get();
    
    // Process results
    let allReviews = [];
    snapshot.forEach((doc) => {
      const review = {
        id: doc.id,
        ...doc.data(),
      };
      
      // Apply response filter (client-side since we can't query nested fields easily)
      if (filters.hasResponse !== undefined) {
        const hasResponse = !!review.response;
        if (hasResponse !== filters.hasResponse) {
          return;
        }
      }
      
      allReviews.push(review);
    });
    
    return allReviews;
  }
}

module.exports = new ReviewsService();
