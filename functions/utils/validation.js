/**
 * Validation utilities for input validation
 */

/**
 * Validate email format
 * @param {string} email - Email to validate
 * @returns {boolean}
 */
function isValidEmail(email) {
  if (!email || typeof email !== "string") {
    return false;
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email.trim().toLowerCase());
}

/**
 * Validate password strength
 * @param {string} password - Password to validate
 * @returns {{valid: boolean, message: string}}
 */
function validatePassword(password) {
  if (!password || typeof password !== "string") {
    return {valid: false, message: "Password is required"};
  }

  if (password.length < 8) {
    return {
      valid: false,
      message: "Password must be at least 8 characters long",
    };
  }

  return {valid: true, message: ""};
}

/**
 * Validate required string field
 * @param {string} value - Value to validate
 * @param {string} fieldName - Name of the field for error message
 * @returns {{valid: boolean, message: string}}
 */
function validateRequiredString(value, fieldName) {
  if (!value || typeof value !== "string" || value.trim().length === 0) {
    return {
      valid: false,
      message: `${fieldName} is required`,
    };
  }
  return {valid: true, message: ""};
}

/**
 * Validate state code (2 letters)
 * @param {string} state - State code to validate
 * @returns {{valid: boolean, message: string}}
 */
function validateState(state) {
  if (!state || typeof state !== "string") {
    return {valid: false, message: "State is required"};
  }

  const stateRegex = /^[A-Za-z]{2}$/;
  if (!stateRegex.test(state.trim())) {
    return {
      valid: false,
      message: "State must be a 2-letter code",
    };
  }

  return {valid: true, message: ""};
}

/**
 * Validate ZIP code (5 digits or 5+4 format)
 * @param {string} zip - ZIP code to validate
 * @returns {{valid: boolean, message: string}}
 */
function validateZip(zip) {
  if (!zip || typeof zip !== "string") {
    return {valid: false, message: "ZIP code is required"};
  }

  const zipRegex = /^[0-9]{5}(?:[-\s][0-9]{4})?$/;
  if (!zipRegex.test(zip.trim())) {
    return {
      valid: false,
      message: "ZIP code must be 5 digits or 5+4 format",
    };
  }

  return {valid: true, message: ""};
}

/**
 * Validate URL format (optional field)
 * @param {string} url - URL to validate
 * @returns {{valid: boolean, message: string}}
 */
function validateUrl(url) {
  if (!url || url.trim().length === 0) {
    return {valid: true, message: ""}; // Optional field
  }

  try {
    new URL(url);
    return {valid: true, message: ""};
  } catch (_) {
    return {valid: false, message: "Invalid URL format"};
  }
}

/**
 * Validate membership tier
 * @param {string} membership - Membership tier to validate
 * @returns {{valid: boolean, message: string}}
 */
function validateMembership(membership) {
  const validMemberships = ["basic", "pro", "ultimate"];
  if (!validMemberships.includes(membership)) {
    return {
      valid: false,
      message: `Membership must be one of: ${validMemberships.join(", ")}`,
    };
  }
  return {valid: true, message: ""};
}

/**
 * Validate registration payload
 * @param {Object} payload - Registration data
 * @returns {{valid: boolean, errors: Array<{field: string, message: string}>}}
 */
function validateRegistrationPayload(payload) {
  const errors = [];

  // Email validation
  if (!isValidEmail(payload.email)) {
    errors.push({field: "email", message: "Valid email is required"});
  }

  // Password validation
  const passwordValidation = validatePassword(payload.password);
  if (!passwordValidation.valid) {
    errors.push({field: "password", message: passwordValidation.message});
  }

  // Required string fields
  const requiredFields = [
    "firstName",
    "lastName",
    "studioName",
    "studioAddressLine1",
    "city",
  ];

  requiredFields.forEach((field) => {
    const validation = validateRequiredString(
        payload[field],
        field.charAt(0).toUpperCase() + field.slice(1),
    );
    if (!validation.valid) {
      errors.push({field, message: validation.message});
    }
  });

  // State validation
  const stateValidation = validateState(payload.state);
  if (!stateValidation.valid) {
    errors.push({field: "state", message: stateValidation.message});
  }

  // ZIP validation
  const zipValidation = validateZip(payload.zip);
  if (!zipValidation.valid) {
    errors.push({field: "zip", message: zipValidation.message});
  }

  // Membership validation
  const membershipValidation = validateMembership(payload.membership);
  if (!membershipValidation.valid) {
    errors.push({
      field: "membership",
      message: membershipValidation.message,
    });
  }

  // Optional URL fields
  const urlFields = ["facebook", "instagram", "tiktok", "youtube"];
  urlFields.forEach((field) => {
    if (payload[field]) {
      const urlValidation = validateUrl(payload[field]);
      if (!urlValidation.valid) {
        errors.push({field, message: urlValidation.message});
      }
    }
  });

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate login payload
 * @param {Object} payload - Login data
 * @returns {{valid: boolean, errors: Array<{field: string, message: string}>}}
 */
function validateLoginPayload(payload) {
  const errors = [];

  if (!isValidEmail(payload.email)) {
    errors.push({field: "email", message: "Valid email is required"});
  }

  if (!payload.password || payload.password.trim().length === 0) {
    errors.push({field: "password", message: "Password is required"});
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate time format (HH:mm)
 * @param {string} time - Time string to validate
 * @returns {{valid: boolean, message: string}}
 */
function validateTimeFormat(time) {
  if (!time || typeof time !== "string") {
    return {valid: false, message: "Time is required"};
  }

  const timeRegex = /^([0-1][0-9]|2[0-3]):[0-5][0-9]$/;
  if (!timeRegex.test(time.trim())) {
    return {valid: false, message: "Time must be in HH:mm format (24-hour)"};
  }

  return {valid: true, message: ""};
}

/**
 * Validate class level
 * @param {string} level - Class level to validate
 * @returns {{valid: boolean, message: string}}
 */
function validateClassLevel(level) {
  const validLevels = ["Beginner", "Intermediate", "Advanced", "All Levels"];
  if (!level || !validLevels.includes(level)) {
    return {
      valid: false,
      message: `Level must be one of: ${validLevels.join(", ")}`,
    };
  }
  return {valid: true, message: ""};
}

/**
 * Validate day of week
 * @param {string} dayOfWeek - Day of week to validate
 * @returns {{valid: boolean, message: string}}
 */
function validateDayOfWeek(dayOfWeek) {
  const validDays = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
  ];
  if (!dayOfWeek || !validDays.includes(dayOfWeek)) {
    return {
      valid: false,
      message: `Day of week must be one of: ${validDays.join(", ")}`,
    };
  }
  return {valid: true, message: ""};
}

/**
 * Validate cost
 * @param {number} cost - Cost to validate
 * @returns {{valid: boolean, message: string}}
 */
function validateCost(cost) {
  if (cost === undefined || cost === null) {
    return {valid: false, message: "Cost is required"};
  }

  if (typeof cost !== "number" || isNaN(cost)) {
    return {valid: false, message: "Cost must be a number"};
  }

  if (cost < 0) {
    return {valid: false, message: "Cost must be greater than or equal to 0"};
  }

  return {valid: true, message: ""};
}

/**
 * Validate instructor IDs array
 * @param {Array} instructorIds - Instructor IDs to validate
 * @returns {{valid: boolean, message: string}}
 */
function validateInstructorIds(instructorIds) {
  if (instructorIds === undefined || instructorIds === null) {
    return {valid: false, message: "Instructor IDs are required"};
  }

  if (!Array.isArray(instructorIds)) {
    return {valid: false, message: "Instructor IDs must be an array"};
  }

  // All items should be strings
  if (!instructorIds.every((id) => typeof id === "string" && id.trim().length > 0)) {
    return {valid: false, message: "All instructor IDs must be non-empty strings"};
  }

  return {valid: true, message: ""};
}

/**
 * Validate create class payload
 * @param {Object} payload - Class data
 * @returns {{valid: boolean, errors: Array<{field: string, message: string}>}}
 */
function validateCreateClassPayload(payload) {
  const errors = [];

  // Name validation
  const nameValidation = validateRequiredString(payload.name, "Name");
  if (!nameValidation.valid) {
    errors.push({field: "name", message: nameValidation.message});
  }

  // Level validation
  const levelValidation = validateClassLevel(payload.level);
  if (!levelValidation.valid) {
    errors.push({field: "level", message: levelValidation.message});
  }

  // Cost validation
  const costValidation = validateCost(payload.cost);
  if (!costValidation.valid) {
    errors.push({field: "cost", message: costValidation.message});
  }

  // Day of week validation
  const dayValidation = validateDayOfWeek(payload.dayOfWeek);
  if (!dayValidation.valid) {
    errors.push({field: "dayOfWeek", message: dayValidation.message});
  }

  // Start time validation
  const startTimeValidation = validateTimeFormat(payload.startTime);
  if (!startTimeValidation.valid) {
    errors.push({field: "startTime", message: startTimeValidation.message});
  }

  // End time validation
  const endTimeValidation = validateTimeFormat(payload.endTime);
  if (!endTimeValidation.valid) {
    errors.push({field: "endTime", message: endTimeValidation.message});
  }

  // Instructor IDs validation
  const instructorIdsValidation = validateInstructorIds(payload.instructorIds);
  if (!instructorIdsValidation.valid) {
    errors.push({field: "instructorIds", message: instructorIdsValidation.message});
  }

  // IsActive validation
  if (payload.isActive === undefined || payload.isActive === null) {
    errors.push({field: "isActive", message: "IsActive is required"});
  } else if (typeof payload.isActive !== "boolean") {
    errors.push({field: "isActive", message: "IsActive must be a boolean"});
  }

  // Optional description validation
  if (payload.description !== undefined && payload.description !== null) {
    if (typeof payload.description !== "string") {
      errors.push({field: "description", message: "Description must be a string"});
    }
  }

  // Optional room validation
  if (payload.room !== undefined && payload.room !== null) {
    if (typeof payload.room !== "string") {
      errors.push({field: "room", message: "Room must be a string"});
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate update class payload
 * @param {Object} payload - Class update data
 * @returns {{valid: boolean, errors: Array<{field: string, message: string}>}}
 */
function validateUpdateClassPayload(payload) {
  const errors = [];

  // Name validation (optional for update)
  if (payload.name !== undefined) {
    const nameValidation = validateRequiredString(payload.name, "Name");
    if (!nameValidation.valid) {
      errors.push({field: "name", message: nameValidation.message});
    }
  }

  // Level validation (optional for update)
  if (payload.level !== undefined) {
    const levelValidation = validateClassLevel(payload.level);
    if (!levelValidation.valid) {
      errors.push({field: "level", message: levelValidation.message});
    }
  }

  // Cost validation (optional for update)
  if (payload.cost !== undefined) {
    const costValidation = validateCost(payload.cost);
    if (!costValidation.valid) {
      errors.push({field: "cost", message: costValidation.message});
    }
  }

  // Day of week validation (optional for update)
  if (payload.dayOfWeek !== undefined) {
    const dayValidation = validateDayOfWeek(payload.dayOfWeek);
    if (!dayValidation.valid) {
      errors.push({field: "dayOfWeek", message: dayValidation.message});
    }
  }

  // Start time validation (optional for update)
  if (payload.startTime !== undefined) {
    const startTimeValidation = validateTimeFormat(payload.startTime);
    if (!startTimeValidation.valid) {
      errors.push({field: "startTime", message: startTimeValidation.message});
    }
  }

  // End time validation (optional for update)
  if (payload.endTime !== undefined) {
    const endTimeValidation = validateTimeFormat(payload.endTime);
    if (!endTimeValidation.valid) {
      errors.push({field: "endTime", message: endTimeValidation.message});
    }
  }

  // Instructor IDs validation (optional for update)
  if (payload.instructorIds !== undefined) {
    const instructorIdsValidation = validateInstructorIds(payload.instructorIds);
    if (!instructorIdsValidation.valid) {
      errors.push({field: "instructorIds", message: instructorIdsValidation.message});
    }
  }

  // IsActive validation (optional for update)
  if (payload.isActive !== undefined && payload.isActive !== null) {
    if (typeof payload.isActive !== "boolean") {
      errors.push({field: "isActive", message: "IsActive must be a boolean"});
    }
  }

  // Optional description validation
  if (payload.description !== undefined && payload.description !== null) {
    if (typeof payload.description !== "string") {
      errors.push({field: "description", message: "Description must be a string"});
    }
  }

  // Optional room validation
  if (payload.room !== undefined && payload.room !== null) {
    if (typeof payload.room !== "string") {
      errors.push({field: "room", message: "Room must be a string"});
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate phone number format (optional)
 * @param {string} phone - Phone number to validate
 * @returns {{valid: boolean, message: string}}
 */
function validatePhone(phone) {
  if (!phone || phone.trim().length === 0) {
    return {valid: true, message: ""}; // Optional field
  }

  // Basic phone validation - allows various formats
  const phoneRegex = /^[\d\s\-\(\)\+\.]+$/;
  if (!phoneRegex.test(phone.trim())) {
    return {valid: false, message: "Invalid phone number format"};
  }

  // Remove all non-digits and check length
  const digitsOnly = phone.replace(/\D/g, "");
  if (digitsOnly.length < 10 || digitsOnly.length > 15) {
    return {valid: false, message: "Phone number must be between 10 and 15 digits"};
  }

  return {valid: true, message: ""};
}

/**
 * Validate create instructor payload
 * @param {Object} payload - Instructor data
 * @returns {{valid: boolean, errors: Array<{field: string, message: string}>}}
 */
function validateCreateInstructorPayload(payload) {
  const errors = [];

  // First name validation
  const firstNameValidation = validateRequiredString(payload.firstName, "First name");
  if (!firstNameValidation.valid) {
    errors.push({field: "firstName", message: firstNameValidation.message});
  }

  // Last name validation
  const lastNameValidation = validateRequiredString(payload.lastName, "Last name");
  if (!lastNameValidation.valid) {
    errors.push({field: "lastName", message: lastNameValidation.message});
  }

  // Email validation (optional)
  if (payload.email !== undefined && payload.email !== null && payload.email.trim() !== "") {
    if (!isValidEmail(payload.email)) {
      errors.push({field: "email", message: "Invalid email format"});
    }
  }

  // Phone validation (optional)
  if (payload.phone !== undefined && payload.phone !== null && payload.phone.trim() !== "") {
    const phoneValidation = validatePhone(payload.phone);
    if (!phoneValidation.valid) {
      errors.push({field: "phone", message: phoneValidation.message});
    }
  }

  // Bio validation (optional)
  if (payload.bio !== undefined && payload.bio !== null) {
    if (typeof payload.bio !== "string") {
      errors.push({field: "bio", message: "Bio must be a string"});
    }
  }

  // Photo URL validation (optional, usually set by backend after upload)
  if (payload.photoUrl !== undefined && payload.photoUrl !== null) {
    if (typeof payload.photoUrl !== "string") {
      errors.push({field: "photoUrl", message: "Photo URL must be a string"});
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate update instructor payload
 * @param {Object} payload - Instructor update data
 * @returns {{valid: boolean, errors: Array<{field: string, message: string}>}}
 */
function validateUpdateInstructorPayload(payload) {
  const errors = [];

  // First name validation (optional for update)
  if (payload.firstName !== undefined) {
    const firstNameValidation = validateRequiredString(payload.firstName, "First name");
    if (!firstNameValidation.valid) {
      errors.push({field: "firstName", message: firstNameValidation.message});
    }
  }

  // Last name validation (optional for update)
  if (payload.lastName !== undefined) {
    const lastNameValidation = validateRequiredString(payload.lastName, "Last name");
    if (!lastNameValidation.valid) {
      errors.push({field: "lastName", message: lastNameValidation.message});
    }
  }

  // Email validation (optional for update)
  if (payload.email !== undefined && payload.email !== null && payload.email.trim() !== "") {
    if (!isValidEmail(payload.email)) {
      errors.push({field: "email", message: "Invalid email format"});
    }
  }

  // Phone validation (optional for update)
  if (payload.phone !== undefined && payload.phone !== null && payload.phone.trim() !== "") {
    const phoneValidation = validatePhone(payload.phone);
    if (!phoneValidation.valid) {
      errors.push({field: "phone", message: phoneValidation.message});
    }
  }

  // Bio validation (optional for update)
  if (payload.bio !== undefined && payload.bio !== null) {
    if (typeof payload.bio !== "string") {
      errors.push({field: "bio", message: "Bio must be a string"});
    }
  }

  // Photo URL validation (optional for update)
  if (payload.photoUrl !== undefined && payload.photoUrl !== null) {
    if (typeof payload.photoUrl !== "string") {
      errors.push({field: "photoUrl", message: "Photo URL must be a string"});
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate update profile payload
 * @param {Object} payload - Profile update data
 * @returns {{valid: boolean, errors: Array<{field: string, message: string}>}}
 */
function validateUpdateProfilePayload(payload) {
  const errors = [];

  // First name validation (optional for update)
  if (payload.firstName !== undefined) {
    const firstNameValidation = validateRequiredString(payload.firstName, "First name");
    if (!firstNameValidation.valid) {
      errors.push({field: "firstName", message: firstNameValidation.message});
    }
  }

  // Last name validation (optional for update)
  if (payload.lastName !== undefined) {
    const lastNameValidation = validateRequiredString(payload.lastName, "Last name");
    if (!lastNameValidation.valid) {
      errors.push({field: "lastName", message: lastNameValidation.message});
    }
  }

  // Studio name validation (optional for update)
  if (payload.studioName !== undefined) {
    const studioNameValidation = validateRequiredString(payload.studioName, "Studio name");
    if (!studioNameValidation.valid) {
      errors.push({field: "studioName", message: studioNameValidation.message});
    }
  }

  // Studio address line 1 validation (optional for update)
  if (payload.studioAddressLine1 !== undefined) {
    const addressValidation = validateRequiredString(payload.studioAddressLine1, "Studio address line 1");
    if (!addressValidation.valid) {
      errors.push({field: "studioAddressLine1", message: addressValidation.message});
    }
  }

  // Studio address line 2 validation (optional, can be null or empty)
  if (payload.studioAddressLine2 !== undefined && payload.studioAddressLine2 !== null) {
    if (typeof payload.studioAddressLine2 !== "string") {
      errors.push({field: "studioAddressLine2", message: "Studio address line 2 must be a string"});
    }
  }

  // City validation (optional for update)
  if (payload.city !== undefined) {
    const cityValidation = validateRequiredString(payload.city, "City");
    if (!cityValidation.valid) {
      errors.push({field: "city", message: cityValidation.message});
    }
  }

  // State validation (optional for update)
  if (payload.state !== undefined) {
    const stateValidation = validateState(payload.state);
    if (!stateValidation.valid) {
      errors.push({field: "state", message: stateValidation.message});
    }
  }

  // ZIP validation (optional for update)
  if (payload.zip !== undefined) {
    const zipValidation = validateZip(payload.zip);
    if (!zipValidation.valid) {
      errors.push({field: "zip", message: zipValidation.message});
    }
  }

  // Social media URL validations (all optional)
  if (payload.facebook !== undefined && payload.facebook !== null && payload.facebook.trim() !== "") {
    const facebookValidation = validateUrl(payload.facebook);
    if (!facebookValidation.valid) {
      errors.push({field: "facebook", message: facebookValidation.message});
    }
  }

  if (payload.instagram !== undefined && payload.instagram !== null && payload.instagram.trim() !== "") {
    const instagramValidation = validateUrl(payload.instagram);
    if (!instagramValidation.valid) {
      errors.push({field: "instagram", message: instagramValidation.message});
    }
  }

  if (payload.tiktok !== undefined && payload.tiktok !== null && payload.tiktok.trim() !== "") {
    const tiktokValidation = validateUrl(payload.tiktok);
    if (!tiktokValidation.valid) {
      errors.push({field: "tiktok", message: tiktokValidation.message});
    }
  }

  if (payload.youtube !== undefined && payload.youtube !== null && payload.youtube.trim() !== "") {
    const youtubeValidation = validateUrl(payload.youtube);
    if (!youtubeValidation.valid) {
      errors.push({field: "youtube", message: youtubeValidation.message});
    }
  }

  // Studio image file validation (optional, base64 string)
  if (payload.studioImageFile !== undefined && payload.studioImageFile !== null) {
    if (typeof payload.studioImageFile !== "string") {
      errors.push({field: "studioImageFile", message: "Studio image file must be a base64 string"});
    } else if (!payload.studioImageFile.startsWith("data:image/")) {
      errors.push({field: "studioImageFile", message: "Studio image file must be a valid base64 image data URL"});
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

module.exports = {
  isValidEmail,
  validatePassword,
  validateRequiredString,
  validateState,
  validateZip,
  validateUrl,
  validateMembership,
  validateRegistrationPayload,
  validateLoginPayload,
  validateTimeFormat,
  validateClassLevel,
  validateDayOfWeek,
  validateCost,
  validateInstructorIds,
  validateCreateClassPayload,
  validateUpdateClassPayload,
  validatePhone,
  validateCreateInstructorPayload,
  validateUpdateInstructorPayload,
  validateUpdateProfilePayload,
};


